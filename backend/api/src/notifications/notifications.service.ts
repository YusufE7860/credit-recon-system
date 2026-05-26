import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from './notification-types';
import { Role } from '../auth/role.enum';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
}

export interface CreateForRolesInput {
  roles: Role[];
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  excludeUserId?: string; // skip a specific user (e.g. don't notify the actor)
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

  async create(input: CreateNotificationInput) {
    return this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
      },
    });
  }

  // Fan-out create: every active user in the given roles gets a copy.
  // Used when a new edit request arrives and we want to ping all ADMINs.
  async createForRoles(input: CreateForRolesInput) {
    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        role: { in: input.roles },
        id: input.excludeUserId ? { not: input.excludeUserId } : undefined,
      },
      select: { id: true },
    });

    if (users.length === 0) return { count: 0 };

    const result = await this.prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
      })),
    });

    this.logger.log(
      `Notification fanout [${input.type}] → ${result.count} user(s)`,
    );
    return result;
  }

  async list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    return this.prisma.notification.findMany({
      where: {
        userId,
        read: opts.unreadOnly ? false : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
    });
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, read: false },
    });
  }

  // Mark a single notification read. Owner check baked in — users can't
  // mark someone else's notifications read.
  async markRead(id: string, userId: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n || n.userId !== userId) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    return this.prisma.notification.update({
      where: { id },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }
}
