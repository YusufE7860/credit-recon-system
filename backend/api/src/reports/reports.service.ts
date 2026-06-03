import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ReportRange {
  from: Date;
  to: Date;
}

export interface ReportSummary {
  totalSpend: number;       // sum of positive transactions
  totalRefunds: number;     // sum of negative transactions (signed)
  netSpend: number;         // totalSpend + totalRefunds
  transactionCount: number;
  invoiceCount: number;
  vatTotal: number;
  matchedInvoices: number;
  unmatchedInvoices: number;
  matchedRate: number;      // 0..1
}

export interface ReportCategoryRow {
  category: string;
  total: number;
  count: number;
}

export interface ReportCardholderRow {
  cardLast4: string;
  cardholderName: string | null;
  assignedUserName: string | null;
  // Exposed so the Reports page can trigger a per-user XLSX export
  // directly from this row. Null when the card isn't assigned.
  assignedUserId: string | null;
  total: number;
  count: number;
}

export interface ReportUnmatchedRow {
  id: string;
  transactionDate: string;
  merchant: string;
  amount: number;
  cardLast4: string | null;
  cardholderName: string | null;
}

export interface ReportData {
  range: { from: string; to: string };
  summary: ReportSummary;
  byCategory: ReportCategoryRow[];
  byCardholder: ReportCardholderRow[];
  unmatched: ReportUnmatchedRow[];
}

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  // The whole report in one shot. Frontend picks which tab to show.
  // Org-wide — RBAC is enforced at the controller level.
  async generate(range: ReportRange): Promise<ReportData> {
    if (range.from > range.to) {
      throw new BadRequestException('from must be on or before to');
    }

    // Inclusive of `to` end-of-day so the user doesn't have to think
    // about hours. e.g. "to = 2024-03-31" means "up to and including 23:59:59".
    const toInclusive = new Date(range.to);
    toInclusive.setHours(23, 59, 59, 999);

    const txnWhere = {
      transactionDate: { gte: range.from, lte: toInclusive },
    };
    const invWhere = {
      invoiceDate: { gte: range.from, lte: toInclusive },
    };

    // Run the cheap aggregates in parallel.
    const [
      txnCount,
      invCount,
      purchaseSum,
      refundSum,
      vatSum,
      byCategoryRaw,
      matchedCount,
      unmatchedCount,
      pendingCount,
      unmatchedTxnsRaw,
      cardholderRollup,
    ] = await Promise.all([
      this.prisma.transaction.count({ where: txnWhere }),
      this.prisma.invoice.count({ where: invWhere }),
      this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { ...txnWhere, amount: { gt: 0 } },
      }),
      this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { ...txnWhere, amount: { lt: 0 } },
      }),
      this.prisma.invoice.aggregate({
        _sum: { vat: true },
        where: invWhere,
      }),
      this.prisma.transaction.groupBy({
        by: ['category'],
        _sum: { amount: true },
        _count: { _all: true },
        where: { ...txnWhere, amount: { gt: 0 } },
      }),
      this.prisma.invoice.count({
        where: { ...invWhere, status: 'MATCHED' },
      }),
      this.prisma.invoice.count({
        where: { ...invWhere, status: 'UNMATCHED' },
      }),
      this.prisma.invoice.count({
        where: { ...invWhere, status: 'PENDING' },
      }),
      // Unmatched audit list — pull the actual transactions.
      // Limit to 500 to keep responses sane; UI can warn if hit.
      this.prisma.transaction.findMany({
        take: 500,
        where: {
          ...txnWhere,
          matched: false,
          amount: { gt: 0 }, // exclude refunds from the audit list
          // Bank-side fees don't need a matching invoice — they're
          // auto-handled at import time. Don't surface them here as
          // "unmatched needing attention".
          noMatchRequired: false,
        },
        orderBy: { transactionDate: 'desc' },
        select: {
          id: true,
          transactionDate: true,
          merchant: true,
          amount: true,
          cardLast4: true,
        },
      }),
      // Cardholder rollup: sum by cardLast4.
      this.prisma.transaction.groupBy({
        by: ['cardLast4'],
        _sum: { amount: true },
        _count: { _all: true },
        where: { ...txnWhere, amount: { gt: 0 } },
      }),
    ]);

    const totalSpend = purchaseSum._sum.amount ?? 0;
    const totalRefunds = refundSum._sum.amount ?? 0;
    const totalInvoicesInRange = matchedCount + unmatchedCount + pendingCount;

    // Resolve cardholder names for the unmatched list + rollup in one pass.
    const cardLast4s = Array.from(
      new Set([
        ...unmatchedTxnsRaw.map((t) => t.cardLast4).filter(Boolean),
        ...cardholderRollup.map((c) => c.cardLast4).filter(Boolean),
      ] as string[]),
    );

    const cards = cardLast4s.length
      ? await this.prisma.card.findMany({
          where: { last4: { in: cardLast4s } },
        })
      : [];

    const userIds = cards
      .map((c) => c.assignedUserId)
      .filter((id): id is string => id != null);
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const cardByLast4 = new Map(cards.map((c) => [c.last4 ?? '', c]));

    function cardholderFor(last4: string | null): {
      name: string | null;
      assignedUserName: string | null;
      assignedUserId: string | null;
    } {
      if (!last4) {
        return { name: null, assignedUserName: null, assignedUserId: null };
      }
      const card = cardByLast4.get(last4);
      if (!card) {
        return { name: null, assignedUserName: null, assignedUserId: null };
      }
      const user = card.assignedUserId
        ? userById.get(card.assignedUserId)
        : null;
      return {
        name: card.cardholderName ?? null,
        assignedUserName: user?.name ?? null,
        assignedUserId: card.assignedUserId ?? null,
      };
    }

    return {
      range: {
        from: range.from.toISOString(),
        to: toInclusive.toISOString(),
      },
      summary: {
        totalSpend,
        totalRefunds,
        netSpend: totalSpend + totalRefunds,
        transactionCount: txnCount,
        invoiceCount: invCount,
        vatTotal: vatSum._sum.vat ?? 0,
        matchedInvoices: matchedCount,
        unmatchedInvoices: unmatchedCount,
        matchedRate:
          totalInvoicesInRange > 0
            ? matchedCount / totalInvoicesInRange
            : 0,
      },
      byCategory: byCategoryRaw
        .map((r) => ({
          category: r.category ?? 'Uncategorized',
          total: r._sum.amount ?? 0,
          count: r._count._all,
        }))
        .sort((a, b) => b.total - a.total),
      byCardholder: cardholderRollup
        .filter((r) => r.cardLast4)
        .map((r) => {
          const c = cardholderFor(r.cardLast4);
          return {
            cardLast4: r.cardLast4 as string,
            cardholderName: c.name,
            assignedUserName: c.assignedUserName,
            assignedUserId: c.assignedUserId,
            total: r._sum.amount ?? 0,
            count: r._count._all,
          };
        })
        .sort((a, b) => b.total - a.total),
      unmatched: unmatchedTxnsRaw.map((t) => {
        const c = cardholderFor(t.cardLast4);
        return {
          id: t.id,
          transactionDate: t.transactionDate.toISOString(),
          merchant: t.merchant,
          amount: t.amount,
          cardLast4: t.cardLast4,
          cardholderName: c.assignedUserName ?? c.name ?? null,
        };
      }),
    };
  }
}
