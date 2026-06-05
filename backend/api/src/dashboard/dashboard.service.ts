import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReconStatus, Prisma } from '@prisma/client';
import { JwtUser, isPrivileged } from '../auth/role.enum';

export interface DashboardSummary {
  // Echoed back so the frontend can confirm what period the numbers
  // correspond to (handy when the user just changed the date picker).
  range: { from: string; to: string };
  totalTransactions: number;
  totalInvoices: number;
  flaggedTransactions: number;
  unassignedCards: number;
  totalPurchases: number;
  totalRefunds: number;
  netSpend: number;
  totalVat: number;
  // Statement-side total = sum of positive Transaction.amount in range.
  // This is what the BANK says was spent. Only available once the
  // user/admin has uploaded a statement covering the period — until
  // then it'll be 0 with `statementCoverage: 'none'`.
  statementSpend: number;
  // Invoice-side total = sum of Invoice.totalZAR in range (where
  // totalZAR is null, we fall back to Invoice.total — relevant for
  // historical ZAR rows that pre-date multi-currency support).
  invoiceTotal: number;
  // Gap = statementSpend - invoiceTotal. When > 0 the user has spend
  // that hasn't been receipt-attached yet — the actionable number.
  // When < 0 there are more receipts than statement transactions
  // (likely cash receipts or transactions not yet on a statement).
  outstandingReceipts: number;
  // How much of the period the uploaded statements actually cover.
  // 'none' → no statements uploaded yet; 'partial' → some uploaded
  // but the statement period doesn't span the whole [from, to]; 'full'
  // → at least one statement's period brackets the whole window.
  // Frontend uses this to caveat the gap when statements are stale.
  statementCoverage: 'none' | 'partial' | 'full';
  recon: {
    matched: number;
    unmatched: number;
    pending: number;
    disputed: number;
    rejected: number;
    matchedRate: number;
  };
  spendByCategory: Array<{ category: string; total: number; count: number }>;
  spendByMonth: Array<{ month: string; total: number; count: number }>;
  recentTransactions: Array<{
    id: string;
    merchant: string;
    amount: number;
    transactionDate: string;
    cardLast4: string | null;
  }>;
  recentInvoices: Array<{
    id: string;
    supplier: string;
    total: number;
    invoiceDate: string;
    status: ReconStatus;
  }>;
  // When true, the numbers are scoped to the current user only.
  scopedToSelf: boolean;
}

export interface SummaryOptions {
  from?: string; // ISO date — start of period (inclusive)
  to?: string;   // ISO date — end of period (inclusive, end-of-day)
}

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getSummary(
    currentUser: JwtUser,
    options: SummaryOptions = {},
  ): Promise<DashboardSummary> {
    // ---- Resolve the period ----
    // Default = first day of the current month → end of today. Matches
    // the Reports page default and avoids surprising the user with an
    // empty dashboard on first visit.
    const { from, to } = this.resolveRange(options);

    // Build the WHERE fragments used by every transaction/invoice query.
    // Empty userId scope = "no filter" (privileged users see everything).
    const scopedToSelf = !isPrivileged(currentUser.role);
    const txFilter: Prisma.TransactionWhereInput = {
      transactionDate: { gte: from, lte: to },
      ...(scopedToSelf ? { userId: currentUser.sub } : {}),
    };
    // Invoices are dated by invoiceDate (the date on the invoice
    // itself, not when it was uploaded) — matches how the user thinks
    // about "March's spend" regardless of upload lag.
    const invFilter: Prisma.InvoiceWhereInput = {
      invoiceDate: { gte: from, lte: to },
      ...(scopedToSelf ? { userId: currentUser.sub } : {}),
    };

    const [
      txnCount,
      invoiceCount,
      flaggedCount,
      unassignedCards,
      purchaseSum,
      refundSum,
      vatSum,
      // New: separate aggregate for "what the bank says was spent" so
      // we can show it next to the invoice total.
      statementSpendSum,
      // Invoice totals in ZAR for the period (used for the gap).
      // We pull individual rows because Prisma can't `_sum` a fallback
      // (totalZAR ?? total) in one go.
      invoicesForGap,
      byCategory,
      recentTxns,
      recentInvs,
      // Statement coverage check — for the scopedToSelf path we only
      // care about statements the user themselves uploaded. Admins see
      // org-wide statements.
      statementsInRange,
    ] = await Promise.all([
      this.prisma.transaction.count({ where: txFilter }),
      this.prisma.invoice.count({ where: invFilter }),
      this.prisma.transaction.count({
        where: { ...txFilter, flagged: true },
      }),
      // Unassigned-cards alert is only meaningful to admins. For USERs
      // we always report 0 (they don't manage cards).
      scopedToSelf
        ? Promise.resolve(0)
        : this.prisma.card.count({ where: { assignedUserId: null } }),

      this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { ...txFilter, amount: { gt: 0 } },
      }),
      this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { ...txFilter, amount: { lt: 0 } },
      }),
      this.prisma.invoice.aggregate({
        _sum: { vat: true },
        where: invFilter,
      }),
      this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { ...txFilter, amount: { gt: 0 } },
      }),
      this.prisma.invoice.findMany({
        where: invFilter,
        select: { total: true, totalZAR: true },
      }),

      // For the category pie we want the INVOICE's category, not the
      // transaction's (which is null until matched, or "Bank Charges -
      // FNB" for fee rows). Fetch transactions with their matched
      // invoice's category and aggregate in JS — Prisma can't group
      // by a related field directly.
      this.prisma.transaction.findMany({
        where: { ...txFilter, amount: { gt: 0 } },
        select: {
          amount: true,
          category: true,
          // invoices is now an array (a split invoice = N rows pointing
          // at one transaction). For the pie chart we use the first
          // attached invoice's category — fallback to the transaction's
          // own category if none, then "Uncategorized".
          invoices: { select: { category: true }, take: 1 },
        },
      }),

      this.prisma.transaction.findMany({
        take: 5,
        where: txFilter,
        orderBy: { transactionDate: 'desc' },
        select: {
          id: true,
          merchant: true,
          amount: true,
          transactionDate: true,
          cardLast4: true,
        },
      }),
      this.prisma.invoice.findMany({
        take: 5,
        where: invFilter,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          supplier: true,
          total: true,
          invoiceDate: true,
          status: true,
        },
      }),
      // For coverage: which statements overlap [from, to]?
      this.prisma.statement.findMany({
        where: {
          ...(scopedToSelf ? { userId: currentUser.sub } : {}),
          // Statement overlaps the window if its periodStart <= to AND
          // its periodEnd >= from. We accept nulls (older rows without
          // dates) and treat them as "unknown coverage" — they don't
          // contribute to coverage detection.
          AND: [
            { periodStart: { lte: to } },
            { periodEnd: { gte: from } },
          ],
        },
        select: { periodStart: true, periodEnd: true },
      }),
    ]);

    // Invoice total in ZAR — sum (totalZAR ?? total) across the period.
    const invoiceTotal = invoicesForGap.reduce(
      (sum, i) => sum + (i.totalZAR ?? i.total ?? 0),
      0,
    );
    const statementSpend = statementSpendSum._sum.amount ?? 0;
    const outstandingReceipts = statementSpend - invoiceTotal;

    // Statement coverage. 'full' iff at least one statement's range
    // brackets [from, to]; 'partial' iff some statements overlap but
    // none fully cover; 'none' otherwise. Treats null periods as
    // non-covering — we can't claim coverage we can't verify.
    let statementCoverage: 'none' | 'partial' | 'full' = 'none';
    if (statementsInRange.length > 0) {
      const anyFull = statementsInRange.some(
        (s) =>
          s.periodStart != null &&
          s.periodEnd != null &&
          s.periodStart <= from &&
          s.periodEnd >= to,
      );
      statementCoverage = anyFull ? 'full' : 'partial';
    }

    // Recon stats — for non-privileged users we compute scoped counts here.
    // Both branches now apply the date range so the chart on screen
    // and the recon numbers line up with what the user picked.
    const recon = scopedToSelf
      ? await this.computeScopedReconStats(currentUser.sub, from, to)
      : await this.computeOrgReconStatsInRange(from, to);

    // Monthly spend. We keep returning the full history for the trend
    // chart — that's independent of the period filter, the line just
    // gets a marker on the selected window.
    const byMonthRaw = scopedToSelf
      ? await this.prisma.$queryRaw<
          Array<{ month: Date; total: number; count: bigint }>
        >`
          SELECT
            date_trunc('month', "transactionDate") AS month,
            SUM(amount)::float AS total,
            COUNT(*)::bigint AS count
          FROM "Transaction"
          WHERE amount > 0 AND "userId" = ${currentUser.sub}
          GROUP BY month
          ORDER BY month ASC
        `
      : await this.prisma.$queryRaw<
          Array<{ month: Date; total: number; count: bigint }>
        >`
          SELECT
            date_trunc('month', "transactionDate") AS month,
            SUM(amount)::float AS total,
            COUNT(*)::bigint AS count
          FROM "Transaction"
          WHERE amount > 0
          GROUP BY month
          ORDER BY month ASC
        `;

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      totalTransactions: txnCount,
      totalInvoices: invoiceCount,
      flaggedTransactions: flaggedCount,
      unassignedCards,
      totalPurchases: purchaseSum._sum.amount ?? 0,
      totalRefunds: refundSum._sum.amount ?? 0,
      netSpend:
        (purchaseSum._sum.amount ?? 0) + (refundSum._sum.amount ?? 0),
      totalVat: vatSum._sum.vat ?? 0,
      statementSpend,
      invoiceTotal,
      outstandingReceipts,
      statementCoverage,
      recon,
      // Aggregate the transactions-with-invoice-categories in JS.
      // Priority: invoice.category > transaction.category > 'Uncategorized'.
      spendByCategory: (() => {
        const bucket = new Map<string, { total: number; count: number }>();
        for (const t of byCategory as Array<{
          amount: number;
          category: string | null;
          invoices: { category: string | null }[];
        }>) {
          const cat =
            t.invoices[0]?.category ?? t.category ?? 'Uncategorized';
          const existing = bucket.get(cat) ?? { total: 0, count: 0 };
          existing.total += t.amount;
          existing.count += 1;
          bucket.set(cat, existing);
        }
        return Array.from(bucket.entries())
          .map(([category, v]) => ({
            category,
            total: v.total,
            count: v.count,
          }))
          .sort((a, b) => b.total - a.total);
      })(),
      spendByMonth: byMonthRaw.map((row) => ({
        month: row.month.toISOString().slice(0, 7),
        total: row.total,
        count: Number(row.count),
      })),
      recentTransactions: recentTxns.map((t) => ({
        ...t,
        transactionDate: t.transactionDate.toISOString(),
      })),
      recentInvoices: recentInvs.map((i) => ({
        ...i,
        invoiceDate: i.invoiceDate.toISOString(),
      })),
      scopedToSelf,
    };
  }

  // Parse the optional ?from / ?to query params into Date objects.
  // - Missing `from` → first day of current month.
  // - Missing `to`   → end of today.
  // Both anchored to LOCAL time then converted, so a user in JHB picking
  // "2026-05-01" doesn't get an off-by-one because of UTC shift.
  private resolveRange(options: SummaryOptions): { from: Date; to: Date } {
    let from: Date;
    let to: Date;
    if (options.from) {
      from = new Date(options.from);
      from.setHours(0, 0, 0, 0);
    } else {
      const now = new Date();
      from = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    if (options.to) {
      to = new Date(options.to);
      to.setHours(23, 59, 59, 999);
    } else {
      to = new Date();
      to.setHours(23, 59, 59, 999);
    }
    return { from, to };
  }

  // Per-user recon stats, scoped to invoices dated within [from, to].
  // Mirrors ReconciliationService.getStats() but adds the date filter
  // so the dashboard counts line up with the selected period.
  private async computeScopedReconStats(
    userId: string,
    from: Date,
    to: Date,
  ) {
    return this.tallyReconStatuses({
      userId,
      invoiceDate: { gte: from, lte: to },
    });
  }

  // Org-wide recon stats inside a period — used for admin/REPORTING.
  // Kept here (rather than in ReconciliationService) because that
  // service is intentionally all-time; the dashboard wants ranged.
  private async computeOrgReconStatsInRange(from: Date, to: Date) {
    return this.tallyReconStatuses({
      invoiceDate: { gte: from, lte: to },
    });
  }

  // Shared helper: group invoices by status under an arbitrary WHERE.
  private async tallyReconStatuses(where: Prisma.InvoiceWhereInput) {
    const grouped = await this.prisma.invoice.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const stats = {
      matched: 0, unmatched: 0, pending: 0, disputed: 0, rejected: 0,
      matchedRate: 0,
    };
    let total = 0;
    for (const row of grouped) {
      const n = row._count._all;
      total += n;
      switch (row.status) {
        case ReconStatus.MATCHED:   stats.matched = n; break;
        case ReconStatus.UNMATCHED: stats.unmatched = n; break;
        case ReconStatus.PENDING:   stats.pending = n; break;
        case ReconStatus.DISPUTED:  stats.disputed = n; break;
        case ReconStatus.REJECTED:  stats.rejected = n; break;
      }
    }
    stats.matchedRate = total > 0 ? stats.matched / total : 0;
    return stats;
  }
}
