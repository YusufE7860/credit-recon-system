import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction } from './audit-actions';
import type { Prisma } from '@prisma/client';

export interface AuditRecordInput {
  actorId?: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export interface AuditLogFilters {
  actorId?: string;
  action?: AuditAction | string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private prisma: PrismaService) {}

  // Fire-and-forget recorder. We log errors but never throw — an audit
  // log failure should not break the user-facing request.
  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          metadata: (input.metadata as Prisma.JsonObject | undefined) ?? undefined,
          ipAddress: input.ipAddress ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write audit log [${input.action}]: ${(err as Error).message}`,
      );
    }
  }

  // Admin query — supports basic filtering. Includes actor name/email
  // for direct display in the audit UI.
  async query(filters: AuditLogFilters = {}) {
    return this.prisma.auditLog.findMany({
      where: {
        actorId: filters.actorId,
        action: filters.action,
        entityType: filters.entityType,
        entityId: filters.entityId,
        createdAt:
          filters.from || filters.to
            ? {
                gte: filters.from,
                lte: filters.to,
              }
            : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 200,
      include: {
        actor: { select: { id: true, name: true, email: true, role: true } },
      },
    });
  }
}
