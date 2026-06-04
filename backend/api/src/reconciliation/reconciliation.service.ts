import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Invoice, Transaction, ReconStatus } from '@prisma/client';
import { JwtUser, isPrivileged } from '../auth/role.enum';
import { ReconReportsService } from '../recon-reports/recon-reports.service';
import { SettingsService, SETTING_KEYS } from '../settings/settings.service';

// ---------- Defaults ----------
// Used when the corresponding setting hasn't been set in /admin/settings.
const DEFAULT_AMOUNT_TOLERANCE = 0.05;
const DEFAULT_DATE_TOLERANCE_DAYS = 5;
const DEFAULT_MERCHANT_THRESHOLD = 0.4;
const DEFAULT_MIN_SCORE = 0.6;

// Weights for the three signals — kept as constants because tuning
// them requires changing the algorithm intent, not just a number.
const W_AMOUNT = 0.45;
const W_DATE = 0.25;
const W_MERCHANT = 0.30;

// ---------- Result types ----------

export interface ReconcileResult {
  invoicesConsidered: number;
  transactionsConsidered: number;
  newlyMatched: number;
  stillUnmatched: number;
  matches: Array<{
    invoiceId: string;
    transactionId: string;
    score: number;
  }>;
}

export interface ReconStats {
  totalInvoices: number;
  matched: number;
  unmatched: number;
  pending: number;
  disputed: number;
  rejected: number;
  matchedRate: number; // 0..1
}

// ---------- Service ----------

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private prisma: PrismaService,
    private reconReportsService: ReconReportsService,
    private settings: SettingsService,
  ) {}

  // Current state of the world — used by the dashboard.
  async getStats(): Promise<ReconStats> {
    const grouped = await this.prisma.invoice.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const stats: ReconStats = {
      totalInvoices: 0,
      matched: 0,
      unmatched: 0,
      pending: 0,
      disputed: 0,
      rejected: 0,
      matchedRate: 0,
    };

    for (const row of grouped) {
      const count = row._count._all;
      stats.totalInvoices += count;
      switch (row.status) {
        case ReconStatus.MATCHED:   stats.matched = count; break;
        case ReconStatus.UNMATCHED: stats.unmatched = count; break;
        case ReconStatus.PENDING:   stats.pending = count; break;
        case ReconStatus.DISPUTED:  stats.disputed = count; break;
        case ReconStatus.REJECTED:  stats.rejected = count; break;
      }
    }

    stats.matchedRate = stats.totalInvoices > 0
      ? stats.matched / stats.totalInvoices
      : 0;

    return stats;
  }

  // The main entry point. Runs the full matching algorithm.
  //
  // Scoping rules:
  //   USER       → only their own invoices vs their own transactions
  //   REPORTING  → all invoices vs all transactions (org-wide)
  //   ADMIN      → same as REPORTING
  //
  // The same algorithm runs in either mode; only the candidate pool
  // is different. This lets a user "tidy up my own books" without
  // needing an admin to trigger a global recon.
  // Period defaults to "current calendar month" if the caller doesn't
  // specify one. The period drives BOTH the candidate filter AND the
  // recon-report snapshot scope so the saved sheet always matches what
  // was matched.
  async runReconciliation(
    currentUser: JwtUser,
    period?: { from: Date; to: Date },
  ): Promise<ReconcileResult> {
    const scopedToSelf = !isPrivileged(currentUser.role);
    const effectivePeriod = period ?? this.defaultPeriod();
    this.logger.log(
      `Starting reconciliation run — ${scopedToSelf ? `scoped to user ${currentUser.email}` : 'org-wide'} — period ${effectivePeriod.from.toISOString().slice(0, 10)} → ${effectivePeriod.to.toISOString().slice(0, 10)}`,
    );

    const endOfPeriod = new Date(effectivePeriod.to);
    endOfPeriod.setHours(23, 59, 59, 999);

    // 1. Load unmatched candidates, filtered by ownership for plain USERs
    //    AND by date — only consider invoices/transactions in the period.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        transactionId: null,
        status: { in: [ReconStatus.PENDING, ReconStatus.UNMATCHED] },
        userId: scopedToSelf ? currentUser.sub : undefined,
        invoiceDate: { gte: effectivePeriod.from, lte: endOfPeriod },
      },
    });

    const transactions = await this.prisma.transaction.findMany({
      where: {
        matched: false,
        // Skip transactions that are bank-side fees / FX charges. Those
        // have no invoice to match against and are pre-marked at import
        // time so they never enter the matching pool.
        noMatchRequired: false,
        userId: scopedToSelf ? currentUser.sub : undefined,
        transactionDate: { gte: effectivePeriod.from, lte: endOfPeriod },
      },
    });

    this.logger.log(
      `Considering ${invoices.length} invoices vs ${transactions.length} transactions`,
    );

    // 2. Score every plausible pair.
    type Candidate = {
      invoice: Invoice;
      transaction: Transaction;
      score: number;
    };
    const candidates: Candidate[] = [];

    // Pull tunables once per run rather than per-pair.
    const minScore = this.settings.getNumber(
      SETTING_KEYS.RECON_MIN_SCORE,
      DEFAULT_MIN_SCORE,
    );

    for (const inv of invoices) {
      for (const txn of transactions) {
        const score = this.scoreMatch(inv, txn);
        if (score >= minScore) {
          candidates.push({ invoice: inv, transaction: txn, score });
        }
      }
    }

    // 3. Sort by score descending — assign best matches first.
    candidates.sort((a, b) => b.score - a.score);

    // 4. Greedily assign. Skip any candidate whose invoice or
    //    transaction has already been matched in this run.
    const matchedInvoiceIds = new Set<string>();
    const matchedTransactionIds = new Set<string>();
    const matchesToApply: Candidate[] = [];

    for (const c of candidates) {
      if (matchedInvoiceIds.has(c.invoice.id)) continue;
      if (matchedTransactionIds.has(c.transaction.id)) continue;
      matchesToApply.push(c);
      matchedInvoiceIds.add(c.invoice.id);
      matchedTransactionIds.add(c.transaction.id);
    }

    // 5. Persist matches + mark remaining invoices UNMATCHED.
    //    Wrap in a $transaction so the run is atomic.
    await this.prisma.$transaction(async (tx) => {
      for (const m of matchesToApply) {
        await tx.invoice.update({
          where: { id: m.invoice.id },
          data: {
            transactionId: m.transaction.id,
            status: ReconStatus.MATCHED,
            matchedAt: new Date(),
          },
        });
        await tx.transaction.update({
          where: { id: m.transaction.id },
          data: { matched: true },
        });
      }

      // Anything left unmatched after the run gets the UNMATCHED label
      // (was probably PENDING before).
      const unmatchedIds = invoices
        .filter((i) => !matchedInvoiceIds.has(i.id))
        .map((i) => i.id);

      if (unmatchedIds.length > 0) {
        await tx.invoice.updateMany({
          where: { id: { in: unmatchedIds } },
          data: { status: ReconStatus.UNMATCHED },
        });
      }
    });

    const result: ReconcileResult = {
      invoicesConsidered: invoices.length,
      transactionsConsidered: transactions.length,
      newlyMatched: matchesToApply.length,
      stillUnmatched: invoices.length - matchesToApply.length,
      matches: matchesToApply.map((m) => ({
        invoiceId: m.invoice.id,
        transactionId: m.transaction.id,
        score: m.score,
      })),
    };

    this.logger.log(
      `Reconciliation complete: ${result.newlyMatched} new matches, ${result.stillUnmatched} still unmatched`,
    );

    // Persist the snapshot(s) so they show up in /reports.
    // Snapshot is per-user (one ReconReport per active user in the period).
    try {
      await this.reconReportsService.generateSnapshotsForRun(
        effectivePeriod.from,
        effectivePeriod.to,
        currentUser,
        scopedToSelf ? currentUser.sub : null,
      );
    } catch (err) {
      // Don't fail the recon if snapshotting throws — log and continue.
      this.logger.error(
        `Snapshot generation failed: ${(err as Error).message}`,
      );
    }

    return result;
  }

  // Run a full org-wide reconciliation for a given period, with NO
  // user scoping. Triggered automatically after a statement upload or
  // re-upload, where we want EVERY pending/unmatched invoice in the
  // period to get a shot at the new transaction pool — regardless of
  // which user uploaded the invoice vs which user owns the card.
  //
  // Differs from runReconciliation():
  //   - No JwtUser required (statement upload is the "actor").
  //   - Never scoped to a single user; statements typically span many.
  //   - Skips snapshot generation — the user-triggered recon button is
  //     still the canonical "create a saved report" entry point.
  //
  // Returns the same shape as runReconciliation() so the caller can
  // log meaningful counts.
  async reconcileForPeriod(period: {
    from: Date;
    to: Date;
  }): Promise<ReconcileResult> {
    this.logger.log(
      `Auto-reconciliation triggered (org-wide) — period ${period.from.toISOString().slice(0, 10)} → ${period.to.toISOString().slice(0, 10)}`,
    );

    const endOfPeriod = new Date(period.to);
    endOfPeriod.setHours(23, 59, 59, 999);
    const startOfPeriod = new Date(period.from);
    startOfPeriod.setHours(0, 0, 0, 0);

    // Pull every still-open invoice in the period. Note we DON'T filter
    // by userId — a statement upload is org-side, so we let invoices
    // from any user compete for the transactions in the new statement.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        transactionId: null,
        status: { in: [ReconStatus.PENDING, ReconStatus.UNMATCHED] },
        invoiceDate: { gte: startOfPeriod, lte: endOfPeriod },
      },
    });

    // Same for transactions — every unmatched, non-fee, in-period row.
    const transactions = await this.prisma.transaction.findMany({
      where: {
        matched: false,
        noMatchRequired: false,
        transactionDate: { gte: startOfPeriod, lte: endOfPeriod },
      },
    });

    this.logger.log(
      `Auto-recon: ${invoices.length} open invoices vs ${transactions.length} unmatched transactions`,
    );

    if (invoices.length === 0 || transactions.length === 0) {
      // Nothing to do — return an empty result, no DB writes.
      return {
        invoicesConsidered: invoices.length,
        transactionsConsidered: transactions.length,
        newlyMatched: 0,
        stillUnmatched: invoices.length,
        matches: [],
      };
    }

    const minScore = this.settings.getNumber(
      SETTING_KEYS.RECON_MIN_SCORE,
      DEFAULT_MIN_SCORE,
    );

    type Candidate = {
      invoice: Invoice;
      transaction: Transaction;
      score: number;
    };
    const candidates: Candidate[] = [];
    for (const inv of invoices) {
      // Critical: enforce same-owner pairing here. We don't want one
      // user's invoice claiming another user's transaction by accident.
      // The candidate POOL is org-wide (so admin-uploaded statements
      // reach every user's invoices), but actual matches stay within
      // a single user's ownership.
      for (const txn of transactions) {
        if (txn.userId !== inv.userId) continue;
        const score = this.scoreMatch(inv, txn);
        if (score >= minScore) {
          candidates.push({ invoice: inv, transaction: txn, score });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    const claimedInvoices = new Set<string>();
    const claimedTransactions = new Set<string>();
    const matchesToApply: Candidate[] = [];
    for (const c of candidates) {
      if (claimedInvoices.has(c.invoice.id)) continue;
      if (claimedTransactions.has(c.transaction.id)) continue;
      matchesToApply.push(c);
      claimedInvoices.add(c.invoice.id);
      claimedTransactions.add(c.transaction.id);
    }

    await this.prisma.$transaction(async (tx) => {
      for (const m of matchesToApply) {
        await tx.invoice.update({
          where: { id: m.invoice.id },
          data: {
            transactionId: m.transaction.id,
            status: ReconStatus.MATCHED,
            matchedAt: new Date(),
          },
        });
        await tx.transaction.update({
          where: { id: m.transaction.id },
          data: { matched: true },
        });
      }
      // PENDING invoices that didn't find a match now graduate to
      // UNMATCHED (they had their chance with the new transaction pool).
      const stillOpenIds = invoices
        .filter((i) => !claimedInvoices.has(i.id))
        .map((i) => i.id);
      if (stillOpenIds.length > 0) {
        await tx.invoice.updateMany({
          where: { id: { in: stillOpenIds } },
          data: { status: ReconStatus.UNMATCHED },
        });
      }
    });

    this.logger.log(
      `Auto-recon complete: ${matchesToApply.length} matched, ${invoices.length - matchesToApply.length} still unmatched`,
    );

    return {
      invoicesConsidered: invoices.length,
      transactionsConsidered: transactions.length,
      newlyMatched: matchesToApply.length,
      stillUnmatched: invoices.length - matchesToApply.length,
      matches: matchesToApply.map((m) => ({
        invoiceId: m.invoice.id,
        transactionId: m.transaction.id,
        score: m.score,
      })),
    };
  }

  // First day of the current month → today. Used when the caller
  // doesn't pass an explicit period to runReconciliation.
  private defaultPeriod(): { from: Date; to: Date } {
    const now = new Date();
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: now,
    };
  }

  // Auto-match a single invoice against the pool of unmatched
  // transactions. Called from InvoicesService.createFromUpload so
  // the user sees a match immediately after upload — no need to
  // hit "Run Reconciliation" first.
  //
  // Scoping: candidates are restricted to transactions owned by the
  // invoice's user (same rule as the full recon run for non-privileged
  // users). This matches the most common case where a user uploads
  // their own receipt against their own card transactions.
  //
  // Returns the match if applied, null if nothing scored above threshold.
  async matchSingleInvoice(invoiceId: string): Promise<{
    matched: boolean;
    transactionId?: string;
    score?: number;
  }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice || invoice.transactionId) {
      // Either gone or already matched — nothing to do.
      return { matched: false };
    }

    // Date window — only consider transactions within recon's date
    // tolerance of the invoice date. Speeds up the candidate fetch
    // and avoids loading the entire transaction table on every upload.
    const dateLimitDays = this.settings.getNumber(
      SETTING_KEYS.RECON_DATE_TOLERANCE_DAYS,
      DEFAULT_DATE_TOLERANCE_DAYS,
    );
    const lo = new Date(invoice.invoiceDate);
    lo.setDate(lo.getDate() - dateLimitDays);
    const hi = new Date(invoice.invoiceDate);
    hi.setDate(hi.getDate() + dateLimitDays);

    const candidates = await this.prisma.transaction.findMany({
      where: {
        matched: false,
        noMatchRequired: false, // skip bank-fee rows
        userId: invoice.userId,
        transactionDate: { gte: lo, lte: hi },
      },
    });

    if (candidates.length === 0) {
      this.logger.log(
        `Auto-match: no candidates in date window for invoice ${invoice.id}`,
      );
      return { matched: false };
    }

    const minScore = this.settings.getNumber(
      SETTING_KEYS.RECON_MIN_SCORE,
      DEFAULT_MIN_SCORE,
    );

    let best: { transaction: Transaction; score: number } | null = null;
    for (const txn of candidates) {
      const score = this.scoreMatch(invoice, txn);
      if (score < minScore) continue;
      if (!best || score > best.score) best = { transaction: txn, score };
    }

    if (!best) {
      this.logger.log(
        `Auto-match: invoice ${invoice.id} — no candidate scored above ${minScore}`,
      );
      return { matched: false };
    }

    // Apply the match atomically.
    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          transactionId: best!.transaction.id,
          status: ReconStatus.MATCHED,
          matchedAt: new Date(),
        },
      });
      await tx.transaction.update({
        where: { id: best!.transaction.id },
        data: { matched: true },
      });
    });

    this.logger.log(
      `Auto-match: invoice ${invoice.id} → transaction ${best.transaction.id} (score ${best.score.toFixed(2)})`,
    );
    return {
      matched: true,
      transactionId: best.transaction.id,
      score: best.score,
    };
  }

  // Manually force a match — for cases where the auto-matcher missed.
  // A USER can only link THEIR invoice to THEIR transaction.
  // Admins/Reporting can match across the org.
  async manualMatch(
    invoiceId: string,
    transactionId: string,
    currentUser: JwtUser,
  ) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found`);

    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
    });
    if (!transaction) {
      throw new NotFoundException(`Transaction ${transactionId} not found`);
    }

    // Ownership check for non-privileged users. We use a generic
    // ForbiddenException rather than leaking which side they don't own.
    if (!isPrivileged(currentUser.role)) {
      if (
        invoice.userId !== currentUser.sub ||
        transaction.userId !== currentUser.sub
      ) {
        throw new ForbiddenException(
          'You can only match invoices to transactions you own.',
        );
      }
    }

    if (invoice.transactionId) {
      throw new BadRequestException(
        'Invoice is already matched — unlink it first',
      );
    }
    if (transaction.matched) {
      throw new BadRequestException(
        'Transaction is already matched to another invoice',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedInvoice = await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          transactionId,
          status: ReconStatus.MATCHED,
          matchedAt: new Date(),
        },
      });
      await tx.transaction.update({
        where: { id: transactionId },
        data: { matched: true },
      });
      return updatedInvoice;
    });
  }

  // List transactions that aren't matched to any invoice yet. Feeds
  // the "manual match" picker on the invoice detail page.
  //
  // Scope:
  //   - USER: only their own transactions
  //   - UPLOADER: same scope as their visible invoices — transactions
  //     belonging to any user they're assigned to (for assistants)
  //   - REPORTING/ADMIN: every unmatched transaction
  //
  // When `invoiceId` is supplied, we narrow further:
  //   - To transactions belonging to the SAME owning user as the invoice
  //     (so an admin matching for John doesn't accidentally pick Jane's
  //     transaction; correct in 99% of real cases).
  async listUnmatchedTransactions(
    currentUser: JwtUser,
    invoiceId?: string,
  ) {
    let userScopeFilter: { userId?: string } = {};

    if (currentUser.role === 'UPLOADER') {
      // UPLOADER doesn't see anyone's transactions by default — manual
      // matching is an accountant workflow, not an uploader one.
      return [];
    }
    if (!isPrivileged(currentUser.role)) {
      userScopeFilter = { userId: currentUser.sub };
    }

    // Narrow to the invoice's owner so admins don't accidentally
    // cross-match users.
    if (invoiceId) {
      const inv = await this.prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { userId: true },
      });
      if (inv?.userId) {
        userScopeFilter = { userId: inv.userId };
      }
    }

    return this.prisma.transaction.findMany({
      where: {
        ...userScopeFilter,
        matched: false,
        // Skip refunds — invoices shouldn't match negative-amount rows.
        amount: { gt: 0 },
        // Skip bank-side fees — they're handled automatically.
        noMatchRequired: false,
      },
      orderBy: { transactionDate: 'desc' },
      // Capped — a giant unmatched pool would slow the picker. Tune up
      // if real-world usage hits the wall.
      take: 200,
      select: {
        id: true,
        transactionDate: true,
        merchant: true,
        amount: true,
        cardLast4: true,
        category: true,
        description: true,
      },
    });
  }

  // Break an existing match — the invoice goes back to UNMATCHED.
  // USERs can only unlink their own invoices; admins/reporting can unlink any.
  async unlink(invoiceId: string, currentUser: JwtUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found`);

    if (
      !isPrivileged(currentUser.role) &&
      invoice.userId !== currentUser.sub
    ) {
      throw new ForbiddenException(
        'You can only unlink invoices you own.',
      );
    }

    if (!invoice.transactionId) {
      throw new BadRequestException('Invoice is not matched');
    }

    const previousTransactionId = invoice.transactionId;

    return this.prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: previousTransactionId },
        data: { matched: false },
      });
      return tx.invoice.update({
        where: { id: invoiceId },
        data: {
          transactionId: null,
          status: ReconStatus.UNMATCHED,
          matchedAt: null,
        },
      });
    });
  }

  // ---------- Scoring ----------

  // Combine three signals into a single 0..1 score.
  // Returns 0 if any signal hard-fails (e.g. dates too far apart),
  // saving us from explicitly filtering.
  private scoreMatch(invoice: Invoice, transaction: Transaction): number {
    const invoiceAmountZAR = invoice.totalZAR ?? invoice.total;
    const amountScore = this.scoreAmount(invoiceAmountZAR, transaction.amount);
    if (amountScore === 0) return 0;

    const dateScore = this.scoreDate(
      invoice.invoiceDate,
      transaction.transactionDate,
    );
    if (dateScore === 0) return 0;

    const merchantScore = this.scoreMerchant(
      invoice.supplier,
      transaction.merchant,
    );

    // OVERRIDE: when amount is essentially exact AND date is within
    // ~1 day, accept the match even if the bank's merchant string looks
    // nothing like the invoice supplier. Bank statements love mangled
    // shortcodes — "Facebk *5vfsgmrr72 Fb.Me/Ads" vs invoice supplier
    // "Meta Platforms Ireland Limited" share almost no tokens but ARE
    // the same purchase. Exact amount + same day is statistically very
    // strong evidence on its own.
    const isHighConfidenceExact = amountScore >= 0.99 && dateScore >= 0.8;

    if (!isHighConfidenceExact) {
      const merchantThreshold = this.settings.getNumber(
        SETTING_KEYS.RECON_MERCHANT_THRESHOLD,
        DEFAULT_MERCHANT_THRESHOLD,
      );
      if (merchantScore < merchantThreshold) return 0;
    }

    return (
      amountScore * W_AMOUNT +
      dateScore * W_DATE +
      // For the exact-override case we floor the merchant score at 0.5
      // so the final score lands well above min-match. Otherwise an
      // exact-amount + same-day pair with 0 merchant score could compute
      // to ~0.7, which is fine but we add headroom for tie-breaking.
      Math.max(merchantScore, isHighConfidenceExact ? 0.5 : 0) * W_MERCHANT
    );
  }

  // 1.0 if amounts are within tolerance, then linear decay over R10.
  private scoreAmount(a: number, b: number): number {
    const diff = Math.abs(Math.abs(a) - Math.abs(b));
    const tolerance = this.settings.getNumber(
      SETTING_KEYS.RECON_AMOUNT_TOLERANCE,
      DEFAULT_AMOUNT_TOLERANCE,
    );
    if (diff <= tolerance) return 1;
    if (diff <= 10) return 1 - diff / 10;
    return 0;
  }

  // 1.0 if same day, linear decay to 0 at the configured tolerance.
  private scoreDate(a: Date, b: Date): number {
    const diffDays = Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
    const limit = this.settings.getNumber(
      SETTING_KEYS.RECON_DATE_TOLERANCE_DAYS,
      DEFAULT_DATE_TOLERANCE_DAYS,
    );
    if (diffDays > limit) return 0;
    return 1 - diffDays / limit;
  }

  // Merchant similarity: token-based Jaccard with a containment bonus,
  // PLUS a normalization pass that rewrites common bank-statement
  // shortcodes to their canonical merchant names.
  //   "Facebk *xyz Fb.Me/Ads"  →  "facebook meta"
  //   "Stripe *Acme Co"        →  "acme co"  (payment processor stripped)
  //   "PayPal *Foo Bar"        →  "paypal foo bar"
  private scoreMerchant(a: string, b: string): number {
    const na = this.normalize(this.applyMerchantAliases(a));
    const nb = this.normalize(this.applyMerchantAliases(b));
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.9;

    const ta = this.tokens(na);
    const tb = this.tokens(nb);
    if (ta.size === 0 || tb.size === 0) return 0;

    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    const union = new Set([...ta, ...tb]).size;
    return intersection / union;
  }

  // Rewrites bank-statement merchant strings to something closer to
  // the invoice's supplier name. Add new entries as you discover them
  // in real data — these are the obvious offenders for SA cards.
  private applyMerchantAliases(s: string): string {
    let t = s.toLowerCase();

    // ---- Known merchant aliases (bank-side → canonical name) ----
    const aliasRules: Array<[RegExp, string]> = [
      // Meta / Facebook ads — appears as "Facebk *..." or "Fb.Me/Ads"
      [/\bfacebk\b/gi,         ' facebook meta '],
      [/\bfb\.me\/?ads?\b/gi,  ' facebook meta '],
      [/\bfb\.me\b/gi,         ' facebook meta '],
      // Google / Alphabet
      [/\bgoogle\s*\*?\s*ads?\b/gi, ' google ads '],
      [/\bgoogle\s*\*/gi,      ' google '],
      // Apple — appears as "APL*ITUNES.COM/BILL" or "Apple.com/Bill"
      [/\bapl\*itunes/gi,      ' apple itunes '],
      [/\bapple\.com\/?bill\b/gi, ' apple '],
      // Amazon — sometimes "AMZN Mktp" or "Amazon DigSvcs"
      [/\bamzn\s*mktp\b/gi,    ' amazon '],
      [/\bamzn\b/gi,           ' amazon '],
      // Microsoft
      [/\bmsft\b/gi,           ' microsoft '],
      [/\bms\s*\*\s*(microsoft|office|365)/gi, ' microsoft '],
      // PayPal — keep "PayPal" so it scores against invoices from PayPal
      [/\bpaypal\s*\*?/gi,     ' paypal '],
    ];
    for (const [re, repl] of aliasRules) {
      t = t.replace(re, repl);
    }

    // ---- Payment-processor prefixes ("Stripe *...", "Payfast *...") ----
    // Strip these entirely — the part after the asterisk is the real
    // merchant, e.g. "Stripe *Acme Coffee" → " Acme Coffee".
    t = t.replace(
      /\b(stripe|payfast|sq|payu|peach|yoco|snapscan|adyen|s2s)\s*\*+/gi,
      ' ',
    );

    // ---- Reference shortcodes ----
    // Strip standalone alphanumeric chunks of 8+ chars — these are
    // bank transaction references, not merchant names. e.g. "5vfsgmrr72".
    t = t.replace(/\b[a-z0-9]{8,}\b/gi, ' ');

    return t;
  }

  private normalize(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokens(s: string): Set<string> {
    // Drop short tokens (a, an, of, etc.) — they're noise.
    return new Set(s.split(' ').filter((t) => t.length > 2));
  }
}
