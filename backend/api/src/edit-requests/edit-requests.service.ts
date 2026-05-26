import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtUser, isPrivileged, Role } from '../auth/role.enum';
import { EditRequestStatus, EditRequestType } from '@prisma/client';
import { SettingsService, SETTING_KEYS } from '../settings/settings.service';
import { AuditLogService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification-types';

// Default if no Setting row exists.
const DEFAULT_UNLOCK_HOURS = 24;

export interface CreateEditRequestInput {
  invoiceId: string;
  reason: string;
  fieldsToEdit?: string;
  // Defaults to FINANCIAL when omitted, matching the old behaviour.
  // METADATA requests unlock category/storeAllocation/notes instead of
  // the OCR-extracted financial fields.
  type?: EditRequestType;
}

@Injectable()
export class EditRequestsService {
  private readonly logger = new Logger(EditRequestsService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private audit: AuditLogService,
    private notifications: NotificationsService,
  ) {}

  // USER (or UPLOADER) creates a request to edit a sealed invoice.
  //   - USER may request on invoices they own.
  //   - UPLOADER may request on invoices they uploaded.
  //   - Admin/Reporting don't need requests; they edit directly.
  async create(input: CreateEditRequestInput, currentUser: JwtUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: input.invoiceId },
    });
    if (!invoice) {
      throw new NotFoundException(`Invoice ${input.invoiceId} not found`);
    }

    // Permission check — owner OR uploader (for UPLOADER role).
    const isOwner = invoice.userId === currentUser.sub;
    const isUploaderOfThis =
      currentUser.role === Role.UPLOADER &&
      invoice.uploaderId === currentUser.sub;
    if (!isOwner && !isUploaderOfThis) {
      // Don't leak existence — same 404 we'd return for a missing invoice.
      throw new NotFoundException(`Invoice ${input.invoiceId} not found`);
    }

    const type = input.type ?? EditRequestType.FINANCIAL;

    // Financial edits skip the request flow when the invoice is already
    // flagged for review (OCR marked it editable). Metadata edits don't
    // have that shortcut — they always require a request once locked.
    if (type === EditRequestType.FINANCIAL && invoice.requiresReview) {
      throw new BadRequestException(
        'Invoice is already flagged for review — you can edit it directly without a request.',
      );
    }

    // Check the appropriate unlock window isn't already open.
    const activeUnlock =
      type === EditRequestType.FINANCIAL
        ? invoice.editUnlockedUntil
        : invoice.metadataUnlockedUntil;
    if (activeUnlock && activeUnlock > new Date()) {
      throw new BadRequestException(
        `A ${type.toLowerCase()} edit unlock is already active for this invoice.`,
      );
    }

    // Prevent a pile-up of pending requests of the SAME type. The owner
    // can still have one FINANCIAL and one METADATA pending side by side.
    const existingPending = await this.prisma.editRequest.findFirst({
      where: {
        invoiceId: invoice.id,
        status: EditRequestStatus.PENDING,
        type,
      },
    });
    if (existingPending) {
      throw new BadRequestException(
        `You already have a pending ${type.toLowerCase()} edit request for this invoice.`,
      );
    }

    const created = await this.prisma.editRequest.create({
      data: {
        invoiceId: invoice.id,
        requestedById: currentUser.sub,
        reason: input.reason.trim(),
        fieldsToEdit: input.fieldsToEdit ?? null,
        type,
        status: EditRequestStatus.PENDING,
      },
    });

    // Audit trail.
    await this.audit.record({
      actorId: currentUser.sub,
      action: AuditAction.EDIT_REQUEST_CREATED,
      entityType: 'EditRequest',
      entityId: created.id,
      metadata: { invoiceId: invoice.id, reason: input.reason, type },
    });

    // Notify every admin so they can review the request.
    // Exclude the requester in case they're themselves an admin.
    await this.notifications.createForRoles({
      roles: [Role.ADMIN],
      type: NotificationType.EDIT_REQUEST_CREATED,
      title: `New ${type === EditRequestType.METADATA ? 'metadata' : 'invoice'} edit request`,
      body: `${currentUser.email} requested to edit "${invoice.supplier}".`,
      link: `/admin/edit-requests`,
      excludeUserId: currentUser.sub,
    });

    return created;
  }

  // List requests visible to the caller:
  //   USER  → only their own
  //   ADMIN → everything (used by the admin queue page)
  async list(currentUser: JwtUser, status?: EditRequestStatus) {
    return this.prisma.editRequest.findMany({
      where: {
        status,
        requestedById: isPrivileged(currentUser.role)
          ? undefined
          : currentUser.sub,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        invoice: {
          select: {
            id: true,
            supplier: true,
            total: true,
            invoiceDate: true,
          },
        },
        requestedBy: {
          select: { id: true, name: true, email: true },
        },
        reviewedBy: {
          select: { id: true, name: true, email: true },
        },
      },
    });
  }

  // Admin approves a pending request.
  async approve(
    id: string,
    reviewerId: string,
    reviewNote: string | null,
  ) {
    const request = await this.prisma.editRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException(`Edit request ${id} not found`);
    if (request.status !== EditRequestStatus.PENDING) {
      throw new BadRequestException(
        `Request is already ${request.status}.`,
      );
    }

    const hours = this.settings.getNumber(
      SETTING_KEYS.EDIT_UNLOCK_HOURS,
      DEFAULT_UNLOCK_HOURS,
    );
    const approvedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);

    // Pick the unlock field based on the request type. FINANCIAL unlocks
    // OCR-extracted fields; METADATA unlocks category/store/notes.
    const unlockField =
      request.type === EditRequestType.METADATA
        ? { metadataUnlockedUntil: approvedUntil }
        : { editUnlockedUntil: approvedUntil };

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: request.invoiceId },
        data: unlockField,
      });
      return tx.editRequest.update({
        where: { id },
        data: {
          status: EditRequestStatus.APPROVED,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          reviewNote,
          approvedUntil,
        },
      });
    });

    // Audit + notify requester.
    await this.audit.record({
      actorId: reviewerId,
      action: AuditAction.EDIT_REQUEST_APPROVED,
      entityType: 'EditRequest',
      entityId: id,
      metadata: {
        invoiceId: request.invoiceId,
        approvedUntil,
        type: request.type,
      },
    });
    await this.notifications.create({
      userId: request.requestedById,
      type: NotificationType.EDIT_REQUEST_APPROVED,
      title: `${request.type === EditRequestType.METADATA ? 'Metadata' : 'Financial'} edit request approved`,
      body: `Your edit request was approved. You have until ${approvedUntil.toLocaleString()} to make changes.`,
      link: `/invoices/${request.invoiceId}`,
    });

    return result;
  }

  // Admin rejects a pending request.
  async reject(
    id: string,
    reviewerId: string,
    reviewNote: string | null,
  ) {
    const request = await this.prisma.editRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException(`Edit request ${id} not found`);
    if (request.status !== EditRequestStatus.PENDING) {
      throw new BadRequestException(`Request is already ${request.status}.`);
    }
    const result = await this.prisma.editRequest.update({
      where: { id },
      data: {
        status: EditRequestStatus.REJECTED,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reviewNote,
      },
    });

    await this.audit.record({
      actorId: reviewerId,
      action: AuditAction.EDIT_REQUEST_REJECTED,
      entityType: 'EditRequest',
      entityId: id,
      metadata: { invoiceId: request.invoiceId, reviewNote },
    });
    await this.notifications.create({
      userId: request.requestedById,
      type: NotificationType.EDIT_REQUEST_REJECTED,
      title: 'Edit request rejected',
      body: reviewNote
        ? `Your edit request was rejected: ${reviewNote}`
        : 'Your edit request was rejected.',
      link: `/invoices/${request.invoiceId}`,
    });

    return result;
  }

  // Background helper — sweeps approved requests whose unlock window
  // has passed and marks them EXPIRED. Can be called from a scheduled
  // job later; for now call it from list() so the data is fresh.
  async sweepExpired() {
    const now = new Date();
    const result = await this.prisma.editRequest.updateMany({
      where: {
        status: EditRequestStatus.APPROVED,
        approvedUntil: { lt: now },
      },
      data: { status: EditRequestStatus.EXPIRED },
    });
    if (result.count > 0) {
      // Also clear invoice unlocks that are stale — both kinds.
      await this.prisma.invoice.updateMany({
        where: { editUnlockedUntil: { lt: now } },
        data: { editUnlockedUntil: null },
      });
      await this.prisma.invoice.updateMany({
        where: { metadataUnlockedUntil: { lt: now } },
        data: { metadataUnlockedUntil: null },
      });
      this.logger.log(`Swept ${result.count} expired edit requests`);
    }
    return result.count;
  }
}
