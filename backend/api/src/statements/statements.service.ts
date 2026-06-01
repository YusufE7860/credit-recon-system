import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PdfParserService, ParsedCardSection } from './pdf-parser.service';
import { JwtUser, isPrivileged } from '../auth/role.enum';
import {
  normaliseLast4,
  normaliseMaskedNumber,
} from '../cards/cards.service';
import * as fs from 'fs';
import * as path from 'path';
// csv-parser exports a function as its default. With esModuleInterop on
// (which NestJS sets by default), default import is the right form here.
import csv from 'csv-parser';

// Cap upload size — PDFs can be larger than CSVs.
export const MAX_STATEMENT_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
export const ALLOWED_STATEMENT_MIME_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/csv',
  'text/plain', // some browsers send this for .csv
  'application/pdf',
];

// Synonyms we accept for each column. Bank CSVs use different names
// for the same fields — this normalizes them.
const HEADER_SYNONYMS = {
  date: [
    'date',
    'transaction date',
    'posting date',
    'trans date',
    'txn date',
    'value date',
  ],
  merchant: [
    'merchant',
    'description',
    'narrative',
    'reference',
    'memo',
    'details',
  ],
  amount: [
    'amount',
    'value',
    'debit',
    'transaction amount',
    'amount (zar)',
    'amount (usd)',
  ],
  // Optional columns — if present we use them.
  category: ['category', 'type'],
  cardLast4: ['card', 'card number', 'last 4', 'card last 4'],
};

export interface UploadStatementMeta {
  statementName?: string;
  bankName?: string;
  cardLast4?: string;
  periodStart?: string;
  periodEnd?: string;
}

// Turn "FNB-Visa Statement Apr 2026.pdf" into "FNB-Visa Statement Apr 2026".
// Falls back to a generic "Statement" if the result is empty / weird so the
// row always has a non-blank name.
function nameFromFilename(originalName: string): string {
  const noExt = originalName.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const cleaned = noExt.replace(/[._]+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : 'Statement';
}

// One row as it comes out of the CSV (raw strings).
type CsvRow = Record<string, string>;

// Normalized row — what we actually need to insert.
interface NormalizedTxn {
  amount: number;
  merchant: string;
  category: string | null;
  cardLast4: string | null;
  transactionDate: Date;
}

@Injectable()
export class StatementsService {
  private readonly logger = new Logger(StatementsService.name);

  constructor(
    private prisma: PrismaService,
    private pdfParser: PdfParserService,
  ) {}

  async list(currentUser: JwtUser) {
    return this.prisma.statement.findMany({
      where: isPrivileged(currentUser.role)
        ? undefined
        : { userId: currentUser.sub },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { transactions: true } },
      },
    });
  }

  async getById(id: string, currentUser?: JwtUser) {
    const statement = await this.prisma.statement.findUnique({
      where: { id },
      include: {
        transactions: { orderBy: { transactionDate: 'desc' } },
      },
    });

    if (!statement) {
      throw new NotFoundException(`Statement ${id} not found`);
    }

    if (
      currentUser &&
      !isPrivileged(currentUser.role) &&
      statement.userId !== currentUser.sub
    ) {
      throw new NotFoundException(`Statement ${id} not found`);
    }
    return statement;
  }

  // Delete a statement AND all its transactions in one atomic operation.
  //   - Any invoices matched to those transactions get unlinked first
  //     (transactionId=null, status=UNMATCHED) so the FK delete can
  //     proceed without violating the @unique constraint on Invoice.
  //   - Transactions get hard-deleted (the schema's onDelete: SetNull
  //     would orphan them, which isn't what the user wants).
  //   - The Statement row itself is deleted last.
  //   - The source file on disk is removed last of all.
  async delete(id: string) {
    const statement = await this.getById(id);

    // Collect the txn IDs upfront — used for both the invoice-unmatch
    // step and the actual delete.
    const txnIds = (
      await this.prisma.transaction.findMany({
        where: { statementId: id },
        select: { id: true },
      })
    ).map((t) => t.id);

    await this.prisma.$transaction(async (tx) => {
      if (txnIds.length > 0) {
        // 1. Reset any invoices that pointed at these transactions.
        //    Otherwise the transaction.delete below fails with an FK
        //    constraint violation (Invoice.transactionId is @unique).
        await tx.invoice.updateMany({
          where: { transactionId: { in: txnIds } },
          data: {
            transactionId: null,
            matchedAt: null,
            status: 'UNMATCHED',
          },
        });

        // 2. Hard-delete the transactions themselves.
        await tx.transaction.deleteMany({
          where: { id: { in: txnIds } },
        });
      }

      // 3. Delete the parent Statement row.
      await tx.statement.delete({ where: { id } });
    });

    // 4. Remove the source file from disk last so a DB failure above
    //    doesn't leave us with a deleted file but a half-deleted record.
    if (statement.filePath) {
      const abs = path.join(process.cwd(), 'uploads', statement.filePath);
      if (fs.existsSync(abs)) {
        try {
          fs.unlinkSync(abs);
        } catch (err) {
          this.logger.warn(
            `Statement file unlink failed: ${(err as Error).message}`,
          );
        }
      }
    }

    return {
      success: true,
      deletedTransactionCount: txnIds.length,
    };
  }

  // Return the absolute path + MIME type for a statement's source file
  // so the controller can stream it back. Used by the "View PDF" button
  // on the Reports → Statements tab.
  async getFilePath(
    id: string,
    currentUser: JwtUser,
  ): Promise<{ absolutePath: string; mimeType: string; originalName: string }> {
    const statement = await this.getById(id, currentUser);
    if (!statement.filePath) {
      throw new NotFoundException('Statement has no source file on disk.');
    }
    const absolutePath = path.join(
      process.cwd(),
      'uploads',
      statement.filePath,
    );
    if (!fs.existsSync(absolutePath)) {
      throw new NotFoundException(
        'Statement file is missing on disk — was it removed manually?',
      );
    }
    // Cheap MIME sniff by extension; we only accept CSV + PDF on upload.
    const ext = path.extname(statement.filePath).toLowerCase();
    const mimeType =
      ext === '.pdf'
        ? 'application/pdf'
        : ext === '.csv'
        ? 'text/csv'
        : 'application/octet-stream';
    return {
      absolutePath,
      mimeType,
      originalName: statement.statementName + ext,
    };
  }

  // Upload + parse + import in one operation. Dispatches to CSV or PDF
  // handler based on the file's MIME type.
  async createFromUpload(
    file: Express.Multer.File,
    meta: UploadStatementMeta,
    userId: string,
  ) {
    if (!ALLOWED_STATEMENT_MIME_TYPES.includes(file.mimetype)) {
      fs.unlinkSync(file.path);
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}`,
      );
    }

    // PDFs (multi-card bank statements) take a different code path.
    if (file.mimetype === 'application/pdf') {
      return this.createFromPdfUpload(file, meta, userId);
    }

    // ---- CSV path (single-card statement) ----
    // Read + parse the CSV first so we know how many rows we got.
    const rows = await this.parseCsv(file.path);
    if (rows.length === 0) {
      fs.unlinkSync(file.path);
      throw new BadRequestException(
        'CSV is empty or had no parseable header row',
      );
    }

    const headerMap = this.buildHeaderMap(Object.keys(rows[0]));
    if (!headerMap.date || !headerMap.merchant || !headerMap.amount) {
      fs.unlinkSync(file.path);
      throw new BadRequestException(
        `CSV is missing required columns. Need date, merchant/description, and amount. Saw: ${Object.keys(rows[0]).join(', ')}`,
      );
    }

    // Normalize every row; collect successes and skip-count separately.
    const normalized: NormalizedTxn[] = [];
    let skipped = 0;
    for (const row of rows) {
      const n = this.normalizeRow(row, headerMap);
      if (n) {
        normalized.push(n);
      } else {
        skipped++;
      }
    }

    this.logger.log(
      `Parsed ${rows.length} CSV rows — ${normalized.length} imported, ${skipped} skipped`,
    );

    // Auto-derive period when the caller didn't supply one. We pick
    // min/max transaction dates so the period always reflects what's
    // actually in the file — handy for the admin recon generator.
    let autoPeriodStart: Date | null = null;
    let autoPeriodEnd: Date | null = null;
    if (normalized.length > 0) {
      const sorted = [...normalized].sort(
        (a, b) =>
          a.transactionDate.getTime() - b.transactionDate.getTime(),
      );
      autoPeriodStart = sorted[0].transactionDate;
      autoPeriodEnd = sorted[sorted.length - 1].transactionDate;
    }

    // Create the statement + transactions in a single Prisma transaction
    // so we either get all-or-nothing. Avoids half-imported state.
    const statement = await this.prisma.$transaction(async (tx) => {
      const stmt = await tx.statement.create({
        data: {
          // Name precedence: explicit meta > derived from filename. Avoids
          // saving raw "march-statement-final-FINAL.csv" verbatim.
          statementName:
            meta.statementName?.trim() || nameFromFilename(file.originalname),
          bankName: meta.bankName ?? null,
          cardLast4: meta.cardLast4 ?? null,
          // Period precedence: explicit meta > derived from txn dates.
          periodStart: meta.periodStart
            ? new Date(meta.periodStart)
            : autoPeriodStart,
          periodEnd: meta.periodEnd
            ? new Date(meta.periodEnd)
            : autoPeriodEnd,
          filePath: path.basename(file.path),
          importedCount: normalized.length,
          skippedCount: skipped,
          userId,
        },
      });

      // createMany is much faster than looping individual creates.
      // It doesn't return the inserted rows, which is fine here.
      if (normalized.length > 0) {
        await tx.transaction.createMany({
          data: normalized.map((n) => ({
            amount: n.amount,
            merchant: n.merchant,
            category: n.category,
            description: null,
            transactionDate: n.transactionDate,
            cardLast4: n.cardLast4 ?? meta.cardLast4 ?? null,
            statementId: stmt.id,
            status: 'POSTED',
            userId,
          })),
        });
      }

      return stmt;
    });

    return statement;
  }

  // ---------- PDF path ----------

  // Handle multi-card PDF statements (e.g. FNB business statement).
  // For each card section in the PDF:
  //   - look up the Card by last4
  //   - if missing, auto-create with cardholderName from the PDF
  //   - attribute transactions to Card.assignedUserId if set, else to
  //     the uploader (with `flagged: true` to signal manual review).
  private async createFromPdfUpload(
    file: Express.Multer.File,
    meta: UploadStatementMeta,
    uploaderId: string,
  ) {
    const parsed = await this.pdfParser.parseStatement(file.path);

    let totalImported = 0;
    let totalSkipped = 0;
    const cardSummaries: Array<{
      last4: string;
      cardholderName: string;
      imported: number;
      assignedUserId: string | null;
      autoCreated: boolean;
    }> = [];

    // Compute min/max transaction dates across every card so we can
    // derive a tight period when the PDF header didn't give us one.
    const allTxnDates: Date[] = [];
    for (const c of parsed.cards) {
      for (const t of c.transactions) allTxnDates.push(t.date);
    }
    const autoPeriodStart =
      allTxnDates.length > 0
        ? new Date(Math.min(...allTxnDates.map((d) => d.getTime())))
        : null;
    const autoPeriodEnd =
      allTxnDates.length > 0
        ? new Date(Math.max(...allTxnDates.map((d) => d.getTime())))
        : null;

    // One DB transaction wraps the whole import — all-or-nothing.
    const statement = await this.prisma.$transaction(async (tx) => {
      // Create the parent Statement row first so we have its ID for the FK.
      const stmt = await tx.statement.create({
        data: {
          // Name precedence: explicit meta > clean filename. The old
          // "PDF statement X.pdf" prefix added noise without value.
          statementName:
            meta.statementName?.trim() || nameFromFilename(file.originalname),
          bankName: meta.bankName ?? null,
          cardLast4: null, // PDF spans multiple cards
          // Period precedence: explicit meta > min/max txn dates >
          // PDF header date as a last resort.
          periodStart:
            meta.periodStart
              ? new Date(meta.periodStart)
              : autoPeriodStart ?? parsed.statementDate ?? null,
          periodEnd:
            meta.periodEnd
              ? new Date(meta.periodEnd)
              : autoPeriodEnd ?? parsed.statementDate ?? null,
          filePath: path.basename(file.path),
          importedCount: 0, // updated after we know the total
          skippedCount: 0,
          userId: uploaderId,
        },
      });

      // Process each card section.
      for (const section of parsed.cards) {
        const result = await this.importCardSection(
          tx,
          section,
          stmt.id,
          uploaderId,
        );
        totalImported += result.imported;
        totalSkipped += result.skipped;
        cardSummaries.push({
          last4: section.last4,
          cardholderName: section.cardholderName,
          imported: result.imported,
          assignedUserId: result.assignedUserId,
          autoCreated: result.autoCreated,
        });
      }

      // Update final counts on the statement.
      return tx.statement.update({
        where: { id: stmt.id },
        data: { importedCount: totalImported, skippedCount: totalSkipped },
      });
    });

    this.logger.log(
      `PDF statement import: ${parsed.cards.length} cards, ${totalImported} txns imported, ${totalSkipped} skipped`,
    );

    return {
      ...statement,
      cards: cardSummaries, // returned to UI so admin can see what happened
      warnings: parsed.warnings,
    };
  }

  // Import one card section. Returns counts and metadata for the summary.
  // Receives a Prisma transaction client so it joins the outer atomic op.
  private async importCardSection(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    section: ParsedCardSection,
    statementId: string,
    uploaderId: string,
  ) {
    // 1. Find or auto-create the Card.
    //
    // Normalise FIRST so the lookup matches existing cards even if the
    // statement formatting changed between months (extra whitespace,
    // *-padded numbers, etc.). Without this, "  5678" wouldn't find a
    // card stored as "5678" and we'd end up with a duplicate row.
    const normalisedLast4 = normaliseLast4(section.last4);
    const normalisedMasked =
      normaliseMaskedNumber(section.maskedNumber) ?? section.maskedNumber;

    let card = normalisedLast4
      ? await tx.card.findUnique({ where: { last4: normalisedLast4 } })
      : null;

    // Belt-and-braces: if last4 didn't match, also try the masked
    // number. Catches the case where last4 is missing/blank on the
    // existing row but the masked number is identical.
    if (!card && normalisedMasked) {
      card = await tx.card.findFirst({
        where: { maskedNumber: normalisedMasked },
      });
    }

    let autoCreated = false;
    if (!card) {
      card = await tx.card.create({
        data: {
          cardName: section.cardholderName || `Card ending ${normalisedLast4 ?? section.last4}`,
          cardholderName: section.cardholderName || null,
          maskedNumber: normalisedMasked,
          last4: normalisedLast4,
          // assignedUserId stays null — admin must assign later.
        },
      });
      autoCreated = true;
      this.logger.log(
        `Auto-created Card last4=${normalisedLast4 ?? '?'} (${section.cardholderName})`,
      );
    }

    // 2. Decide who owns these transactions.
    //    Assigned user if known; otherwise uploader, flagged for review.
    const ownerUserId = card.assignedUserId ?? uploaderId;
    const needsAssignment = card.assignedUserId === null;

    // 3. Insert all transactions for this card. createMany is fast.
    let imported = 0;
    let skipped = 0;
    if (section.transactions.length > 0) {
      const result = await tx.transaction.createMany({
        data: section.transactions.map((t) => ({
          amount: t.amount,
          merchant: t.merchant,
          description: t.location,
          category: t.isFee ? 'Bank Fee' : null,
          transactionDate: t.date,
          // Use the normalised last4 so transactions match the same
          // value stored on the Card row — important for the dedup
          // lookup on the NEXT statement upload.
          cardLast4: normalisedLast4 ?? section.last4,
          statementId,
          status: 'POSTED',
          // Flag transactions on unassigned cards so admin can route them.
          flagged: needsAssignment,
          userId: ownerUserId,
        })),
      });
      imported = result.count;
    }

    return {
      imported,
      skipped,
      assignedUserId: card.assignedUserId,
      autoCreated,
    };
  }

  // ---------- CSV helpers ----------

  // Read a CSV file from disk into an array of row objects.
  private parseCsv(filePath: string): Promise<CsvRow[]> {
    return new Promise((resolve, reject) => {
      const results: CsvRow[] = [];
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row: CsvRow) => results.push(row))
        .on('end', () => resolve(results))
        .on('error', reject);
    });
  }

  // Inspect the CSV headers and map each one of our logical columns
  // ("date", "merchant", "amount", ...) to the actual column name in
  // this particular CSV. Returns undefined for missing-optional columns.
  private buildHeaderMap(headers: string[]) {
    const lowerToOriginal = new Map<string, string>();
    for (const h of headers) lowerToOriginal.set(h.trim().toLowerCase(), h);

    function find(synonyms: string[]): string | undefined {
      for (const syn of synonyms) {
        const original = lowerToOriginal.get(syn);
        if (original) return original;
      }
      return undefined;
    }

    return {
      date: find(HEADER_SYNONYMS.date),
      merchant: find(HEADER_SYNONYMS.merchant),
      amount: find(HEADER_SYNONYMS.amount),
      category: find(HEADER_SYNONYMS.category),
      cardLast4: find(HEADER_SYNONYMS.cardLast4),
    };
  }

  // Turn one raw CSV row into a NormalizedTxn, or return null if the
  // row doesn't have enough valid data to import.
  private normalizeRow(
    row: CsvRow,
    map: ReturnType<typeof this.buildHeaderMap>,
  ): NormalizedTxn | null {
    if (!map.date || !map.merchant || !map.amount) return null;

    const rawDate = row[map.date]?.trim();
    const rawMerchant = row[map.merchant]?.trim();
    const rawAmount = row[map.amount]?.trim();

    if (!rawDate || !rawMerchant || !rawAmount) return null;

    const date = this.parseDate(rawDate);
    if (!date) return null;

    const amount = this.parseAmount(rawAmount);
    if (amount === null) return null;

    return {
      amount,
      merchant: rawMerchant,
      category: map.category ? (row[map.category]?.trim() || null) : null,
      cardLast4: map.cardLast4
        ? (row[map.cardLast4]?.trim().slice(-4) || null)
        : null,
      transactionDate: date,
    };
  }

  // Reuses the same date heuristics as the invoice parser.
  private parseDate(s: string): Date | null {
    // ISO first: 2024-03-15
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

    // DD/MM/YYYY (common in ZA/EU)
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (dmy) {
      let y = Number(dmy[3]);
      if (y < 100) y += 2000;
      return new Date(y, Number(dmy[2]) - 1, Number(dmy[1]));
    }

    // Fall back to JS Date parsing for anything else.
    const fallback = new Date(s);
    return isNaN(fallback.getTime()) ? null : fallback;
  }

  // Parse amounts like "1,234.56", "(123.45)" for negatives, "R 99.00".
  private parseAmount(s: string): number | null {
    const isNegative = /^\(.*\)$/.test(s.trim()); // accountancy negative
    const cleaned = s
      .replace(/[()\s]/g, '')
      .replace(/[^0-9.\-]/g, '');
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    if (isNaN(n)) return null;
    return isNegative ? -Math.abs(n) : n;
  }
}
