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
    //
    // The FNB statement layout is:
    //   [Card header A] [Cardholder name] [transactions...] [Card Total]
    //   [Card header B] [Cardholder name] [transactions...] [Card Total]
    //   ...
    //   [Cardholder summary block at end — date / name / amount per holder]
    //   [Payment - Thank You]
    //   [Closing Balance]
    //
    // The trailing summary block matches the same date/name/amount/amount
    // shape as a real transaction row, so without state we end up
    // importing every cardholder's monthly total as a fake transaction
    // (~30 phantom rows on a full statement).
    //
    // Fix: track whether we're currently INSIDE a card section. Set true
    // on a card header, false on "Card Total" or "Closing Balance".
    // Outside a card section, transaction-shaped lines are noise and
    // get dropped.
    const cards: ParsedCardSection[] = [];
    let currentCard: ParsedCardSection | null = null;
    let inCardSection = false;
    // After we see a card header, the NEXT non-empty line is the cardholder name.
    let waitingForName = false;

    const lines = text.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Closing Balance ends the document — anything below is footer.
      if (/^closing balance/i.test(line)) {
        inCardSection = false;
        // Stop iterating — nothing useful past here.
        break;
      }

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
        inCardSection = true;
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

      // "Card Total" closes the current section. The cardholder
      // summary block follows after the LAST card total, and we don't
      // want any of those rows interpreted as transactions.
      if (/^card total/i.test(line)) {
        inCardSection = false;
        continue;
      }

      // Inside a card section — look for transaction rows.
      if (currentCard && inCardSection) {
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

    // FNB columns are Date | Transaction Details | Loc | Amount | Budget,
    // but pdf-parse collapses them into single lines. The Loc column
    // often holds reference codes (long all-digit strings) that get
    // appended to the merchant body. Strip them BEFORE the merchant/
    // location split so the merchant stays clean. Example:
    //   "Dnhgodaddy *#81600775   310858883143"
    // → strip "310858883143" → "Dnhgodaddy *#81600775"
    const cleanedBody = this.stripTrailingReference(body);

    // After stripping, if the merchant body has no letters left, the
    // row is pure parser noise (a Loc-column-only line that the regex
    // matched by accident). Drop it — better to miss a transaction
    // than create a phantom one with no merchant.
    const letterCount = (cleanedBody.match(/[A-Za-z]/g) ?? []).length;
    if (letterCount < 2) return null;

    const { merchant, location } = this.splitMerchantLocation(cleanedBody);

    let amount = this.parseAmount(amountStr) ?? 0;
    // "Cr" suffix = credit / refund — store as negative.
    if (crFlag) amount = -Math.abs(amount);

    const isFee = FEE_PREFIXES.some((p) => merchant.trimStart().startsWith(p));

    return { date, merchant, location, amount, isFee };
  }

  // Strip a trailing all-digit reference number (4+ digits, typically
  // the Loc-column value) from a transaction body. Leaves the rest of
  // the body — including any merchant name and city — alone.
  // Conservative: only strips when the merchant body has letters earlier
  // (so a body that is ONLY digits stays as-is and gets rejected later).
  private stripTrailingReference(body: string): string {
    const words = body.trim().split(/\s+/);
    if (words.length < 2) return body.trim();

    // Walk backwards stripping any trailing tokens that are pure digit
    // runs of 4+ characters. (Shorter runs like "85" could be a real
    // shop number in the merchant.)
    let i = words.length;
    while (i > 1 && /^\d{4,}$/.test(words[i - 1])) {
      i--;
    }
    return words.slice(0, i).join(' ');
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
