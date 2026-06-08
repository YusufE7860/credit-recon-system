import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReconStatus, Prisma } from '@prisma/client';
import { OcrService } from '../ocr/ocr.service';
import { InvoiceParserService } from '../ocr/invoice-parser.service';
import { CurrencyService } from '../ocr/currency.service';
import { AIInvoiceExtractorService } from '../ocr/ai-extractor.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { Inject, forwardRef as injectForwardRef } from '@nestjs/common';
import { JwtUser, isPrivileged, Role } from '../auth/role.enum';
import * as fs from 'fs';
import * as path from 'path';

// If OCR confidence is below this threshold we flag the invoice for
// manual review. Tune based on real-world results.
const OCR_CONFIDENCE_THRESHOLD = 0.6;

// Critical fields whose absence forces a manual review regardless of
// overall confidence — total and supplier are non-negotiable.
const CRITICAL_FIELDS = ['supplier', 'total'] as const;

// Multipart can't transport arrays directly — the frontend sends the
// selected stores as a JSON string OR a comma-separated list. This
// helper handles both shapes and also dedupes.
function parseStoreAllocations(raw: string | undefined): string[] {
  if (!raw) return [];
  let arr: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) arr = parsed.map(String);
    } catch {
      arr = [];
    }
  } else {
    arr = trimmed.split(',');
  }
  return Array.from(
    new Set(arr.map((s) => s.trim()).filter((s) => s.length > 0)),
  );
}

// Maximum file size we'll accept for an invoice upload.
// Multer's limits also enforce this at the wire level — see the controller.
// 30 MB chosen because modern phone photos (especially iOS HDR JPEGs
// at full resolution) can run 8–15 MB. PDFs of multi-page scanned
// invoices can also be large. Must stay ≤ Nginx's client_max_body_size
// in deploy/nginx-recon.conf.
export const MAX_INVOICE_FILE_SIZE = 30 * 1024 * 1024; // 30 MB

// MIME types we accept. Anything outside this list is rejected.
export const ALLOWED_INVOICE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  // iPhones default to HEIC/HEIF. Accept them on the wire so phone
  // photos don't get rejected mid-upload; AI OCR still handles them
  // through Claude's vision endpoint.
  'image/heic',
  'image/heif',
  'application/pdf',
];

// Manual fields a user can supply at upload time (all optional).
// Once OCR is in place these will usually be filled in automatically.
export interface UploadInvoiceMeta {
  supplier?: string;
  invoiceNumber?: string;
  invoiceDate?: string; // ISO string from the multipart form
  total?: string;       // strings because they come from form-data
  vat?: string;
  currency?: string;
  category?: string;
  // Legacy single-store field (kept for old callers).
  storeAllocation?: string;
  // New multi-store field. Frontend sends this as a JSON string
  // because multipart/form-data doesn't natively serialise arrays.
  // Accepted forms: '["A","B"]' or "A,B" (comma-separated).
  storeAllocations?: string;
  notes?: string;
  // For UPLOADER role: which managed user this invoice is "for".
  // Ignored for other roles (invoice always belongs to current user).
  ownerId?: string;
  // Optional line splits — JSON-encoded array of {category, store, amount}.
  // When present, the invoice gets per-line breakdown rows created
  // after OCR. Sum is validated against the OCR'd total; mismatches
  // get the invoice flagged for review rather than rejected outright.
  splits?: string;
}

// Fields a user can update after creation.
// Critically, the OCR-extracted financial fields are NOT in this list —
// they're read-only unless the invoice is flagged requiresReview.
export interface UpdateInvoiceInput {
  category?: string;
  storeAllocation?: string;
  storeAllocations?: string[]; // edit-time also takes an array
  notes?: string;
  // Only allowed when requiresReview is true — enforced in the service:
  supplier?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  total?: number;
  vat?: number;
  subtotal?: number;
  // Refund / credit-note support.
  // kind: 'PURCHASE' (default) or 'REFUND' (credit note matching a
  // negative-amount statement line). Editing this is treated as a
  // metadata edit so UPLOADERs can request access through the normal
  // EditRequest flow.
  kind?: 'PURCHASE' | 'REFUND';
  // creditApplied: wallet/store credit deducted from the printed total
  // before matching against the statement. Treated as metadata too.
  creditApplied?: number;
}

// Filter shape for the list endpoint.
export interface ListInvoiceFilters {
  status?: ReconStatus;
  supplier?: string;
  requiresReview?: boolean;
  // Admin/REPORTING can narrow the list to invoices involving a
  // specific person — matched as owner (cardholder) OR uploader, so
  // the filter does what an admin expects: "show me everything that
  // touches Rehan", regardless of whether he uploaded it himself or
  // an assistant did. Ignored for non-privileged callers (they
  // already get a tight scope filter and can't widen it).
  // Name kept as `uploaderId` for backward compatibility with old
  // bookmarks; the semantic is now broader than just uploader.
  uploaderId?: string;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private prisma: PrismaService,
    private ocr: OcrService,
    private parser: InvoiceParserService,
    private currency: CurrencyService,
    private aiExtractor: AIInvoiceExtractorService,
    // forwardRef in case the recon engine ever depends back on invoices.
    @Inject(injectForwardRef(() => ReconciliationService))
    private recon: ReconciliationService,
  ) {}

  // List visible invoices.
  //   USER       → only their own (userId = currentUser.sub)
  //   REPORTING  → all
  //   ADMIN      → all
  async list(filters: ListInvoiceFilters = {}, currentUser: JwtUser) {
    // Per-role visibility:
    //   ADMIN / REPORTING  → see everything
    //   UPLOADER           → see ONLY invoices they uploaded
    //   USER               → see ONLY invoices where they are the owner
    // Per-role visibility scope. Non-privileged callers always get a
    // narrow scope they can't widen. Privileged callers get the
    // explicit person filter (if any), applied as owner-OR-uploader so
    // legacy invoices with a null uploaderId still match.
    let scopeFilter: Prisma.InvoiceWhereInput = {};
    if (currentUser.role === Role.UPLOADER) {
      scopeFilter = { uploaderId: currentUser.sub };
    } else if (!isPrivileged(currentUser.role)) {
      scopeFilter = { userId: currentUser.sub };
    } else if (filters.uploaderId) {
      scopeFilter = {
        OR: [
          { userId: filters.uploaderId },
          { uploaderId: filters.uploaderId },
        ],
      };
    }

    return this.prisma.invoice.findMany({
      where: {
        status: filters.status,
        requiresReview: filters.requiresReview,
        supplier: filters.supplier
          ? { contains: filters.supplier, mode: 'insensitive' }
          : undefined,
        ...scopeFilter,
      },
      orderBy: { createdAt: 'desc' },
      // Surface uploader + owner so the admin invoices list can show
      // "uploaded by X for Y" when they differ.
      include: {
        uploader: { select: { id: true, name: true, email: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async getById(id: string, currentUser?: JwtUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        transaction: {
          // Include all invoices stacked on the same transaction so the
          // detail page can show "this is part of a split with X, Y".
          include: {
            invoices: {
              select: {
                id: true,
                supplier: true,
                total: true,
                totalZAR: true,
                currency: true,
              },
            },
          },
        },
        uploader: { select: { id: true, name: true, email: true } },
        user: { select: { id: true, name: true, email: true } },
        // Line-item splits (multi-category invoices). Sorted client-side.
        splits: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }

    if (currentUser && !isPrivileged(currentUser.role)) {
      // UPLOADER can only see invoices they themselves uploaded.
      if (currentUser.role === Role.UPLOADER) {
        if (invoice.uploaderId !== currentUser.sub) {
          throw new NotFoundException(`Invoice ${id} not found`);
        }
      } else {
        // USER role: must own the invoice.
        if (invoice.userId !== currentUser.sub) {
          throw new NotFoundException(`Invoice ${id} not found`);
        }
      }
    }

    return invoice;
  }

  // Create an invoice from an uploaded file. Runs OCR + parsing
  // synchronously when the file is OCR-able, so the response already
  // contains extracted fields. PDFs skip OCR for now (Tesseract can't
  // read them natively).
  //
  // Manual `meta` values always win over OCR — that's how a user
  // overrides bad extraction at upload time.
  async createFromUpload(
    file: Express.Multer.File,
    meta: UploadInvoiceMeta,
    currentUser: JwtUser,
  ) {
    // ---- Resolve owner vs uploader ----
    // For self-uploads (USER, REPORTING, ADMIN) these are the same.
    // For UPLOADER, the form provides `ownerId` — the managed user
    // whose card this receipt belongs to. We validate they're permitted.
    let ownerId = currentUser.sub;
    const uploaderId = currentUser.sub;

    if (currentUser.role === Role.UPLOADER) {
      if (!meta.ownerId) {
        fs.unlinkSync(file.path);
        throw new BadRequestException(
          'Assistant uploaders must select which user the invoice is for.',
        );
      }
      // Confirm the target user is in this uploader's allowed list.
      const me = await this.prisma.user.findUnique({
        where: { id: currentUser.sub },
        select: { managedUserIds: true },
      });
      if (!me || !me.managedUserIds.includes(meta.ownerId)) {
        fs.unlinkSync(file.path);
        throw new ForbiddenException(
          'You are not authorised to upload invoices for that user.',
        );
      }
      ownerId = meta.ownerId;
    }

    if (!ALLOWED_INVOICE_MIME_TYPES.includes(file.mimetype)) {
      fs.unlinkSync(file.path);
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}`,
      );
    }

    // ---- Step 1: Extract fields from the file ----
    //
    // Two pipelines available:
    //   1. AI extractor (Claude vision)  — used when ANTHROPIC_API_KEY
    //      is configured. Does OCR + parsing in one call. ~5% error
    //      rate on real-world receipts. ~R0.04 per invoice.
    //   2. Tesseract / pdf-parse + regex — the existing pipeline.
    //      Free, no external dependency, ~30% error rate on photos.
    //
    // We prefer (1) when available because the quality jump is dramatic.
    // If the AI call fails for any reason we fall back to (2) so the
    // upload never breaks just because the API is flaky.
    let ocrText: string | null = null;
    let ocrConfidence = 0;
    let parsedSupplier: string | null = null;
    let parsedInvoiceNumber: string | null = null;
    let parsedInvoiceDate: Date | null = null;
    let parsedTotal: number | null = null;
    let parsedSubtotal: number | null = null;
    let parsedVat: number | null = null;
    let parsedCurrency: 'ZAR' | 'USD' | 'EUR' | 'GBP' | 'CNY' | 'JPY' |
      'SAR' | 'AED' | 'AUD' | 'CAD' | 'INR' = 'ZAR';
    let criticalFieldsFound = true;
    let extractionSource: 'ai' | 'tesseract' | 'none' = 'none';

    // --- Path 1: AI extractor ---
    if (
      this.aiExtractor.isAvailable() &&
      this.aiExtractor.canExtract(file.mimetype)
    ) {
      try {
        const ai = await this.aiExtractor.extract(file.path, file.mimetype);
        ocrText = ai.rawText;
        ocrConfidence = ai.confidence;
        parsedSupplier = ai.supplier;
        parsedInvoiceNumber = ai.invoiceNumber;
        parsedInvoiceDate = ai.invoiceDate;
        parsedTotal = ai.total;
        parsedSubtotal = ai.subtotal;
        parsedVat = ai.vat;
        parsedCurrency = ai.currency;
        criticalFieldsFound = CRITICAL_FIELDS.every(
          (f) => ai.fieldsFound[f],
        );
        extractionSource = 'ai';
        this.logger.log(
          `AI extraction succeeded — confidence ${(ai.confidence * 100).toFixed(0)}%`,
        );
      } catch (err) {
        this.logger.warn(
          `AI extraction failed, falling back to OCR: ${(err as Error).message}`,
        );
      }
    }

    // --- Path 2: Tesseract / pdf-parse fallback ---
    if (extractionSource === 'none' && this.ocr.canOcr(file.mimetype)) {
      try {
        const ocrResult = await this.ocr.recognize(file.path, file.mimetype);
        ocrText = ocrResult.text;
        ocrConfidence = ocrResult.confidence;

        const parsed = this.parser.parse(ocrResult.text);
        parsedSupplier = parsed.supplier;
        parsedInvoiceNumber = parsed.invoiceNumber;
        parsedInvoiceDate = parsed.invoiceDate;
        parsedTotal = parsed.total;
        parsedSubtotal = parsed.subtotal;
        parsedVat = parsed.vat;
        parsedCurrency = parsed.currency;

        criticalFieldsFound = CRITICAL_FIELDS.every(
          (f) => parsed.fieldsFound[f],
        );
        extractionSource = 'tesseract';
      } catch (err) {
        this.logger.error(
          `OCR failed for ${file.path}: ${(err as Error).message}`,
        );
      }
    } else if (extractionSource === 'none') {
      this.logger.log(
        `No extractor available for ${file.mimetype}`,
      );
    }

    // ---- Step 2: Decide requiresReview ----
    const requiresReview =
      ocrConfidence < OCR_CONFIDENCE_THRESHOLD || !criticalFieldsFound;

    // ---- Step 3: Resolve final field values ----
    // Precedence: manual meta > OCR result > placeholder/zero.
    const finalSupplier =
      meta.supplier ?? parsedSupplier ?? 'Pending review';
    const finalInvoiceNumber = meta.invoiceNumber ?? parsedInvoiceNumber;
    const finalInvoiceDate = meta.invoiceDate
      ? new Date(meta.invoiceDate)
      : (parsedInvoiceDate ?? new Date());
    const finalTotal =
      meta.total !== undefined ? parseFloat(meta.total) : (parsedTotal ?? 0);
    const finalSubtotal = parsedSubtotal ?? 0;
    const finalVat =
      meta.vat !== undefined ? parseFloat(meta.vat) : (parsedVat ?? 0);
    // Manual currency override beats parser auto-detection.
    // We trust the dropdown value; the union narrows it.
    const finalCurrency = (
      meta.currency && isKnownCurrency(meta.currency)
        ? meta.currency
        : parsedCurrency
    ) as typeof parsedCurrency;

    // Convert to ZAR for reconciliation matching against bank
    // transactions, using the rate that was actually in effect on
    // the invoice date (not today's rate). Falls through to the
    // current configured rate for SAR/AED or when the historical
    // API is unreachable — source is logged either way.
    const {
      amount: finalTotalZAR,
      rate: finalRate,
      source: finalRateSource,
    } = await this.currency.toZARAtDate(
      finalTotal,
      finalCurrency,
      finalInvoiceDate,
    );
    if (finalRateSource === 'fallback') {
      this.logger.warn(
        `Invoice ${finalSupplier} (${finalCurrency}) dated ${finalInvoiceDate.toISOString().slice(0, 10)} used current-rate fallback — no historical rate available.`,
      );
    }

    // ---- Step 4: Save ----
    const created = await this.prisma.invoice.create({
      data: {
        supplier: finalSupplier,
        invoiceNumber: finalInvoiceNumber,
        invoiceDate: finalInvoiceDate,
        total: finalTotal,
        subtotal: finalSubtotal,
        vat: finalVat,
        currency: finalCurrency,
        totalZAR: finalTotalZAR,
        exchangeRate: finalRate,

        category: meta.category ?? null,
        storeAllocation: meta.storeAllocation ?? null,
        notes: meta.notes ?? null,

        ocrConfidence,
        requiresReview,
        ocrRawText: ocrText,

        filePath: path.basename(file.path),
        fileMimeType: file.mimetype,

        status: ReconStatus.PENDING,

        userId: ownerId,
        uploaderId,
      },
    });

    // Persist any upload-time line splits the user entered. We accept
    // them as a JSON string on the multipart form. If parsing fails or
    // the sum doesn't match the OCR'd total within 1c, the invoice
    // gets flagged for review (rather than rejected) — the splits
    // still get saved so the operator can fix them on the detail page.
    if (meta.splits) {
      try {
        const parsed = JSON.parse(meta.splits);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const clean = parsed
            .filter(
              (s: { category?: string; amount?: number }) =>
                s && typeof s.category === 'string' && s.category.trim() &&
                typeof s.amount === 'number' && s.amount > 0,
            )
            .map((s: { category: string; store?: string | null; amount: number }, idx: number) => ({
              invoiceId: created.id,
              category: s.category.trim(),
              store: s.store?.toString().trim() || null,
              amount: s.amount,
              sortOrder: idx,
            }));
          if (clean.length > 0) {
            await this.prisma.invoiceSplit.createMany({ data: clean });
            const sum = clean.reduce(
              (acc: number, s: { amount: number }) => acc + s.amount,
              0,
            );
            // Sanity check: split total should equal invoice total. If
            // off by more than 1c, flag for review so the operator
            // notices and fixes on the detail page.
            if (Math.abs(sum - finalTotal) > 0.01) {
              await this.prisma.invoice.update({
                where: { id: created.id },
                data: { requiresReview: true },
              });
              this.logger.warn(
                `Invoice ${created.id}: split sum R ${sum.toFixed(2)} doesn't match total R ${finalTotal.toFixed(2)} — flagged for review`,
              );
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          `Invoice ${created.id}: failed to parse upload-time splits: ${(err as Error).message}`,
        );
      }
    }

    // Auto-match the newly created invoice against the unmatched
    // transaction pool. Async-safe: any failure logs and continues —
    // the upload still succeeds with PENDING status, and the user
    // can always click "Run Reconciliation" later.
    try {
      const result = await this.recon.matchSingleInvoice(created.id);
      if (result.matched) {
        this.logger.log(
          `Invoice ${created.id} auto-matched (score ${result.score?.toFixed(2)})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Auto-match failed for invoice ${created.id}: ${(err as Error).message}`,
      );
    }

    // Re-load so the caller sees the matched state if it happened.
    return this.prisma.invoice.findUnique({ where: { id: created.id } });
  }

  // Re-run OCR + parsing on an existing invoice's file. Useful when the
  // first OCR result was bad and you want to try again (maybe after
  // tuning the parser regexes).
  //
  // Permission: owner or any privileged role (REPORTING/ADMIN).
  async rescan(id: string, currentUser: JwtUser) {
    const invoice = await this.getById(id, currentUser);

    if (
      !isPrivileged(currentUser.role) &&
      invoice.userId !== currentUser.sub
    ) {
      throw new ForbiddenException('You cannot rescan this invoice.');
    }

    if (!invoice.filePath) {
      throw new BadRequestException('Invoice has no file to rescan');
    }
    if (!invoice.fileMimeType || !this.ocr.canOcr(invoice.fileMimeType)) {
      throw new BadRequestException(
        `Cannot OCR file of type ${invoice.fileMimeType}`,
      );
    }

    const absolutePath = path.join(
      process.cwd(),
      'uploads',
      invoice.filePath,
    );

    // Same precedence as createFromUpload: try AI first, fall back to OCR.
    let extracted: {
      supplier: string | null;
      invoiceNumber: string | null;
      invoiceDate: Date | null;
      total: number | null;
      subtotal: number | null;
      vat: number | null;
      currency: typeof invoice.currency extends string ? any : never;
      confidence: number;
      rawText: string;
      fieldsFound: { supplier: boolean; total: boolean; vat: boolean; invoiceNumber: boolean; invoiceDate: boolean };
    } | null = null;

    const mt = invoice.fileMimeType ?? undefined;

    if (mt && this.aiExtractor.isAvailable() && this.aiExtractor.canExtract(mt)) {
      try {
        const ai = await this.aiExtractor.extract(absolutePath, mt);
        extracted = ai;
      } catch (err) {
        this.logger.warn(
          `Rescan AI failed, falling back to OCR: ${(err as Error).message}`,
        );
      }
    }

    if (!extracted) {
      const ocrResult = await this.ocr.recognize(absolutePath, mt);
      const parsed = this.parser.parse(ocrResult.text);
      extracted = {
        supplier: parsed.supplier,
        invoiceNumber: parsed.invoiceNumber,
        invoiceDate: parsed.invoiceDate,
        total: parsed.total,
        subtotal: parsed.subtotal,
        vat: parsed.vat,
        currency: parsed.currency,
        confidence: ocrResult.confidence,
        rawText: ocrResult.text,
        fieldsFound: parsed.fieldsFound,
      };
    }

    const criticalFieldsFound = CRITICAL_FIELDS.every(
      (f) => extracted!.fieldsFound[f],
    );
    const requiresReview =
      extracted.confidence < OCR_CONFIDENCE_THRESHOLD ||
      !criticalFieldsFound;

    // Re-convert to ZAR. Use the historical rate for the invoice
    // date so a rescan months later doesn't quietly shift the
    // matching ZAR amount by re-applying today's FX.
    const newTotal = extracted.total ?? invoice.total;
    const newCurrency = extracted.currency;
    const newInvoiceDate = extracted.invoiceDate ?? invoice.invoiceDate;
    const { amount: newTotalZAR, rate: newRate } =
      await this.currency.toZARAtDate(newTotal, newCurrency, newInvoiceDate);

    return this.prisma.invoice.update({
      where: { id },
      data: {
        supplier: extracted.supplier ?? invoice.supplier,
        invoiceNumber: extracted.invoiceNumber ?? invoice.invoiceNumber,
        invoiceDate: extracted.invoiceDate ?? invoice.invoiceDate,
        total: newTotal,
        subtotal: extracted.subtotal ?? invoice.subtotal,
        vat: extracted.vat ?? invoice.vat,
        currency: newCurrency,
        totalZAR: newTotalZAR,
        exchangeRate: newRate,
        ocrConfidence: extracted.confidence,
        ocrRawText: extracted.rawText,
        requiresReview,
      },
    });
  }

  // Update an invoice. Permission matrix:
  //
  //   Metadata fields (category/storeAllocation/notes):
  //     - ADMIN/REPORTING can always edit
  //     - Owner (USER) can always edit
  //     - UPLOADER can edit ONLY when metadataUnlockedUntil is active
  //       AND they are the original uploader of this invoice
  //
  //   Financial fields (supplier/invoiceNumber/invoiceDate/total/vat/subtotal):
  //     - ADMIN can always edit
  //     - Owner can edit when EITHER requiresReview is true (OCR failed)
  //       OR editUnlockedUntil is in the future (admin approved a request)
  //     - UPLOADER cannot edit financials, period.
  //     - When an unlock is consumed by saving, the unlock is cleared.
  async update(id: string, input: UpdateInvoiceInput, currentUser: JwtUser) {
    const invoice = await this.getById(id, currentUser);
    const isOwner = invoice.userId === currentUser.sub;
    const isAdmin = currentUser.role === 'ADMIN';
    const isReporting = currentUser.role === 'REPORTING';
    const isUploaderOfThis =
      currentUser.role === Role.UPLOADER &&
      invoice.uploaderId === currentUser.sub;

    // Amounts (total / VAT / subtotal) are LOCKED for everyone, all
    // the time. They must match what was on the original invoice or
    // statement — no role, not even ADMIN, can edit them through the
    // API. If the OCR captured them wrong, the workflow is delete +
    // re-upload, not edit-in-place. Rejecting up-front means no
    // client can sneak an amount change in through a manual PATCH.
    if (
      input.total !== undefined ||
      input.vat !== undefined ||
      input.subtotal !== undefined
    ) {
      throw new ForbiddenException(
        'Invoice amounts (total, VAT, subtotal) cannot be edited. They must match the original invoice. If the OCR captured them incorrectly, delete the invoice and re-upload.',
      );
    }

    // After amount-locking, "financials" here means the remaining
    // OCR-extracted fields: supplier name, invoice number, invoice
    // date. Those CAN still be edited (under the same unlock rules
    // as before), since they're text/dates rather than money figures.
    const editingFinancials =
      input.supplier !== undefined ||
      input.invoiceNumber !== undefined ||
      input.invoiceDate !== undefined;

    const editingMetadata =
      input.category !== undefined ||
      input.storeAllocation !== undefined ||
      input.notes !== undefined ||
      // kind + creditApplied are accounting flags rather than amounts
      // (the printed total stays untouched), so they go through the
      // metadata unlock path rather than the financial one.
      input.kind !== undefined ||
      input.creditApplied !== undefined;

    // Metadata permission. UPLOADER needs an active metadata unlock;
    // everyone else (owner/admin/reporting) edits freely.
    let consumesMetaUnlock = false;
    if (editingMetadata) {
      const now = new Date();
      const metaUnlockActive =
        invoice.metadataUnlockedUntil != null &&
        invoice.metadataUnlockedUntil > now;

      if (isAdmin || isReporting || isOwner) {
        // Free metadata edits — no unlock consumption.
      } else if (isUploaderOfThis && metaUnlockActive) {
        consumesMetaUnlock = true;
      } else if (isUploaderOfThis) {
        throw new ForbiddenException(
          'Metadata on this invoice is sealed. Request edit access from an admin first.',
        );
      } else {
        throw new ForbiddenException('You cannot edit this invoice.');
      }
    }

    // Financial permission: ADMIN always; owner only if requiresReview
    // or current editUnlockedUntil is in the future. UPLOADER never.
    let consumesUnlock = false;
    if (editingFinancials) {
      const now = new Date();
      const unlockActive =
        invoice.editUnlockedUntil != null &&
        invoice.editUnlockedUntil > now;

      if (isAdmin) {
        // Admin can always edit financials.
      } else if (isOwner && (invoice.requiresReview || unlockActive)) {
        // Owner is allowed; if it's an unlock-based edit, consume it.
        consumesUnlock = unlockActive;
      } else if (isOwner && !invoice.requiresReview && !unlockActive) {
        throw new ForbiddenException(
          'This invoice is sealed. Request edit access from an admin first.',
        );
      } else {
        throw new ForbiddenException(
          'Only the owner (with admin approval) or an admin can edit financial fields.',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // If a financial unlock is being consumed, mark APPROVED FINANCIAL
      // requests for this invoice as USED.
      if (consumesUnlock) {
        await tx.editRequest.updateMany({
          where: {
            invoiceId: id,
            status: 'APPROVED',
            type: 'FINANCIAL',
          },
          data: { status: 'USED' },
        });
      }
      // Same for metadata unlock — mark METADATA requests as USED.
      if (consumesMetaUnlock) {
        await tx.editRequest.updateMany({
          where: {
            invoiceId: id,
            status: 'APPROVED',
            type: 'METADATA',
          },
          data: { status: 'USED' },
        });
      }

      return tx.invoice.update({
        where: { id },
        data: {
          category: input.category,
          storeAllocation: input.storeAllocation,
          notes: input.notes,
          // Refund/credit-note fields. Pass through when supplied.
          kind: input.kind,
          creditApplied:
            input.creditApplied !== undefined
              ? Math.max(0, input.creditApplied)
              : undefined,
          supplier: input.supplier,
          invoiceNumber: input.invoiceNumber,
          invoiceDate: input.invoiceDate
            ? new Date(input.invoiceDate)
            : undefined,
          // total / vat / subtotal are intentionally NOT in this set —
          // they're rejected at the top of the method so they never
          // reach the database.
          // Clear requiresReview when the human edits supplier/number/date.
          requiresReview: editingFinancials ? false : undefined,
          // Clear the financial unlock when consumed (or when admin edits).
          editUnlockedUntil:
            consumesUnlock || (editingFinancials && isAdmin) ? null : undefined,
          // Clear the metadata unlock when consumed.
          metadataUnlockedUntil: consumesMetaUnlock ? null : undefined,
        },
      });
    });
  }

  // Replace all line-item splits on an invoice in one atomic call.
  // The frontend sends the full final list; we delete the existing
  // splits and re-create them — simpler than diffing.
  //
  // Validation:
  //   - sum of split.amount must equal invoice.total (within R 0.01)
  //   - splits with amount <= 0 are rejected
  //   - category is required on every split, store is optional
  //   - passing an empty array clears the splits (back to single-category)
  async setSplits(
    invoiceId: string,
    splits: Array<{ category: string; store?: string | null; amount: number }>,
    currentUser: JwtUser,
  ) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }

    // Ownership: UPLOADERs and USERs can only edit their own invoices.
    // Admin/Reporting can edit any (used for corrections).
    if (!isPrivileged(currentUser.role)) {
      const isOwner = invoice.userId === currentUser.sub;
      const isUploader =
        currentUser.role === Role.UPLOADER &&
        invoice.uploaderId === currentUser.sub;
      if (!isOwner && !isUploader) {
        throw new ForbiddenException('You cannot edit this invoice.');
      }
    }

    // Empty array = clear splits (revert to single-category invoice).
    if (splits.length === 0) {
      await this.prisma.invoiceSplit.deleteMany({
        where: { invoiceId },
      });
      return { splits: [], cleared: true };
    }

    // Validate each row.
    for (const s of splits) {
      if (!s.category || s.category.trim().length === 0) {
        throw new BadRequestException('Each split must have a category.');
      }
      if (typeof s.amount !== 'number' || isNaN(s.amount) || s.amount <= 0) {
        throw new BadRequestException(
          'Each split amount must be a positive number.',
        );
      }
    }

    // Splits must sum to invoice total (1 cent tolerance for rounding).
    const sum = splits.reduce((acc, s) => acc + s.amount, 0);
    if (Math.abs(sum - invoice.total) > 0.01) {
      throw new BadRequestException(
        `Split lines must sum to invoice total. Invoice total = ${invoice.total.toFixed(2)}, splits sum = ${sum.toFixed(2)}.`,
      );
    }

    // Atomic replace: wipe existing splits and create the new set.
    return this.prisma.$transaction(async (tx) => {
      await tx.invoiceSplit.deleteMany({ where: { invoiceId } });
      const created = await tx.invoiceSplit.createMany({
        data: splits.map((s, idx) => ({
          invoiceId,
          category: s.category.trim(),
          store: s.store?.trim() || null,
          amount: s.amount,
          sortOrder: idx,
        })),
      });
      const rows = await tx.invoiceSplit.findMany({
        where: { invoiceId },
        orderBy: { sortOrder: 'asc' },
      });
      return { splits: rows, count: created.count };
    });
  }

  async delete(id: string, currentUser: JwtUser) {
    const invoice = await this.getById(id, currentUser);

    // USER can only delete their own AND only if not matched yet.
    if (!isPrivileged(currentUser.role)) {
      if (invoice.userId !== currentUser.sub) {
        throw new ForbiddenException('You cannot delete this invoice.');
      }
      if (invoice.transactionId) {
        throw new ForbiddenException(
          'Cannot delete a matched invoice. Unlink it first.',
        );
      }
    } else if (currentUser.role === 'REPORTING') {
      throw new ForbiddenException(
        'REPORTING users cannot delete invoices.',
      );
    }

    if (invoice.filePath) {
      const abs = path.join(process.cwd(), 'uploads', invoice.filePath);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }

    return this.prisma.invoice.delete({ where: { id } });
  }

  async getFilePath(
    id: string,
    currentUser: JwtUser,
  ): Promise<{ absolutePath: string; mimeType: string }> {
    const invoice = await this.getById(id, currentUser);

    if (!invoice.filePath) {
      throw new NotFoundException('Invoice has no attached file');
    }

    const absolutePath = path.join(process.cwd(), 'uploads', invoice.filePath);

    if (!fs.existsSync(absolutePath)) {
      throw new NotFoundException(
        'Invoice file is missing on disk — was it deleted manually?',
      );
    }

    return {
      absolutePath,
      mimeType: invoice.fileMimeType ?? 'application/octet-stream',
    };
  }
}

// Validates a string against our supported Currency union. Used when
// the user manually overrides currency at upload time — we don't want
// to trust arbitrary strings landing in the DB.
const KNOWN_CURRENCIES = new Set([
  'ZAR', 'USD', 'GBP', 'EUR',
  'CNY', 'JPY', 'SAR', 'AED',
  'AUD', 'CAD', 'INR',
]);
function isKnownCurrency(c: string): boolean {
  return KNOWN_CURRENCIES.has(c.toUpperCase());
}
