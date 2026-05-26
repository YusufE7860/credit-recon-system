import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
// pdf-parse v2 switched to a class-based API. Named import + `new`.
import { PDFParse } from 'pdf-parse';

// ---------- Output types ----------

export interface ParsedCardSection {
  last4: string;
  maskedNumber: string;       // e.g. "4228 24** **** 7005"
  cardholderName: string;
  creditLimit: number | null;
  transactions: ParsedTransaction[];
}

export interface ParsedTransaction {
  date: Date;
  merchant: string;
  location: string | null;
  amount: number;             // negative for credits/refunds
  isFee: boolean;             // bank-imposed fees (lounge, slow-entry, int-pymt)
}

export interface ParsedStatement {
  statementDate: Date | null;     // header date — used for the year context
  parentAccount: string | null;   // e.g. "8812 7100 5898 3003"
  cards: ParsedCardSection[];
  rawTextLength: number;
  warnings: string[];
}

// ---------- Regex catalogue (all in one place — easier to tune) ----------

// "4228 24** **** 7005   - Limits   40000.00   0.00"
const CARD_HEADER_RE =
  /^(\d{4}\s+\d{2}\*\*\s+\*\*\*\*\s+\d{4})\s+-\s+Limits\s+([\d\s]+\.\d{2})\s+[\d\s]+\.\d{2}\s*$/;

// "15 Apr Payfast*Go Gadgets Somerset West 12 050.00 0.00"
// Captures: date, body (merchant + maybe location), amount, optional Cr, second amount (ignored).
const TXN_RE =
  /^(\d{1,2}\s+[A-Za-z]{3})\s+(.+?)\s+(\d{1,3}(?:\s\d{3})*(?:\.\d{2})?)(Cr)?\s+(\d+\.\d{2})\s*$/;

// Header date in the page footer: "2026/04/25"
const STATEMENT_DATE_RE = /(\d{4})\/(\d{2})\/(\d{2})/;

// Parent account at the top: "8812 7100 5898 3003"
const PARENT_ACCOUNT_RE = /^(\d{4}\s+\d{4}\s+\d{4}\s+\d{4})\s/;

// Skip these — they're labels, not real transactions.
const SKIP_DESCRIPTIONS = [
  'balance brought forward',
  'balance transferred',
  'card total',
];

// These prefixes mark bank fees (which ARE real transactions, just flagged).
const FEE_PREFIXES = ['#'];

// Months for date parsing.
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

@Injectable()
export class PdfParserService {
  private readonly logger = new Logger(PdfParserService.name);

  // Read a PDF file from disk and parse it into structured card sections.
  async parseStatement(filePath: string): Promise<ParsedStatement> {
    const buffer = fs.readFileSync(filePath);

    // v2 API: instantiate, then call getText().  The Uint8Array conversion
    // satisfies the strict type even when Buffer would work at runtime.
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    const text = result.text;
    const warnings: string[] = [];

    // ---- 1. Detect statement-wide info from the raw text ----
    const statementDate = this.extractStatementDate(text);
    const parentAccount = this.extractParentAccount(text);

    if (!statementDate) {
      warnings.push(
        'Could not find statement date in header — using current year for transactions.',
      );
    }
    const year = statementDate?.getFullYear() ?? new Date().getFullYear();

    // ---- 2. Walk the lines, building card sections ----
    const cards: ParsedCardSection[] = [];
    let currentCard: ParsedCardSection | null = null;
    // After we see a card header, the NEXT non-empty line is the cardholder name.
    let waitingForName = false;

    const lines = text.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Is this a new card section header?
      const cardMatch = line.match(CARD_HEADER_RE);
      if (cardMatch) {
        if (currentCard) cards.push(currentCard);
        const maskedNumber = cardMatch[1].replace(/\s+/g, ' ');
        const last4 = maskedNumber.slice(-4);
        const creditLimit = this.parseAmount(cardMatch[2]);
        currentCard = {
          last4,
          maskedNumber,
          cardholderName: '',
          creditLimit,
          transactions: [],
        };
        waitingForName = true;
        continue;
      }

      // Cardholder name comes right after the card header line.
      if (waitingForName && currentCard) {
        // Skip non-name lines like "Balance Brought Forward" if they
        // slip in due to weird PDF ordering.
        if (this.looksLikeName(line)) {
          currentCard.cardholderName = line;
          waitingForName = false;
        }
        continue;
      }

      // Inside a card section — look for transaction rows.
      if (currentCard) {
        const txn = this.tryParseTransaction(line, year);
        if (txn) {
          currentCard.transactions.push(txn);
          continue;
        }
        // Otherwise it's noise (page footer, forex continuation, header,
        // etc.) and we ignore it. We don't warn — too many false positives.
      }
    }

    // Don't forget the last card.
    if (currentCard) cards.push(currentCard);

    // ---- 3. Sanity check ----
    if (cards.length === 0) {
      throw new BadRequestException(
        'PDF parsed but no card sections were found. Is this an FNB-style business statement?',
      );
    }

    this.logger.log(
      `Parsed PDF: ${cards.length} cards, ${cards.reduce((n, c) => n + c.transactions.length, 0)} total transactions`,
    );

    return {
      statementDate,
      parentAccount,
      cards,
      rawTextLength: text.length,
      warnings,
    };
  }

  // ---------- Helpers ----------

  private extractStatementDate(text: string): Date | null {
    const m = text.match(STATEMENT_DATE_RE);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  private extractParentAccount(text: string): string | null {
    const m = text.match(PARENT_ACCOUNT_RE);
    return m ? m[1] : null;
  }

  // Heuristic: a "name" line is mostly letters, not too long, doesn't
  // start with a date or a common label.
  private looksLikeName(line: string): boolean {
    if (line.length < 3 || line.length > 60) return false;
    if (/^\d/.test(line)) return false;
    if (SKIP_DESCRIPTIONS.some((s) => line.toLowerCase().includes(s))) {
      return false;
    }
    // Mostly letters & spaces?
    const letterRatio = (line.match(/[A-Za-z]/g) ?? []).length / line.length;
    return letterRatio > 0.5;
  }

  // Try to parse one line as a transaction. Returns null if it doesn't match.
  private tryParseTransaction(
    line: string,
    year: number,
  ): ParsedTransaction | null {
    const m = line.match(TXN_RE);
    if (!m) return null;

    const [, dateStr, body, amountStr, crFlag] = m;

    // Build the date — only day+month in the line, year from statement header.
    const date = this.parseDayMonth(dateStr, year);
    if (!date) return null;

    // Skip label-only rows that happen to fit the regex shape.
    const lowerBody = body.toLowerCase();
    if (SKIP_DESCRIPTIONS.some((s) => lowerBody.includes(s))) return null;

    // Split body into merchant + location (location is usually the last
    // 1-3 trailing words, but we don't have a reliable column boundary
    // from text-only PDF output. Heuristic: split on long run of spaces.)
    const { merchant, location } = this.splitMerchantLocation(body);

    let amount = this.parseAmount(amountStr) ?? 0;
    // "Cr" suffix = credit / refund — store as negative.
    if (crFlag) amount = -Math.abs(amount);

    const isFee = FEE_PREFIXES.some((p) => merchant.trimStart().startsWith(p));

    return { date, merchant, location, amount, isFee };
  }

  private parseDayMonth(s: string, year: number): Date | null {
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})$/);
    if (!m) return null;
    const day = Number(m[1]);
    const monthIdx = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (monthIdx === undefined) return null;
    const d = new Date(year, monthIdx, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // Try to peel a location off the end. Bank statements typically put
  // city/region at the end after multiple spaces, but pdf-parse output
  // often collapses spaces. We do our best: take the last 1-3 words IF
  // they look like a place name (starts with capital, no digits).
  private splitMerchantLocation(body: string): {
    merchant: string;
    location: string | null;
  } {
    const words = body.split(/\s+/);
    if (words.length < 2) return { merchant: body, location: null };

    // Find the longest trailing run of words that look like a place.
    const looksLikePlaceWord = (w: string) =>
      /^[A-Z][a-zA-Z]+$/.test(w) || /^[A-Z]+$/.test(w);

    let splitAt = words.length;
    for (let i = words.length - 1; i > 0 && i >= words.length - 3; i--) {
      if (looksLikePlaceWord(words[i])) {
        splitAt = i;
      } else {
        break;
      }
    }

    if (splitAt === words.length) return { merchant: body, location: null };

    return {
      merchant: words.slice(0, splitAt).join(' '),
      location: words.slice(splitAt).join(' '),
    };
  }

  // Amounts like "12 050.00" or "100.00" or "40000.00".
  private parseAmount(s: string): number | null {
    const cleaned = s.replace(/\s/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
}
