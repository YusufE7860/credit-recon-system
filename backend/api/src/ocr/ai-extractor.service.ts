import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { SettingsService } from '../settings/settings.service';
import type { Currency } from './currency.service';

// Mime types Claude vision can read directly.
const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const SUPPORTED_PDF_MIMES = ['application/pdf'];

// What the AI returns — same shape as ParsedInvoice so callers can
// drop it in as a replacement.
export interface AIExtractedInvoice {
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  total: number | null;
  subtotal: number | null;
  vat: number | null;
  currency: Currency;
  confidence: number;        // 0..1, AI's self-reported confidence
  rawText: string;           // full JSON response, stored for audit
  fieldsFound: {
    supplier: boolean;
    invoiceNumber: boolean;
    invoiceDate: boolean;
    total: boolean;
    vat: boolean;
  };
}

// Instructions the AI gets every call. Designed for JSON-only output
// so we never have to strip markdown fences or chatty preambles.
//
// Optimised for the wide variety of South African business documents
// we receive: digital invoices (Stripe/Xero/QuickBooks), thermal till
// slips (Pick n Pay/Shoprite/Checkers/Spar), fuel slips (Engen/Shell/
// BP/Total/Sasol), restaurant bills, toll-plaza receipts, handwritten
// spaza notes, and forex purchase invoices.
const SYSTEM_PROMPT = `You extract structured fields from invoices and receipts. Return ONLY a JSON object — no markdown fences, no commentary.

Output schema:
{
  "supplier": string | null,
  "invoiceNumber": string | null,
  "invoiceDate": string | null,           // ISO YYYY-MM-DD
  "total": number | null,                 // the final amount due/paid
  "subtotal": number | null,
  "vat": number | null,
  "currency": "ZAR" | "USD" | "GBP" | "EUR" | "CNY" | "JPY" | "SAR" | "AED" | "AUD" | "CAD" | "INR",
  "confidence": number                    // 0..1, your honest confidence
}

## Document-type guidance

This input could be ANY of the following. Adapt accordingly:

**Digital invoices** (Stripe, Xero, QuickBooks, Sage, etc.)
- Supplier is in the sender block, NOT the "Bill to" recipient.
- Invoice number labelled clearly. Look for "Invoice number", "Invoice #", "Tax Invoice #".

**Garage / fuel slips** (Engen, Shell, BP, Total, Sasol, Caltex)
- Supplier = brand + station name if visible (e.g. "Engen Bryanston" → "Engen Bryanston", or just "Engen" if location absent).
- Total = the "TOTAL" or "AMOUNT" line, NOT the per-litre rate. Ignore "PUMP", "LITRES", "RATE".
- Invoice/receipt number = transaction or auth code. Skip pump numbers.

**Restaurant / cafe bills**
- Supplier = restaurant name (top of receipt).
- Total = "TOTAL" / "AMOUNT DUE" / "GRAND TOTAL". If a tip line exists and an INCLUSIVE total is shown, use the inclusive total. Otherwise the pre-tip total.
- Skip "Table", "Server", "Guests" — these aren't fields you need.

**Toll booth receipts** (SANRAL, Bake's, Tugela, Mooi, etc.)
- Supplier = plaza name (e.g. "Tugela Plaza").
- Often just a tiny slip — date, plaza, amount. invoiceNumber may be a vehicle-class code; if no clear receipt number, leave it null.

**Shop till slips** (Pick n Pay, Shoprite, Checkers, Spar, Woolworths, Pep, Mr Price, Takealot pickup slips)
- Supplier = store name + branch if printed (e.g. "Pick n Pay Hyper Westville").
- Total = final "TOTAL" line. NOT "Subtotal", "Change", "Cash tendered", or per-item prices.
- Skip till numbers, cashier numbers, loyalty card numbers — these are not invoice numbers.
- Receipt number: usually a transaction ID at the bottom (e.g. "Trans: 12345" or "TXN# 6789").

**Handwritten notes / informal receipts**
- Often just supplier scrawled at top + amount + signature.
- Extract what you can. Set confidence ≤ 0.5 because handwriting is uncertain.
- If the date is missing, leave it null (don't guess).

**Forex / foreign invoices**
- Currency from symbol/code. "$" with no other context = USD. "£" = GBP. "€" = EUR.
- For Saudi (SAR), Emirati (AED), the code is usually printed in full.
- DO NOT convert to ZAR. Return the amount in its native currency.

## Universal rules

- supplier: the actual issuing business. Strip noise like "Page 1 of 1", "Invoice", "Receipt", "Tax Invoice", and "Bill to" recipient names.
- invoiceNumber: must contain at least one digit. Never return the words "number", "invoice", "receipt", "reference", "till", "cashier" themselves.
- invoiceDate: convert anything (1 Apr 2026, April 1, 2026, 01/04/2026, 2026-04-01) to ISO YYYY-MM-DD. Prefer "Date of issue" / "Invoice date" / "Issued" / "Receipt date" over "Due date" / "Period" / "Valid until".
- total: prefer "TOTAL DUE" > "GRAND TOTAL" > "AMOUNT DUE" > "TOTAL" > "AMOUNT PAID". Numeric only, no currency symbol.
- subtotal: amount before VAT. Null if the receipt only shows the inclusive total.
- vat: the VAT/tax amount (a Rand value, not a percentage). Zero if no VAT shown. Null if uncertain.
- currency: default ZAR ONLY when the receipt clearly looks South African (Rand symbol, .co.za supplier, ZA address). Otherwise infer from symbols/codes.
- confidence: be honest.
  - 0.95+: clean digital invoice, all fields obvious.
  - 0.7–0.9: standard thermal slip, all fields readable.
  - 0.4–0.7: faded / partial / angled photo, most fields readable.
  - <0.4: barely readable, missing critical fields, or handwritten and unclear.

If a field is unreadable or genuinely absent, use null — never invent values.`;

@Injectable()
export class AIInvoiceExtractorService {
  private readonly logger = new Logger(AIInvoiceExtractorService.name);
  private client: Anthropic | null = null;

  constructor(private settings: SettingsService) {}

  // True iff an API key is configured (in DB settings or env).
  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  // True iff this mime type can flow through the AI extractor.
  canExtract(mimeType: string): boolean {
    return (
      SUPPORTED_IMAGE_MIMES.includes(mimeType) ||
      SUPPORTED_PDF_MIMES.includes(mimeType)
    );
  }

  // Main entry. Tries the primary model first; if confidence is low or
  // any critical field is missing, retries with the fallback model
  // (Sonnet by default — slower but more accurate on messy receipts).
  //
  // Throws on hard failure; caller falls back to tesseract / pdf-parse.
  async extract(filePath: string, mimeType: string): Promise<AIExtractedInvoice> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('AI extractor: ANTHROPIC_API_KEY not configured');
    }
    if (!this.canExtract(mimeType)) {
      throw new Error(`AI extractor: unsupported mime type ${mimeType}`);
    }

    if (!this.client) this.client = new Anthropic({ apiKey });

    const fileBytes = fs.readFileSync(filePath);
    const base64 = fileBytes.toString('base64');
    const isPdf = SUPPORTED_PDF_MIMES.includes(mimeType);

    const fileBlock: Anthropic.ContentBlockParam = isPdf
      ? {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64,
          },
        }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
            data: base64,
          },
        };

    // Primary model — fast & cheap. Handles most receipts fine.
    const primaryModel = this.settings.getString(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'ai.model' as any,
      'claude-haiku-4-5-20251001',
    );

    const primary = await this.runExtraction(primaryModel, fileBlock, filePath);

    // Decide if we need to escalate. Two triggers:
    //   1) AI's own confidence is below the configured threshold
    //   2) Any of supplier/total/invoiceDate is missing — we can't recon
    //      against a transaction without those three
    const fallbackThreshold = this.settings.getNumber(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'ai.fallbackThreshold' as any,
      0.65,
    );
    const fallbackModel = this.settings.getString(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'ai.fallbackModel' as any,
      'claude-sonnet-4-6',
    );

    const criticalMissing =
      !primary.fieldsFound.supplier ||
      !primary.fieldsFound.total ||
      !primary.fieldsFound.invoiceDate;
    const needsFallback =
      primary.confidence < fallbackThreshold || criticalMissing;

    // No fallback configured, or no fallback needed → return primary.
    if (!needsFallback || !fallbackModel || fallbackModel === primaryModel) {
      return primary;
    }

    this.logger.log(
      `Escalating to ${fallbackModel} — primary confidence ${primary.confidence.toFixed(2)}, critical missing: ${criticalMissing}`,
    );

    try {
      const fallback = await this.runExtraction(fallbackModel, fileBlock, filePath);
      // Pick whichever has higher confidence AND more critical fields.
      const fallbackBetter =
        fallback.confidence > primary.confidence ||
        Object.values(fallback.fieldsFound).filter(Boolean).length >
          Object.values(primary.fieldsFound).filter(Boolean).length;
      return fallbackBetter ? fallback : primary;
    } catch (err) {
      this.logger.warn(
        `Fallback model failed, returning primary: ${(err as Error).message}`,
      );
      return primary;
    }
  }

  // One round-trip to Claude. Factored out so primary + fallback share it.
  private async runExtraction(
    model: string,
    fileBlock: Anthropic.ContentBlockParam,
    filePath: string,
  ): Promise<AIExtractedInvoice> {
    const start = Date.now();
    const response = await this.client!.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
            { type: 'text', text: 'Extract the invoice/receipt fields.' },
          ],
        },
      ],
    });
    const durationMs = Date.now() - start;
    const textBlock = response.content.find((b) => b.type === 'text');
    const rawText = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    this.logger.log(
      `AI extraction (${model}): ${durationMs}ms, ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`,
    );
    return this.parseResponse(rawText, filePath);
  }

  // ---------- Private helpers ----------

  private getApiKey(): string | undefined {
    // Setting overrides env. We deliberately don't define this in
    // SETTING_KEYS so passing the string here is safe (typed loosely).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fromSettings = this.settings.getString('ai.anthropicKey' as any, '');
    if (fromSettings) return fromSettings;
    return process.env.ANTHROPIC_API_KEY;
  }

  // Parse Claude's JSON response into our typed shape. Robust to a few
  // common deviations from the prompt (markdown fences, leading prose).
  private parseResponse(raw: string, filePath: string): AIExtractedInvoice {
    let cleaned = raw.trim();

    // Strip markdown fences if Claude returned them despite instructions.
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }

    // Find the first { and last } — handles a stray sentence before/after.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(
        `AI extractor: response was not JSON-shaped: ${raw.slice(0, 100)}...`,
      );
    }
    const jsonText = cleaned.slice(start, end + 1);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `AI extractor: invalid JSON — ${(err as Error).message}: ${jsonText.slice(0, 100)}`,
      );
    }

    // Coerce to our typed shape with safe defaults.
    const supplier = typeof parsed.supplier === 'string' ? parsed.supplier : null;
    const invoiceNumber =
      typeof parsed.invoiceNumber === 'string' ? parsed.invoiceNumber : null;
    const invoiceDate = parsed.invoiceDate
      ? this.parseISO(parsed.invoiceDate as string)
      : null;
    const total = typeof parsed.total === 'number' ? parsed.total : null;
    const subtotal = typeof parsed.subtotal === 'number' ? parsed.subtotal : null;
    const vat = typeof parsed.vat === 'number' ? parsed.vat : null;
    const currency = this.coerceCurrency(parsed.currency);
    const confidence =
      typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;

    return {
      supplier,
      invoiceNumber,
      invoiceDate,
      total,
      subtotal,
      vat,
      currency,
      confidence,
      rawText: `[AI extraction via Claude]\nFile: ${path.basename(filePath)}\n\n${jsonText}`,
      fieldsFound: {
        supplier: supplier !== null,
        invoiceNumber: invoiceNumber !== null,
        invoiceDate: invoiceDate !== null,
        total: total !== null,
        vat: vat !== null,
      },
    };
  }

  private parseISO(s: string): Date | null {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  private coerceCurrency(v: unknown): Currency {
    const allowed: Currency[] = [
      'ZAR', 'USD', 'EUR', 'GBP', 'CNY', 'JPY',
      'SAR', 'AED', 'AUD', 'CAD', 'INR',
    ];
    if (typeof v === 'string' && allowed.includes(v.toUpperCase() as Currency)) {
      return v.toUpperCase() as Currency;
    }
    return 'ZAR';
  }
}
