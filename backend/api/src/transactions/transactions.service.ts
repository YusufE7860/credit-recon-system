import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtUser, isPrivileged } from '../auth/role.enum';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification-types';
import { AuditLogService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';

// Subset of user fields we surface alongside cards (when one is assigned).
const USER_PUBLIC_SELECT = {
  id: true,
  name: true,
  email: true,
} as const;

export interface TransactionFilters {
  userId?: string;
}

// Editable fields for admin transaction correction.
// Owner-changes are NOT allowed here — moving a transaction to a different
// user happens via Card.assignToUser, not transaction-level patches.
export interface UpdateTransactionInput {
  merchant?: string;
  amount?: number;
  category?: string | null;
  description?: string | null;
  transactionDate?: string;
  cardLast4?: string | null;
  status?: string;
  flagged?: boolean;
}

// Shape we return for each transaction's cardholder.
// `name` falls back to the PDF-parsed cardholderName when no user is
// assigned to the card yet (common for fresh FNB imports).
export interface TransactionCardholder {
  name: string | null;
  email: string | null;
  last4: string | null;
  assigned: boolean; // true = a real user is assigned to the card
}

@Injectable()
export class TransactionsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private audit: AuditLogService,
  ) {}

  // Admin "nudge" — sends an in-app notification to the transaction's
  // owning user asking them to upload an invoice for an unmatched row.
  // Caller (controller) restricts to ADMIN/REPORTING via @Roles.
  async notifyOwnerAboutUnmatched(
    transactionId: string,
    actor: JwtUser,
  ) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
    });
    if (!tx) {
      throw new NotFoundException(
        `Transaction ${transactionId} not found`,
      );
    }
    if (tx.matched) {
      throw new BadRequestException(
        'Transaction is already matched — nothing to chase.',
      );
    }

    const formattedDate = tx.transactionDate.toLocaleDateString('en-ZA');
    const amount = `R ${tx.amount.toFixed(2)}`;
    const merchant = tx.merchant || '(unknown merchant)';

    await this.notifications.create({
      userId: tx.userId,
      type: NotificationType.INVOICE_REQUESTED,
      title: 'Invoice needed',
      body: `Please upload an invoice for ${merchant} — ${amount} on ${formattedDate}.`,
      link: '/upload',
    });

    await this.audit.record({
      actorId: actor.sub,
      action: AuditAction.INVOICE_REQUESTED,
      entityType: 'Transaction',
      entityId: tx.id,
      metadata: {
        notifiedUserId: tx.userId,
        merchant,
        amount: tx.amount,
        transactionDate: tx.transactionDate,
      },
    });

    return { success: true, notifiedUserId: tx.userId };
  }

  async createTransaction(data: any) {
    return this.prisma.transaction.create({ data });
  }

  async getTransactions(currentUser: JwtUser, filters: TransactionFilters = {}) {
    const effectiveUserId = isPrivileged(currentUser.role)
      ? filters.userId
      : currentUser.sub;

    const transactions = await this.prisma.transaction.findMany({
      where: effectiveUserId ? { userId: effectiveUserId } : undefined,
      orderBy: { transactionDate: 'desc' },
    });

    // Look up the cards once for all unique last4s, then merge in memory.
    // cardLast4 isn't a real FK (it's a String field) so we can't include()
    // the card relation directly in Prisma.
    const cards = await this.loadCardsForTransactions(transactions);

    return transactions.map((t) => ({
      ...t,
      cardholder: this.buildCardholder(t.cardLast4, cards),
    }));
  }

  async getTransactionById(id: string, currentUser: JwtUser) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id },
    });
    if (!tx) throw new NotFoundException(`Transaction ${id} not found`);

    if (!isPrivileged(currentUser.role) && tx.userId !== currentUser.sub) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    const cards = await this.loadCardsForTransactions([tx]);
    return {
      ...tx,
      cardholder: this.buildCardholder(tx.cardLast4, cards),
    };
  }

  async deleteTransaction(id: string) {
    return this.prisma.transaction.delete({ where: { id } });
  }

  // Admin-only edit. Called from the controller — guards happen there.
  // We DON'T allow changing userId here on purpose; routing a transaction
  // to a different user is a Card concern (re-assign the card), not a
  // per-transaction one.
  //
  // Amount is LOCKED for everyone, including admin. Bank statements are
  // the source of truth for amounts and we don't let anyone "correct"
  // them through the UI — if a row is wrong, the statement upload was
  // wrong; delete + re-upload is the workflow.
  async updateTransaction(id: string, input: UpdateTransactionInput) {
    // Verify existence first so we throw a clean 404.
    const existing = await this.prisma.transaction.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Transaction ${id} not found`);

    if (input.amount !== undefined) {
      throw new BadRequestException(
        'Transaction amounts cannot be edited. They must match the bank statement. If the value is wrong, delete the statement and re-upload it.',
      );
    }

    return this.prisma.transaction.update({
      where: { id },
      data: {
        merchant: input.merchant,
        // amount intentionally NOT writable — rejected above.
        category: input.category,
        description: input.description,
        transactionDate: input.transactionDate
          ? new Date(input.transactionDate)
          : undefined,
        cardLast4: input.cardLast4,
        status: input.status,
        flagged: input.flagged,
      },
    });
  }

  // ---------- Internals ----------

  // Fetch all cards referenced by this batch of transactions in one query,
  // returning a map keyed by last4 for cheap lookups.
  private async loadCardsForTransactions(
    transactions: Array<{ cardLast4: string | null }>,
  ): Promise<Map<string, CardWithUser>> {
    const last4s = Array.from(
      new Set(
        transactions
          .map((t) => t.cardLast4)
          .filter((l): l is string => l != null),
      ),
    );
    if (last4s.length === 0) return new Map();

    const cards = await this.prisma.card.findMany({
      where: { last4: { in: last4s } },
    });

    // Collect the assigned-user ids and load them in one go.
    const userIds = cards
      .map((c) => c.assignedUserId)
      .filter((id): id is string => id != null);
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: USER_PUBLIC_SELECT,
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const map = new Map<string, CardWithUser>();
    for (const c of cards) {
      map.set(c.last4 ?? '', {
        ...c,
        assignedUser: c.assignedUserId
          ? userById.get(c.assignedUserId) ?? null
          : null,
      });
    }
    return map;
  }

  private buildCardholder(
    cardLast4: string | null,
    cards: Map<string, CardWithUser>,
  ): TransactionCardholder {
    if (!cardLast4) {
      return { name: null, email: null, last4: null, assigned: false };
    }
    const card = cards.get(cardLast4);
    if (!card) {
      // Card was deleted but transactions still reference its last4.
      return { name: null, email: null, last4: cardLast4, assigned: false };
    }
    return {
      // Prefer the assigned user's real name; fall back to the
      // PDF-parsed cardholderName for not-yet-assigned cards.
      name: card.assignedUser?.name ?? card.cardholderName ?? null,
      email: card.assignedUser?.email ?? null,
      last4: card.last4,
      assigned: card.assignedUser != null,
    };
  }
}

// Helper type so we don't sprinkle Prisma model types around.
type CardWithUser = {
  id: string;
  last4: string | null;
  cardholderName: string | null;
  assignedUserId: string | null;
  assignedUser: {
    id: string;
    name: string;
    email: string;
  } | null;
};
