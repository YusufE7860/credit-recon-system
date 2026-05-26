import { Injectable, Logger } from '@nestjs/common';
import { CurrencyService, Currency } from './currency.service';

// Structured fields we attempt to extract from invoice OCR text.
// Every field is optional because parsing might fail. A 'null' means
// "we couldn't find this", and the UI should prompt the user.
export interface ParsedInvoice {
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  total: number | null;
  subtotal: number | null;
  vat: number | null;
  // Currency detected from the text. Defaults to ZAR when nothing matches.
  currency: Currency;
  fieldsFound: {
    supplier: boolean;
    invoiceNumber: boolean;
    invoiceDate: boolean;
    total: boolean;
    vat: boolean;
  };
}

@Injectable()
export class InvoiceParserService {
  private readonly logger = new Logger(InvoiceParserService.name);

  constructor(private currencyService: CurrencyService) {}

  // Entry point: takes raw OCR text, returns structured fields.
  parse(rawText: string): ParsedInvoice {
    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const currency = this.currencyService.detect(rawText);
    const total = this.extractTotal(lines);
    const vat = this.extractVat(lines);
    const subtotal = this.extractSubtotal(lines);
    const invoiceNumber = this.extractInvoiceNumber(lines);
    const invoiceDate = this.extractDate(lines);
    const supplier = this.extractSupplier(lines);

    const parsed: ParsedInvoice = {
      supplier,
      invoiceNumber,
      invoiceDate,
      total,
      subtotal,
      vat,
      currency,
      fieldsFound: {
        supplier: supplier !== null,
        invoiceNumber: invoiceNumber !== null,
        invoiceDate: invoiceDate !== null,
        total: total !== null,
        vat: vat !== null,
      },
    };

    this.logger.log(
      `Parsed invoice — ${currency} · ${
        Object.values(parsed.fieldsFound).filter(Boolean).length
      }/5 fields found`,
    );

    return parsed;
  }

  // ---------- Field extractors ----------

  // Total: prefer lines mentioning "Grand Total", "Total Due", "Amount Due",
  // then fall back to plain "Total". Returns the number on that line.
  private extractTotal(lines: string[]): number | null {
    const priorityPatterns = [
      /\b(?:grand\s+total|total\s+due|amount\s+due|balance\s+due)\b/i,
      /\btotal\b/i,
    ];

    for (const pattern of priorityPatterns) {
      for (const line of lines) {
        if (pattern.test(line)) {
          const amount = this.extractAmount(line);
          if (amount !== null) return amount;
        }
      }
    }

    return null;
  }

  // VAT / Tax / GST line.
  private extractVat(lines: string[]): number | null {
    for (const line of lines) {
      // \b ensures we don't match "vat" inside another word like "private"
      if (/\b(?:vat|tax|gst)\b/i.test(line)) {
        // Skip "VAT No." / "Tax ID" — those are labels, not amounts.
        if (/(?:no|num|number|id|registration|reg)\.?\s*[:#]?/i.test(line) &&
            !/\d{1,3}(?:[.,]\d{2})\s*$/.test(line)) {
          continue;
        }
        const amount = this.extractAmount(line);
        if (amount !== null) return amount;
      }
    }
    return null;
  }

  private extractSubtotal(lines: string[]): number | null {
    for (const line of lines) {
      if (/\bsub[\s-]?total\b/i.test(line)) {
        const amount = this.extractAmount(line);
        if (amount !== null) return amount;
      }
    }
    return null;
  }

  // Invoice number: "Invoice #", "Invoice No", "Receipt #", or just
  // "Invoice number 98F94BF8-0031" style (Stripe).
  //
  // Key trick: explicitly consume "number/num/no/#" *between* the
  // anchor word and the ID so we don't capture "NUMBER" by accident.
  // Also: require the captured ID to contain at least one digit —
  // invoice numbers almost always do, and this filters out word
  // captures like "Tax".
  private extractInvoiceNumber(lines: string[]): string | null {
    const patterns = [
      // "Invoice number 98F94BF8-0031" / "Invoice no 12345" / "Invoice # 12345"
      /(?:invoice|receipt|reference|ref|tax\s+invoice)\s+(?:number|num|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{1,})/i,
      // "Invoice: 12345" / "Invoice 12345" (no separator word)
      /(?:invoice|receipt|reference|ref|tax\s+invoice)\s*[:#]\s*([A-Z0-9][A-Z0-9\-\/]{1,})/i,
      // Standalone "No. 12345" / "Number: 12345"
      /\b(?:no|number)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    ];

    for (const pattern of patterns) {
      for (const line of lines) {
        const match = line.match(pattern);
        if (!match || !match[1]) continue;
        const candidate = match[1].toUpperCase();
        // Must contain at least one digit. Filters word captures
        // like "NUMBER", "REFERENCE", "PAYMENT", etc.
        if (!/\d/.test(candidate)) continue;
        return candidate;
      }
    }
    return null;
  }

  // Date: tries several common formats. ORDER MATTERS — patterns are
  // tried in sequence, and we prefer "Date of issue" / "Invoice date"
  // labels over random dates elsewhere in the document.
  private extractDate(lines: string[]): Date | null {
    // First pass: lines that look like an explicit invoice date label.
    // Most invoices have "Date of issue", "Invoice date", or "Issued".
    // We prefer these so we don't pick up a payment due date or
    // statement period instead.
    const labelledFirst = [
      ...lines.filter((l) =>
        /(date\s+of\s+issue|invoice\s+date|issued|date\s+issued)/i.test(l),
      ),
      ...lines, // fallback: any line with a date
    ];

    const datePatterns: RegExp[] = [
      // 2024-03-15, 2024/03/15
      /\b(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/,
      // April 29, 2026 / Apr 29 2026 / 29 April 2026 (Stripe-style)
      /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})\b/,
      // 15 Mar 2024 (day-first word form)
      /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\b/,
      // 15-03-2024, 15/03/2024 (DD-MM-YYYY, common in ZA/EU)
      /\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})\b/,
    ];

    for (const line of labelledFirst) {
      for (const pattern of datePatterns) {
        const match = line.match(pattern);
        if (!match) continue;

        const date = this.parseMatchedDate(pattern, match);
        if (date && !isNaN(date.getTime())) {
          // Sanity check: invoices aren't from before 2000 or in the future.
          const year = date.getFullYear();
          if (year >= 2000 && year <= new Date().getFullYear() + 1) {
            return date;
          }
        }
      }
    }
    return null;
  }

  private parseMatchedDate(pattern: RegExp, match: RegExpMatchArray): Date | null {
    const source = pattern.source;
    try {
      // Pattern: YYYY-MM-DD
      if (source.startsWith('\\b(\\d{4})')) {
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      }
      // Pattern: "April 29, 2026" (month-first word form, Stripe-style)
      // First capture group is letters → it's the month.
      if (source.startsWith('\\b([A-Za-z]')) {
        const monthIdx = this.parseMonthName(match[1]);
        if (monthIdx === -1) return null;
        const day = Number(match[2]);
        let year = Number(match[3]);
        if (year < 100) year += 2000;
        return new Date(year, monthIdx, day);
      }
      // Pattern: "15 Mar 2024" (day-first word form)
      if (source.includes('[A-Za-z]')) {
        const day = Number(match[1]);
        const monthIdx = this.parseMonthName(match[2]);
        if (monthIdx === -1) return null;
        let year = Number(match[3]);
        if (year < 100) year += 2000;
        return new Date(year, monthIdx, day);
      }
      // Pattern: DD-MM-YYYY
      if (source.startsWith('\\b(\\d{1,2})[-\\/](\\d{1,2})')) {
        let year = Number(match[3]);
        if (year < 100) year += 2000;
        return new Date(year, Number(match[2]) - 1, Number(match[1]));
      }
    } catch {
      return null;
    }
    return null;
  }

  private parseMonthName(name: string): number {
    const months = [
      'jan', 'feb', 'mar', 'apr', 'may', 'jun',
      'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    ];
    return months.indexOf(name.slice(0, 3).toLowerCase());
  }

  // Supplier extraction — two-pronged approach:
  //
  // STRATEGY 1 (preferred): find the first line that looks like a
  // street address (starts with a number, contains a street-word),
  // and use the line ABOVE it as the supplier. Stripe / QuickBooks /
  // Xero / most B2B invoice templates put the company name right
  // above its address. Very reliable signal.
  //
  // STRATEGY 2 (fallback): scan the first ~12 lines for the first
  // candidate that isn't a known header/label/date/etc.
  private extractSupplier(lines: string[]): string | null {
    // ----- Strategy 1: name-above-address -----
    // Matches "1630 1st Ave N", "123 Main Street", "45 Oak Rd",
    // "PO Box 1234" etc.
    const addressRe =
      /^(\d+\s+[A-Za-z]|p\.?o\.?\s*box\s+\d+|\d+[A-Za-z]?\s+\w+\s+(?:st|street|ave|avenue|rd|road|blvd|drive|dr|lane|ln|way|crescent))/i;

    for (let i = 1; i < Math.min(lines.length, 15); i++) {
      if (addressRe.test(lines[i]) && this.couldBeName(lines[i - 1])) {
        return lines[i - 1].replace(/\s+/g, ' ').trim();
      }
    }

    // ----- Strategy 2: fallback heuristic -----
    for (const line of lines.slice(0, 12)) {
      if (this.couldBeName(line)) {
        return line.replace(/\s+/g, ' ').trim();
      }
    }
    return null;
  }

  // Does this line look like it COULD be a business name?
  // Excludes obvious page furniture, dates, addresses, etc.
  private couldBeName(line: string): boolean {
    if (!line) return false;
    const trimmed = line.trim();
    if (trimmed.length < 3 || trimmed.length > 60) return false;

    // Hard skip list — common PDF headers / labels.
    const SKIP_PATTERNS: RegExp[] = [
      /^page\s+\d+\s*(?:of\s+\d+)?$/i,
      /^invoice$/i,
      /^receipt$/i,
      /^tax\s+invoice$/i,
      /^quote$/i,
      /^statement$/i,
      /^bill\s+(?:to|from)/i,
      /^invoice\s+(?:number|no|date|to)/i,
      /^date\s+(?:of|due|issued?)/i,
      /^due\s+date/i,
      /^reference/i,
      /^terms/i,
      /^thank\s+you/i,
      /^pay\s+online/i,
      /^description$/i,
      /^subtotal/i,
      /^total/i,
      /^amount\s+due/i,
      /^tel|^phone|^fax|^email|^address/i,
      /^p\.?o\.?\s*box/i,
      /@/, // any line containing an @-sign is an email
    ];
    if (SKIP_PATTERNS.some((re) => re.test(trimmed))) return false;

    // Mostly-digits → likely an address / number / date.
    const digitRatio = (trimmed.match(/\d/g) ?? []).length / trimmed.length;
    if (digitRatio > 0.4) return false;

    // Mostly-letters required.
    const letterRatio = (trimmed.match(/[A-Za-z]/g) ?? []).length / trimmed.length;
    if (letterRatio < 0.5) return false;

    return true;
  }

  // ---------- Helpers ----------

  // Extract a monetary amount from a line. Handles things like:
  //  "Total      R 1,234.56"
  //  "VAT: 12.50"
  //  "Amount Due $ 99.00"
  private extractAmount(line: string): number | null {
    // Match optional currency symbol, then a number with optional thousands
    // separators and decimals.
    const matches = line.match(
      /(?:R|ZAR|USD|\$|€|£)?\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+\.\d{1,2})/g,
    );

    if (!matches || matches.length === 0) return null;

    // Take the LAST number on the line — total lines usually look like
    // "Total .... R 1,234.56" with the number at the end.
    const last = matches[matches.length - 1];
    const cleaned = last.replace(/[^\d.]/g, '');
    const parsed = parseFloat(cleaned);

    return isNaN(parsed) ? null : parsed;
  }
}
