import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import { SettingsService } from '../settings/settings.service';

// AI-driven credit-card statement parser.
//
// Sends the full statement PDF to Claude vision and gets back a
// structured JSON breakdown: one card section per plastic on the
// account, transactions with signed amounts, and — crucially —
// classified rows so we can distinguish between:
//
//   - PURCHASE      : normal debit, needs an invoice
//   - REFUND        : credit from a merchant, don't need to chase
//   - FEE           : bank-imposed charge (lounge, slow-pmt, VAT on fees, int)
//   - PAYMENT       : cardholder / company paying the card off
//   - ADVANCE       : cash/EFT deposit *into* the card (creates a
//                     CardAdvance row rather than a Transaction)
//   - INTEREST      : bank interest charge
//   - OTHER         : anything ambiguous — flagged for admin review
//
// Advantages over the regex parser:
//   - Handles new statement layouts without code changes
//   - Reads cardholder names printed anywhere on the section header
//   - Understands narrative rows (multi-line merchant descriptions)
//   - Correctly signs credit lines regardless of "Cr" suffix quirks
//   - Distinguishes advances from purchases even when the bank uses
//     the same "PAYMENT RECEIVED" wording for both

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
  maskedNumber: string;      // e.g. "4228 24** **** 7005"
  cardholderName: string;
  creditLimit: number | null;
  rows: AIStatementRow[];
}

export interface AIStatementResult {
  statementDate: string | null;   // ISO YYYY-MM-DD — the header date
  periodStart: string | null;
  periodEnd: string | null;
  parentAccount: string | null;
  bankStatedTotal: number | null; // "Transactions" total from page 1
  cards: AIStatementCard[];
  confidence: number;             // 0..1 self-reported by the model
  rawJson: string;                // full response, kept for audit
  warnings: string[];
}

const SYSTEM_PROMPT = `You extract structured data from South African credit card statements. Return ONLY a JSON object — no markdown fences, no commentary.

Output schema:
{
  "statementDate": string | null,       // ISO YYYY-MM-DD, the header/issue date
  "periodStart": string | null,          // ISO YYYY-MM-DD, statement period start
  "periodEnd": string | null,            // ISO YYYY-MM-DD, statement period end
  "parentAccount": string | null,        // e.g. "8812 7100 5898 3003"
  "bankStatedTotal": number | null,      // the "Transactions" summary total on page 1
  "cards": [
    {
      "last4": string,                   // "7005"
      "maskedNumber": string,            // "4228 24** **** 7005"
      "cardholderName": string,          // exactly as printed
      "creditLimit": number | null,      // ZAR, if a per-card limit is shown
      "rows": [
        {
          "date": string,                // ISO YYYY-MM-DD (use the statement year context)
          "merchant": string,            // combine merchant + narrative into one clean string
          "location": string | null,     // suburb/city if separable, else null
          "amount": number,              // see sign rules below
          "kind": "PURCHASE" | "REFUND" | "FEE" | "PAYMENT" | "ADVANCE" | "INTEREST" | "OTHER"
        }
      ]
    }
  ],
  "confidence": number                   // 0..1, your honest confidence
}

## Sign convention (IMPORTANT)

Positive amounts INCREASE what the cardholder owes the bank:
  - PURCHASE, FEE, INTEREST → positive

Negative amounts DECREASE what the cardholder owes:
  - REFUND, PAYMENT, ADVANCE → negative

Never emit "Cr" suffixes, brackets, or currency symbols in the amount — pure JSON numbers only, signed.

## Kind classification

- PURCHASE: normal card swipe / online purchase at a merchant
- REFUND: merchant reversal of a specific purchase (e.g. "Refund: Woolworths Sandton")
- FEE: bank-imposed charge — service fee, cash-withdrawal fee, slow-payment fee, VAT on fees, monthly card fee, "int-pymt", lounge access fee, currency conversion fee
- PAYMENT: cardholder paid the card off (e.g. "Payment received - thank you", "EFT PAYMENT RECEIVED - THANK YOU")
- ADVANCE: cash/EFT deposit that adds funds TO the card so the cardholder can keep spending. Wording: "CASH ADVANCE", "TRANSFER RECEIVED", "TOP UP", "LOAD", "DEPOSIT". If the row wording is genuinely ambiguous between PAYMENT and ADVANCE, prefer PAYMENT.
- INTEREST: "Interest charged", "Debit interest"
- OTHER: any row you can't confidently classify — the admin will review

## Card section handling

- Each plastic on the account has its own section starting with a header like "4228 24** **** 7005   - Limits   40000.00   0.00"
- The cardholder name appears near the section header — usually the line above or below
- The credit limit is the first number in the "- Limits" line
- Group all rows under their card section
- If a row could belong to more than one card (rare — usually only "Account-level fees" or shared VAT), attach it to the card whose section it appears IN

## CRITICAL — sections and rows to IGNORE entirely

The following are NOT transactions and must NEVER become rows in your output:

1. **Expense Summary / Category Analysis table** — a big grid near the front (usually page 2) with columns for the current month PLUS 12–13 prior months (SEP 2026, Average, SEP 2025, OCT 2025, ...). Row labels look like "Airlines", "Hotels", "Retail", "Vehicle Expenses", "Fuel", "Fees", "VAT", "Total Expenses". Every number in this table is a HISTORICAL SUMMARY. Skip the whole table. If you accidentally include even a few cells the statement total will be off by hundreds of thousands.

2. **Balance Brought Forward** — the balance carried over from last statement. Not a transaction.

3. **Payment Received** — the customer paying last statement's bill. Not a transaction, not a PAYMENT-kind row, not anything — skip.

4. **Balance Transferred / Balance Transfer** — a bookkeeping move between cards on the same account. Not a purchase, not an advance. Skip.

5. **Sub Total, Amount Owing, Card Total, Facility Total** — summary/rollup lines. Skip.

6. **Current Interest Rates table, Interest on Credit Balance, "we will sweep the amount"** — informational text on page 1. Skip.

7. **Account Summary block** on page 1 — the box with "Credit Facility / Balance Brought Forward / Payment Received / Sub Total / Transactions / Amount Owing". Use ONLY the "Transactions" cell value (assign it to bankStatedTotal). Do not turn any of the other cells into rows.

Only extract rows from the per-card transaction listings — the tables that follow each "**** ####  - Limits" card header and end with a "Card Total" line.

## Self-validation

After extracting, mentally sum every row's amount across all cards.
The sum SHOULD approximately equal bankStatedTotal (within a few thousand rand for VAT-on-fees and interest rounding). If your sum is more than ~5% off from bankStatedTotal, something has been double-counted or an ignored section has leaked in — re-check the "ignore" list above.

## Multi-line merchants

Some rows print merchant + descriptor on separate lines:
  "Payfast*Go Gadgets"
  "  Somerset West"

Combine into merchant="Payfast*Go Gadgets" location="Somerset West".

If the merchant string is only a reference like "Ref 5522 Jhb" with no merchant name, use merchant="Unknown merchant" and put the reference in location.

## Dates

Statements print dates as "15 Apr" without a year. Use the statement's periodStart/periodEnd or statementDate to derive the correct year. When December/January boundary is ambiguous, prefer the year that keeps rows inside [periodStart, periodEnd].

## bankStatedTotal

Look for a line on page 1 labelled "Transactions" that gives the total for the statement (typically appears in a summary box). This is the bank's authoritative total for the whole account — use it as-is (positive number).

## Data hygiene

- Deduplicate identical consecutive rows only when the statement clearly has a printing artifact — otherwise keep both
- Never invent transactions
- If you can't read a value confidently, leave it null rather than guess`;

@Injectable()
export class AIStatementExtractorService {
  private readonly logger = new Logger(AIStatementExtractorService.name);
  private client: Anthropic | null = null;

  constructor(private settings: SettingsService) {}

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
    const buffer = fs.readFileSync(pdfPath);
    const base64 = buffer.toString('base64');

    const fileBlock: Anthropic.ContentBlockParam = {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: base64,
      },
    };

    // Statements are far more complex than a single receipt, so we
    // default to Sonnet as primary (Haiku often misses cardholder
    // names printed in unusual positions). Admin can override.
    const primaryModel = this.settings.getString(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'ai.statementModel' as any,
      'claude-sonnet-4-6',
    );

    const start = Date.now();
    // We MUST stream when max_tokens is high enough that the SDK
    // estimates the request could take >10 minutes — the non-stream
    // API is refused pre-emptively with a "Streaming is required"
    // error. Streaming also gives us the option of a progress log
    // line in the future without changing anything else.
    const stream = this.client!.messages.stream({
      model: primaryModel,
      // Sonnet supports up to 64k output tokens. Big multi-card
      // statements (30+ cards, hundreds of rows) can produce a JSON
      // payload of 40–60k tokens; anything less risks truncation.
      max_tokens: 64000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
            {
              type: 'text',
              text: 'Extract the full statement. Return ONE JSON object matching the schema exactly.',
            },
          ],
        },
      ],
    });
    // finalMessage() waits for the whole stream to complete and
    // returns the same message shape as the non-stream create().
    const response = await stream.finalMessage();
    const durationMs = Date.now() - start;
    const textBlock = response.content.find((b) => b.type === 'text');
    const rawText = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    this.logger.log(
      `AI statement extraction (${primaryModel}): ${durationMs}ms, ` +
        `${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens` +
        ` (stop=${response.stop_reason})`,
    );

    // If the model hit the token cap the JSON will be truncated and
    // unparseable — surface a clearer error so ops knows to bump
    // max_tokens rather than chase a phantom parsing bug.
    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        `AI statement extractor: output truncated at max_tokens (${response.usage.output_tokens}). ` +
          `Statement is too large for a single call — increase max_tokens or split by card section.`,
      );
    }

    return this.parseResponse(rawText);
  }

  // ---------- Private ----------

  private getApiKey(): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fromSettings = this.settings.getString('ai.anthropicKey' as any, '');
    if (fromSettings) return fromSettings;
    return process.env.ANTHROPIC_API_KEY;
  }

  private parseResponse(raw: string): AIStatementResult {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(
        `AI statement extractor: response was not JSON-shaped: ${raw.slice(0, 200)}...`,
      );
    }
    const jsonText = cleaned.slice(start, end + 1);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `AI statement extractor: invalid JSON — ${(err as Error).message}: ${jsonText.slice(0, 200)}`,
      );
    }

    const warnings: string[] = [];
    const cards = Array.isArray(parsed.cards)
      ? (parsed.cards as Array<Record<string, unknown>>).map((c) =>
          this.coerceCard(c, warnings),
        )
      : [];

    return {
      statementDate: typeof parsed.statementDate === 'string' ? parsed.statementDate : null,
      periodStart: typeof parsed.periodStart === 'string' ? parsed.periodStart : null,
      periodEnd: typeof parsed.periodEnd === 'string' ? parsed.periodEnd : null,
      parentAccount:
        typeof parsed.parentAccount === 'string' ? parsed.parentAccount : null,
      bankStatedTotal:
        typeof parsed.bankStatedTotal === 'number' ? parsed.bankStatedTotal : null,
      cards,
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      rawJson: jsonText,
      warnings,
    };
  }

  private coerceCard(
    raw: Record<string, unknown>,
    warnings: string[],
  ): AIStatementCard {
    const last4 = typeof raw.last4 === 'string' ? raw.last4 : '';
    if (!last4) warnings.push('Card section returned with no last4');
    const rows = Array.isArray(raw.rows)
      ? (raw.rows as Array<Record<string, unknown>>).map((r) =>
          this.coerceRow(r, warnings),
        )
      : [];
    return {
      last4,
      maskedNumber:
        typeof raw.maskedNumber === 'string' ? raw.maskedNumber : `**** **** **** ${last4}`,
      cardholderName:
        typeof raw.cardholderName === 'string' ? raw.cardholderName : 'Unknown',
      creditLimit: typeof raw.creditLimit === 'number' ? raw.creditLimit : null,
      rows,
    };
  }

  private coerceRow(
    raw: Record<string, unknown>,
    warnings: string[],
  ): AIStatementRow {
    const kind =
      typeof raw.kind === 'string' &&
      ['PURCHASE', 'REFUND', 'FEE', 'PAYMENT', 'ADVANCE', 'INTEREST', 'OTHER'].includes(
        raw.kind,
      )
        ? (raw.kind as StatementRowKind)
        : 'OTHER';
    if (kind === 'OTHER') warnings.push('Row classified as OTHER — admin review needed');
    return {
      date: typeof raw.date === 'string' ? raw.date : '',
      merchant: typeof raw.merchant === 'string' ? raw.merchant : 'Unknown merchant',
      location: typeof raw.location === 'string' ? raw.location : null,
      amount: typeof raw.amount === 'number' ? raw.amount : 0,
      kind,
    };
  }
}
