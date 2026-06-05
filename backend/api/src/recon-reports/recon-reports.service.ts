import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtUser, isPrivileged } from '../auth/role.enum';

// Shape of one transaction row in the saved snapshot.
// Stored as JSON on ReconReport.rows. Plain serializable types only.
export interface SnapshotTxnRow {
  no: number;
  transactionId: string;
  date: string;          // ISO date string
  merchant: string;
  location: string | null;
  amount: number;
  // Bank/transaction category (e.g. "Bank Fee") — pre-recon classification.
  category: string | null;
  description: string | null;
  // The "Reason / Where & Why" the uploader typed for the matched
  // invoice. Comes from invoice.notes. Null for unmatched transactions.
  // Used as the FULL DESCRIPTION column on the recon XLSX.
  userNotes: string | null;
  // Voucher Attached Y/N — comes from transaction.matched
  hasVoucher: boolean;
  // If matched, surface the matched invoice's supplier + total
  matchedInvoice: {
    id: string;
    supplier: string;
    total: number;
    currency: string;
  } | null;
  // FFG accounting columns — populated from the matched invoice when present.
  // For unmatched transactions these stay null (signals "missing voucher").
  account: string | null;       // = invoice.category (the official expense category)
  department: string | null;    // = invoice.storeAllocation
  cardholderName: string | null; // derived from the card section the row lives in
}

// Per-card section within a snapshot.
export interface SnapshotCardSection {
  cardLast4: string;
  maskedNumber: string | null;
  cardholderName: string | null;
  balanceBroughtForward: number; // always 0 for now — placeholder for future
  balanceTransferred: number;     // computed sum of section
  rows: SnapshotTxnRow[];
}

// Full snapshot stored on ReconReport.rows.
export interface SnapshotData {
  statementTitle: string;        // for the XLSX header
  periodStart: string;
  periodEnd: string;
  user: { id: string; name: string };
  cards: SnapshotCardSection[];
}

// ---------- Build helpers ----------

const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

// Build the report name per the user's requirement:
// CHName/MONTH/YEAR — e.g. "Mahalingam Chinasamy/APRIL/2026".
// Uses the START of the period for naming.
export function buildReportName(
  cardholderName: string,
  periodStart: Date,
): string {
  const month = MONTH_NAMES[periodStart.getMonth()];
  const year = periodStart.getFullYear();
  return `${cardholderName}/${month}/${year}`;
}

// ---------- Service ----------

@Injectable()
export class ReconReportsService {
  private readonly logger = new Logger(ReconReportsService.name);

  constructor(private prisma: PrismaService) {}

  // After a recon run completes, the recon service calls this to
  // persist a snapshot per affected user. One ReconReport row per
  // (user, period). Existing reports for the same (user, period)
  // are overwritten — re-running recon for April updates April's report.
  async generateSnapshotsForRun(
    periodStart: Date,
    periodEnd: Date,
    runBy: JwtUser,
    scopedUserId: string | null,
  ): Promise<{ created: number; users: number }> {
    // Decide whose transactions/invoices we look at.
    //   USER run → just themselves
    //   ADMIN/REPORTING run → every user who has activity in the period
    const txWhere: any = {
      transactionDate: { gte: periodStart, lte: this.endOfDay(periodEnd) },
    };
    if (scopedUserId) txWhere.userId = scopedUserId;

    const transactions = await this.prisma.transaction.findMany({
      where: txWhere,
      // invoices is now an array — N invoices can stack onto one txn
      // when split across receipts (two Takealot orders → one swipe).
      // We sort by createdAt so the "primary" invoice is the first one
      // attached, which matches the manual-match order in the UI.
      include: {
        invoices: {
          include: { splits: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { transactionDate: 'asc' },
    });

    if (transactions.length === 0) {
      this.logger.log('No transactions in period — skipping snapshot generation');
      return { created: 0, users: 0 };
    }

    // Group transactions by userId.
    const byUser = new Map<string, typeof transactions>();
    for (const t of transactions) {
      const list = byUser.get(t.userId) ?? [];
      list.push(t);
      byUser.set(t.userId, list);
    }

    // Resolve users + cards for the IDs we touched.
    const userIds = Array.from(byUser.keys());
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    const allLast4s = Array.from(
      new Set(transactions.map((t) => t.cardLast4).filter(Boolean) as string[]),
    );
    const cards = await this.prisma.card.findMany({
      where: { last4: { in: allLast4s } },
    });
    const cardByLast4 = new Map(cards.map((c) => [c.last4 ?? '', c]));

    // Build + persist one snapshot per user.
    let created = 0;
    for (const [userId, txns] of byUser) {
      const user = userById.get(userId);
      if (!user) continue;

      const snapshot = this.buildSnapshot(
        user,
        txns,
        cardByLast4,
        periodStart,
        periodEnd,
      );

      // Naming: cardholder name from their first card, fallback to user.name.
      const firstCard = snapshot.cards[0];
      const nameForReport =
        firstCard?.cardholderName ?? user.name;
      const reportName = buildReportName(nameForReport, periodStart);

      // Stats for the list view.
      let totalSpend = 0;
      let matchedCount = 0;
      let unmatchedCount = 0;
      for (const section of snapshot.cards) {
        for (const row of section.rows) {
          if (row.amount > 0) totalSpend += row.amount;
          if (row.hasVoucher) matchedCount++;
          else unmatchedCount++;
        }
      }

      // Upsert: re-running for the same period overwrites.
      // We don't have a unique constraint on (userId, periodStart) so
      // we delete-and-create for simplicity.
      await this.prisma.$transaction(async (tx) => {
        await tx.reconReport.deleteMany({
          where: {
            userId,
            periodStart,
            periodEnd: this.endOfDay(periodEnd),
          },
        });
        await tx.reconReport.create({
          data: {
            name: reportName,
            periodStart,
            periodEnd: this.endOfDay(periodEnd),
            userId,
            runById: runBy.sub,
            runByName: runBy.email, // approximate; controller can override
            rows: snapshot as any,
            totalSpend,
            matchedCount,
            unmatchedCount,
            cardCount: snapshot.cards.length,
          },
        });
      });
      created++;
    }

    this.logger.log(
      `Generated ${created} recon snapshot${created === 1 ? '' : 's'}`,
    );
    return { created, users: created };
  }

  // List reports visible to the caller.
  async list(currentUser: JwtUser) {
    return this.prisma.reconReport.findMany({
      where: isPrivileged(currentUser.role)
        ? undefined
        : { userId: currentUser.sub },
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        periodStart: true,
        periodEnd: true,
        userId: true,
        runByName: true,
        totalSpend: true,
        matchedCount: true,
        unmatchedCount: true,
        cardCount: true,
        createdAt: true,
      },
    });
  }

  // Load one full report (rows JSON included). Access-gated.
  async getById(id: string, currentUser: JwtUser) {
    const report = await this.prisma.reconReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException(`Report ${id} not found`);
    if (
      !isPrivileged(currentUser.role) &&
      report.userId !== currentUser.sub
    ) {
      throw new NotFoundException(`Report ${id} not found`);
    }
    return report;
  }

  // Admin-only: build (and persist) snapshots for a given period or
  // statement, then hand the in-memory SnapshotData[] back to the
  // controller so it can stream a single XLSX (combined or per-user).
  //
  // - source='statement': period comes from the chosen Statement's
  //   periodStart/periodEnd (auto-detected at upload time).
  // - source='range': caller supplies explicit from/to.
  // - userId set narrows to that user; null = every user with activity
  //   in the period.
  async generateAdminRecon(opts: {
    source: 'statement' | 'range';
    statementId?: string;
    from?: Date;
    to?: Date;
    userId?: string | null;
    currentUser: JwtUser;
  }): Promise<{
    snapshots: SnapshotData[];
    periodStart: Date;
    periodEnd: Date;
    workbookTitle: string;
  }> {
    let periodStart: Date;
    let periodEnd: Date;
    let titleHint = '';

    // ---- Resolve the period ----
    if (opts.source === 'statement') {
      if (!opts.statementId) {
        throw new NotFoundException('statementId is required when source=statement');
      }
      const stmt = await this.prisma.statement.findUnique({
        where: { id: opts.statementId },
        select: {
          id: true, statementName: true,
          periodStart: true, periodEnd: true,
        },
      });
      if (!stmt) {
        throw new NotFoundException(`Statement ${opts.statementId} not found`);
      }
      if (!stmt.periodStart || !stmt.periodEnd) {
        throw new NotFoundException(
          'Selected statement has no period — re-upload or pick a date range instead.',
        );
      }
      periodStart = stmt.periodStart;
      periodEnd = stmt.periodEnd;
      titleHint = stmt.statementName;
    } else {
      if (!opts.from || !opts.to) {
        throw new NotFoundException('from and to are required when source=range');
      }
      periodStart = opts.from;
      periodEnd = opts.to;
      titleHint = `${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`;
    }

    // ---- Build (and persist) per-user snapshots ----
    // Re-uses generateSnapshotsForRun so a single set of "current state"
    // ReconReport rows always exists per (user, period) — the admin can
    // come back later and download via the existing per-user buttons too.
    await this.generateSnapshotsForRun(
      periodStart,
      periodEnd,
      opts.currentUser,
      opts.userId ?? null,
    );

    // ---- Read back the freshly-persisted reports for this period ----
    // We deliberately query by (periodStart, periodEnd) so we pick up
    // the exact rows just written — and only those.
    const where: {
      periodStart: Date;
      periodEnd: Date;
      userId?: string;
    } = {
      periodStart,
      periodEnd: this.endOfDay(periodEnd),
    };
    if (opts.userId) where.userId = opts.userId;

    const reports = await this.prisma.reconReport.findMany({
      where,
      orderBy: { name: 'asc' },
    });

    const snapshots: SnapshotData[] = reports.map(
      (r) => r.rows as unknown as SnapshotData,
    );

    return {
      snapshots,
      periodStart,
      periodEnd,
      workbookTitle: `FFG Reconciliation — ${titleHint}`,
    };
  }

  // ---------- Internals ----------

  // Build the structured snapshot from a flat transaction list.
  // Groups by cardLast4 and builds one SnapshotCardSection per card.
  private buildSnapshot(
    user: { id: string; name: string },
    transactions: Array<{
      id: string;
      transactionDate: Date;
      merchant: string;
      description: string | null;
      amount: number;
      category: string | null;
      cardLast4: string | null;
      matched: boolean;
      // We extended the include() in generateSnapshotsForRun so that
      // category + storeAllocation + notes come down with each invoice.
      // Array because split invoices (multi-receipt) can stack on one txn.
      invoices: Array<{
        id: string;
        supplier: string;
        total: number;
        currency: string;
        category: string | null;
        storeAllocation: string | null;
        notes: string | null;
      }>;
    }>,
    cardByLast4: Map<string, { last4: string | null; maskedNumber: string; cardholderName: string | null }>,
    periodStart: Date,
    periodEnd: Date,
  ): SnapshotData {
    // Group by cardLast4 — "no-card" transactions go under "unknown".
    const byCard = new Map<string, typeof transactions>();
    for (const t of transactions) {
      const key = t.cardLast4 ?? '__nocard__';
      const list = byCard.get(key) ?? [];
      list.push(t);
      byCard.set(key, list);
    }

    const sections: SnapshotCardSection[] = [];
    for (const [last4, txns] of byCard) {
      const card = last4 !== '__nocard__' ? cardByLast4.get(last4) : null;
      const sectionCardholder = card?.cardholderName ?? null;
      let no = 0;
      const rows: SnapshotTxnRow[] = txns.map((t) => {
        // Pick the primary matched invoice (first by createdAt). For
        // split-receipt transactions all invoices show up under the
        // /reports tab; here we only have room for one row per
        // transaction, so we use the first and tack a "+N more" hint
        // onto the supplier label.
        const primary = t.invoices[0] ?? null;
        const extraCount = Math.max(0, t.invoices.length - 1);
        const supplierLabel = primary
          ? extraCount > 0
            ? `${primary.supplier} (+${extraCount} more)`
            : primary.supplier
          : null;
        return {
          no: ++no,
          transactionId: t.id,
          date: t.transactionDate.toISOString(),
          merchant: t.merchant,
          location: t.description,
          amount: t.amount,
          category: t.category,
          description: t.description,
          hasVoucher: t.matched,
          matchedInvoice: primary
            ? {
                id: primary.id,
                supplier: supplierLabel ?? primary.supplier,
                total: primary.total,
                currency: primary.currency,
              }
            : null,
          // FFG accounting fields — come from the matched invoice.
          // Blank rows here visually flag "transaction without a receipt".
          account: primary?.category ?? null,
          department: primary?.storeAllocation ?? null,
          cardholderName: sectionCardholder,
          userNotes: primary?.notes ?? null,
        };
      });

      const balanceTransferred = rows.reduce((sum, r) => sum + r.amount, 0);

      sections.push({
        cardLast4: last4 === '__nocard__' ? '' : last4,
        maskedNumber: card?.maskedNumber ?? null,
        cardholderName: card?.cardholderName ?? null,
        balanceBroughtForward: 0,
        balanceTransferred,
        rows,
      });
    }

    return {
      statementTitle: `RECONCILIATION ${MONTH_NAMES[periodStart.getMonth()]} ${periodStart.getFullYear()}`,
      periodStart: periodStart.toISOString(),
      periodEnd: this.endOfDay(periodEnd).toISOString(),
      user,
      cards: sections,
    };
  }

  private endOfDay(d: Date): Date {
    const out = new Date(d);
    out.setHours(23, 59, 59, 999);
    return out;
  }
}
