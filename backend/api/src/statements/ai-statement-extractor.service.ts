import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { SettingsService } from '../settings/settings.service';
import { PdfParserService } from './pdf-parser.service';

// AI-driven credit-card statement parser — chunked per card section.
//
// Architecture:
//   1. Regex parser (PdfParserService.extractRawSections) finds every
//      card header in the PDF and gives us the raw text lines between
//      each header pair. Regex is reliable at finding boundaries even
//      when it fumbles individual transaction row parsing.
//   2. For each card section (usually 5–30 rows of text), we make a
//      small AI call to Haiku that extracts clean structured rows.
//   3. All section calls run in parallel with a small concurrency cap
//      so we don't hammer the API rate limit.
//   4. Statement-level metadata (bankStatedTotal, periodStart etc.)
//      comes from the regex parser too — no separate AI call needed.
//
// Why chunked instead of whole-PDF?
//   - A 36-card statement produces 40–60k output tokens in one call.
//     That trips the SDK's "may take >10 min" streaming requirement,
//     is slow (3–5 minutes), and exposes us to prompt drift where the
//     AI leaks in Expense Summary rows or bookkeeping lines.
//   - Per section: ~500 tokens in, ~2000 tokens out, ~3–5s. 36 sections
//     in parallel take ~10s wall time. Cheaper too — Haiku is 20x
//     cheaper than Sonnet for the same job.
//
// Row classification the model produces (schema unchanged):
//   PURCHASE | REFUND | FEE | PAYMENT | ADVANCE | INTEREST | OTHER

export type StatementRowKind =
  | 'PURCHASE'
  | 'REFUND'
  | 'FEE'
  | 'PAYMENT'
  | 'ADVANCE'
  | 'INTEREST'
  | 'OTHER';

export interface AIStatementRow {
  date: string;          // ISO YYYY-MM-DD
  merchant: string;
  location: string | null;
  amount: number;        // POSITIVE for purchase/fee/interest, NEGATIVE for refund/payment/advance
  kind: StatementRowKind;
}

export interface AIStatementCard {
  last4: string;
  maskedNumber: string;
  cardholderName: string;
  creditLimit: number | null;
  rows: AIStatementRow[];
}

export interface AIStatementResult {
  statementDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  parentAccount: string | null;
  bankStatedTotal: number | null;
  cards: AIStatementCard[];
  confidence: number;
  rawJson: string;
  warnings: string[];
}

// Per-card extraction prompt. Deliberately narrow: this call sees ONE
// card's raw text and returns its rows. No Expense Summary risk, no
// bookkeeping-row confusion — those live on other pages the model
// never sees on this call.
const CARD_SECTION_PROMPT = `You extract transaction rows from ONE card section of a South African FNB business credit card statement. Return ONLY a JSON array of rows — no wrapping object, no markdown fences, no commentary.

Each row schema:
{
  "date": string,          // ISO YYYY-MM-DD (use the year passed in the user message)
  "merchant": string,      // clean merchant name; multi-word merchants stay together (see rules)
  "location": string | null,  // suburb/city if separable, else null
  "amount": number,        // signed (see sign rules)
  "kind": "PURCHASE" | "REFUND" | "FEE" | "PAYMENT" | "ADVANCE" | "INTEREST" | "OTHER"
}

## Sign convention

Positive amounts INCREASE what the cardholder owes the bank:
  - PURCHASE, FEE, INTEREST → positive

Negative amounts DECREASE what the cardholder owes:
  - REFUND, PAYMENT, ADVANCE → negative

Never emit "Cr" suffixes, brackets, or currency symbols. Pure JSON numbers only.

## Merchant parsing (CRITICAL — this is where the regex parser fails)

FNB prints each row as columns:
    27 Aug Shell Protea Gardens                     Lenasia                             1 320.70          0.00

That's three columns: merchant name | location | amount | facility.
The merchant name can be MULTIPLE WORDS separated by spaces. Do NOT chop it after the first word.

Correct extraction:
  merchant: "Shell Protea Gardens", location: "Lenasia", amount: 1320.70

Common examples where the regex parser gets this wrong (fix them):
  - "Shell Protea Gardens" → merchant "Shell Protea Gardens" (not "Shell")
  - "The Bread Mill" → merchant "The Bread Mill" (not "The Bread")
  - "King Shaka Tapngo" → merchant "King Shaka Tapngo" (not "King")
  - "Admiral Platform" → merchant "Admiral Platform" (not "Admiral")
  - "Yoco *Ny Slice Flori" → merchant "Yoco *Ny Slice Flori" (leave the *)
  - "Anthropic* Claude Sub" → merchant "Anthropic* Claude Sub", location "Anthropic.Com", ignore trailing "CA" (that's the currency country code)
  - "Github, Inc. Github.Com" → merchant "Github, Inc.", location "Github.Com"

When a foreign-currency line follows (like "U.S. Dollar 180.00"), that's a continuation of the previous row — ignore it, don't emit a separate row for it.

## Kind classification

- PURCHASE: normal merchant charge
- REFUND: merchant reversal of a specific purchase (line labelled with the merchant + "Cr" suffix meaning reversal)
- FEE: bank charge — "service fee", "cash withdrawal fee", "slow payment fee", "VAT on fees", "int-pymt", "monthly card fee", "lounge access", "currency conversion fee"
- PAYMENT: the customer paying the card off ("Payment received", "EFT PAYMENT RECEIVED")
- ADVANCE: money loaded ONTO the card by the business so the cardholder can keep spending. Common wording:
    - "CASH ADVANCE"
    - "TRANSFER RECEIVED"
    - "TOP UP" / "LOAD" / "DEPOSIT"
    - **"1bb Fnb Ob Trf"** and any variant of it — this is FNB Online
      Banking Transfer, a top-up from the master account into the
      card. ALWAYS classify these as ADVANCE regardless of the trailing
      reference code. Amounts are Cr (credit / negative sign).
    - "OB TRF", "OB Trf", "Ob Trf", "Online Banking Transfer"
    - Any row that starts with "1bb" — that's FNB's internal transfer prefix
    - "FNB Transfer", "FNB TRF"
- INTEREST: "Interest charged"
- OTHER: use only when the row is unclassifiable — admin will review

## Rows to IGNORE (do NOT emit)

- The card header line "**** **** **** ####  - Limits" — that's metadata, not a row.
- The cardholder name line under the header.
- "Balance Brought Forward" — bookkeeping, not a transaction.
- "Balance Transferred" — a move of debt between cards on the same account. NOT a refund. NOT an advance. Skip entirely.
- "Card Total" — a rollup, not a row.
- Page footers with "8812 7100 5898" and "BUSINESS STATEMENT" — statement chrome.
- Continuation lines like "U.S. Dollar 23.00" or the cardholder's name repeated mid-section — these are metadata for the previous row.
- Any line with only a reference code and no amount — those are metadata.

## Dates

Dates print as "27 Aug" without the year. Use the year supplied in the user message. If a row is dated December while the rest are September, it's back-dated — that's fine, keep the December date but use the same year.

Return an empty array [] if the section has no real transactions.`;

@Injectable()
export class AIStatementExtractorService {
  private readonly logger = new Logger(AIStatementExtractorService.name);
  private client: Anthropic | null = null;
  // Cap parallel per-card AI calls so we don't hit Anthropic's rate limit
  // on a 36-card statement. 8 is comfortable for most orgs.
  private readonly CONCURRENCY = 8;

  constructor(
    private settings: SettingsService,
    private pdfParser: PdfParserService,
  ) {}

  isAvailable(): boolean {
    if (this.client) return true;
    const key = this.getApiKey();
    if (!key) return false;
    this.client = new Anthropic({ apiKey: key });
    return true;
  }

  async extract(pdfPath: string): Promise<AIStatementResult> {
    if (!this.isAvailable()) {
      throw new Error('AI statement extractor not configured (no API key)');
    }

    // Step 1 — regex-parse the PDF to find the card section boundaries
    // and the statement-level metadata. No AI here, no per-row parsing.
    const raw = await this.pdfParser.extractRawSections(pdfPath);
    if (raw.sections.length === 0) {
      throw new Error(
        'PDF has no recognizable card sections (regex found zero headers).',
      );
    }
    this.logger.log(
      `Chunked AI extraction: ${raw.sections.length} card sections to process`,
    );

    // Step 2 — pick model. Per-card calls are text-only and small, so
    // Haiku is the right default (fast, cheap). Admin can override.
    const model = this.settings.getString(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'ai.statementModel' as any,
      'claude-haiku-4-5-20251001',
    );

    const year =
      raw.statementDate?.getFullYear() ?? new Date().getFullYear();

    // Step 3 — extract every section in parallel with a concurrency cap.
    const start = Date.now();
    const cards = await this.mapWithConcurrency(
      raw.sections,
      this.CONCURRENCY,
      async (section) => {
        try {
          const rows = await this.extractSection(model, section, year);
          return {
            last4: section.last4,
            maskedNumber: section.maskedNumber,
            cardholderName: section.cardholderName,
            creditLimit: section.creditLimit,
            rows,
          };
        } catch (err) {
          this.logger.warn(
            `Section ${section.last4} (${section.cardholderName}) failed: ${(err as Error).message}`,
          );
          // Return the section with an empty row list rather than
          // failing the whole statement — statement-level fallback
          // will pick up the slack for this card.
          return {
            last4: section.last4,
            maskedNumber: section.maskedNumber,
            cardholderName: section.cardholderName,
            creditLimit: section.creditLimit,
            rows: [] as AIStatementRow[],
          };
        }
      },
    );
    const durationMs = Date.now() - start;
    const totalRows = cards.reduce((acc, c) => acc + c.rows.length, 0);
    this.logger.log(
      `Chunked AI extraction complete: ${durationMs}ms, ${totalRows} rows across ${cards.length} cards`,
    );

    return {
      statementDate: raw.statementDate
        ? raw.statementDate.toISOString().slice(0, 10)
        : null,
      // Periods: derive from min/max transaction date if the header
      // doesn't hand them to us. FNB doesn't print explicit period
      // boundaries in the header — the statement DATE is the closing
      // date and the period is the prior ~30 days.
      periodStart: null,
      periodEnd: raw.statementDate
        ? raw.statementDate.toISOString().slice(0, 10)
        : null,
      parentAccount: raw.parentAccount,
      bankStatedTotal: raw.bankStatedTotal,
      cards,
      confidence: 0.9,
      rawJson: JSON.stringify({ chunked: true, sections: cards.length }),
      warnings: [],
    };
  }

  // Extract one card section's rows via a single AI call.
  private async extractSection(
    model: string,
    section: {
      last4: string;
      cardholderName: string;
      rawText: string;
    },
    year: number,
  ): Promise<AIStatementRow[]> {
    const userMessage =
      `Card last4: ${section.last4}\n` +
      `Cardholder: ${section.cardholderName}\n` +
      `Year context for dates: ${year}\n\n` +
      `Section text:\n\n${section.rawText}`;

    const response = await this.client!.messages.create({
      model,
      max_tokens: 8000, // generous for a single card section
      system: CARD_SECTION_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const rawText = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    return this.parseRowsResponse(rawText, section.last4);
  }

  // Parse the AI's response into a row array. Robust to a leading
  // sentence, markdown fences, and a top-level object with a "rows"
  // key (models sometimes wrap despite instructions).
  private parseRowsResponse(raw: string, last4: string): AIStatementRow[] {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }
    // Find the first [ or { and last ] or }
    const bracketStart = cleaned.indexOf('[');
    const braceStart = cleaned.indexOf('{');
    let jsonText: string;
    if (bracketStart !== -1 && (braceStart === -1 || bracketStart < braceStart)) {
      const end = cleaned.lastIndexOf(']');
      jsonText = cleaned.slice(bracketStart, end + 1);
    } else if (braceStart !== -1) {
      const end = cleaned.lastIndexOf('}');
      jsonText = cleaned.slice(braceStart, end + 1);
    } else {
      throw new Error(
        `Card ${last4}: response was not JSON-shaped: ${raw.slice(0, 100)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `Card ${last4}: invalid JSON — ${(err as Error).message}`,
      );
    }

    // Accept either [rows...] or { rows: [...] }
    const rowsArray = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : [];

    const coerced: AIStatementRow[] = (rowsArray as Array<Record<string, unknown>>).map(
      (r) => ({
        date: typeof r.date === 'string' ? r.date : '',
        merchant:
          typeof r.merchant === 'string' ? r.merchant : 'Unknown merchant',
        location: typeof r.location === 'string' ? r.location : null,
        amount: typeof r.amount === 'number' ? r.amount : 0,
        kind:
          typeof r.kind === 'string' &&
          ['PURCHASE', 'REFUND', 'FEE', 'PAYMENT', 'ADVANCE', 'INTEREST', 'OTHER'].includes(
            r.kind,
          )
            ? (r.kind as StatementRowKind)
            : 'OTHER',
      }),
    );

    // Defensive scrub: the AI ignores our "skip these rows" instructions
    // maybe 15% of the time. Two categories of rewrites happen here:
    //   1. Bookkeeping rows the AI shouldn't have emitted (Balance
    //      Transferred, Payment Received) — dropped entirely.
    //   2. FNB Online Banking Transfer rows the AI mis-classifies as
    //      PURCHASE — reclassified as ADVANCE so the credit sign is
    //      preserved and CardAdvance records get created.
    const BOOKKEEPING_PATTERNS = [
      /balance\s*transfer/i,       // "Balance Transferred"
      /balance\s*brought\s*forward/i,
      /payment\s*received/i,       // "Payment Received - Thank you"
      /payment\s*-?\s*thank\s*you/i,
      /thank\s*you.*payment/i,
      /^payment$/i,
      /previous\s*balance/i,
      /credit\s*adjustment/i,
      /card\s*total/i,             // shouldn't reach here but paranoia
    ];
    // FNB Online Banking Transfer variants. These are top-ups from the
    // master account into the card — always ADVANCE.
    const FNB_TRANSFER_PATTERNS = [
      /^1bb\s+fnb/i,               // "1bb Fnb Ob Trf ..."
      /1bb\s*fnb\s*ob\s*trf/i,
      /fnb\s*ob\s*trf/i,
      /ob\s*trf/i,
      /online\s*banking\s*transfer/i,
      /fnb\s*(internal\s*)?transfer/i,
    ];
    return coerced
      .filter((r) => {
        const isBookkeeping = BOOKKEEPING_PATTERNS.some((re) =>
          re.test(r.merchant),
        );
        if (isBookkeeping) {
          this.logger.debug?.(
            `Filtered bookkeeping row: card ${last4} "${r.merchant}" R ${r.amount.toFixed(2)} (${r.kind})`,
          );
          return false;
        }
        return true;
      })
      .map((r) => {
        // If the row looks like an FNB internal transfer but the AI
        // didn't call it ADVANCE, rewrite it. Also force the amount
        // negative — these are always credits (Cr) on the statement.
        const isFnbTransfer = FNB_TRANSFER_PATTERNS.some((re) =>
          re.test(r.merchant),
        );
        if (isFnbTransfer && r.kind !== 'ADVANCE') {
          this.logger.debug?.(
            `Reclassified FNB transfer: card ${last4} "${r.merchant}" R ${r.amount.toFixed(2)} ${r.kind} → ADVANCE`,
          );
          return {
            ...r,
            kind: 'ADVANCE' as StatementRowKind,
            amount: r.amount > 0 ? -r.amount : r.amount,
          };
        }
        return r;
      });
  }

  // Small helper — process an array with bounded parallelism. Prevents
  // 36 simultaneous API calls on a big statement.
  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private getApiKey(): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fromSettings = this.settings.getString('ai.anthropicKey' as any, '');
    if (fromSettings) return fromSettings;
    return process.env.ANTHROPIC_API_KEY;
  }
}
