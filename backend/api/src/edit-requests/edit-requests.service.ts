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
  //   - The invoice's owner (userId) may request an edit.
  //   - The uploader (uploaderId) may request an edit — regardless of
  //     role. Previously this was UPLOADER-only, which locked out
  //     assistants who uploaded the receipt on someone else's behalf.
  //   - Admin/Reporting don't need requests; they edit directly.
  async create(input: CreateEditRequestInput, currentUser: JwtUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: input.invoiceId },
    });
    if (!invoice) {
      // True 404 — the id doesn't exist at all.
      this.logger.warn(
        `Edit-request create: invoice ${input.invoiceId} not found in DB (caller ${currentUser.sub})`,
      );
      throw new NotFoundException(`Invoice ${input.invoiceId} not found`);
    }

    // Permission check — the caller must be the owner OR the uploader.
    // Uploader check applies to every role, not just UPLOADER, so an
    // admin-attached invoice with a still-empty owner still lets the
    // uploader raise a request.
    const isOwner =
      invoice.userId != null && invoice.userId === currentUser.sub;
    const isUploader =
      invoice.uploaderId != null && invoice.uploaderId === currentUser.sub;
    if (!isOwner && !isUploader) {
      this.logger.warn(
        `Edit-request create: user ${currentUser.sub} (${currentUser.role}) has no relation to invoice ${invoice.id} ` +
          `(owner=${invoice.userId ?? 'null'}, uploader=${invoice.uploaderId ?? 'null'})`,
      );
      // Return a clearer message than the generic 404 so support can
      // triage without digging through logs. Still 403, not 404 — the
      // caller knows the id (they typed it), and hiding existence
      // doesn't help against an authenticated internal user.
      throw new ForbiddenException(
        `You don't have permission to request edits on this invoice — you're neither the owner nor the uploader.`,
      );
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

  // Admin approves a pending request. `approvedFields` lets the admin
  // pick specific fields to unlock (finer than the historic all-or-
  // nothing bucket unlock). When empty/undefined, the legacy
  // "unlock the whole bucket" behaviour applies for backward compat.
  async approve(
    id: string,
    reviewerId: string,
    reviewNote: string | null,
    approvedFields?: string[],
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

    // Sanitize the admin-approved field list. Only allow well-known
    // field names; drop anything else so a malicious/typo'd payload
    // can't unlock nonsense.
    const ALLOWED_FIELDS =
      request.type === EditRequestType.METADATA
        ? ['category', 'storeAllocation', 'notes']
        : [
            'supplier',
            'invoiceNumber',
            'invoiceDate',
            'total',
            'vat',
            'subtotal',
            'kind',
            'creditApplied',
          ];
    const cleanApprovedFields = (approvedFields ?? []).filter((f) =>
      ALLOWED_FIELDS.includes(f),
    );

    // Pick the unlock field based on the request type. FINANCIAL unlocks
    // OCR-extracted fields; METADATA unlocks category/store/notes.
    const unlockField =
      request.type === EditRequestType.METADATA
        ? { metadataUnlockedUntil: approvedUntil }
        : { editUnlockedUntil: approvedUntil };

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: request.invoiceId },
        data: {
          ...unlockField,
          // Set the specific unlocked fields. Empty array = legacy
          // "any field in the bucket" — the invoice update code
          // preserves that fallback for old flows.
          unlockedFields: cleanApprovedFields,
        },
      });
      return tx.editRequest.update({
        where: { id },
        data: {
          status: EditRequestStatus.APPROVED,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          reviewNote,
          approvedUntil,
          approvedFields: cleanApprovedFields,
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
