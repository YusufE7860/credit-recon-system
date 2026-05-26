import { Injectable, Logger } from '@nestjs/common';
import { createWorker, Worker } from 'tesseract.js';
import { PDFParse } from 'pdf-parse';
import * as fs from 'fs';

export interface OcrResult {
  text: string;
  confidence: number;
  durationMs: number;
  source: 'tesseract' | 'pdf-text'; // which engine produced this
}

// MIME types we route through Tesseract.
const TESSERACT_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
// MIME types we route through pdf-parse (digital PDF text extraction).
const PDF_MIMES = ['application/pdf'];

// If pdf-parse returns fewer than this many characters, the PDF is
// probably a scanned image and we'd need rasterization → tesseract.
// For now we treat sparse PDFs as low-confidence rather than failing.
const PDF_TEXT_MIN_CHARS = 50;

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private workerPromise: Promise<Worker> | null = null;

  private getWorker(): Promise<Worker> {
    if (!this.workerPromise) {
      this.logger.log('Initializing Tesseract worker (one-time setup)...');
      this.workerPromise = createWorker('eng');
    }
    return this.workerPromise;
  }

  // True for any file type we can extract text from.
  // Both images (via Tesseract) and PDFs (via pdf-parse) are supported.
  canOcr(mimeType: string): boolean {
    return TESSERACT_MIMES.includes(mimeType) || PDF_MIMES.includes(mimeType);
  }

  // Main entry point. Dispatches to the right extractor by MIME type.
  async recognize(filePath: string, mimeType?: string): Promise<OcrResult> {
    const start = Date.now();
    const mt = mimeType ?? this.guessMimeFromPath(filePath);

    if (PDF_MIMES.includes(mt)) {
      return this.recognizePdf(filePath, start);
    }
    return this.recognizeImage(filePath, start);
  }

  // ---------- PDF (digital text) ----------

  private async recognizePdf(filePath: string, start: number): Promise<OcrResult> {
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    // Postgres rejects null bytes in TEXT columns ("invalid byte sequence
    // for encoding UTF8: 0x00"). PDF text streams from generators like
    // Stripe sometimes include them. Sanitize before we go any further.
    const text = sanitizeText(result.text ?? '');
    const durationMs = Date.now() - start;

    // Digital PDF text extraction is essentially exact when it works,
    // so we report high confidence. Sparse text suggests scanned PDF.
    if (text.length < PDF_TEXT_MIN_CHARS) {
      this.logger.warn(
        `PDF text extraction yielded ${text.length} chars — likely a scanned PDF. Returning low confidence.`,
      );
      return { text, confidence: 0.1, durationMs, source: 'pdf-text' };
    }

    this.logger.log(
      `PDF text extracted in ${durationMs}ms — ${text.length} chars`,
    );
    // 0.95 (not 1.0) because we still have to parse fields from the text —
    // confidence reflects *extraction* accuracy, not *field* accuracy.
    return { text, confidence: 0.95, durationMs, source: 'pdf-text' };
  }

  // ---------- Image (Tesseract) ----------

  private async recognizeImage(filePath: string, start: number): Promise<OcrResult> {
    const worker = await this.getWorker();
    const result = await worker.recognize(filePath);
    const durationMs = Date.now() - start;
    const confidence = (result.data.confidence ?? 0) / 100;
    // Defensive: tesseract output is usually clean, but normalize
    // here too so the contract is consistent across both branches.
    const text = sanitizeText(result.data.text);

    this.logger.log(
      `Image OCR done in ${durationMs}ms — confidence ${(confidence * 100).toFixed(1)}% — ${text.length} chars`,
    );
    return {
      text,
      confidence,
      durationMs,
      source: 'tesseract',
    };
  }

  // Crude MIME guess from file extension. Used when callers don't pass it.
  private guessMimeFromPath(path: string): string {
    const lower = path.toLowerCase();
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }

  async onModuleDestroy() {
    if (this.workerPromise) {
      const worker = await this.workerPromise;
      await worker.terminate();
      this.logger.log('Tesseract worker terminated');
    }
  }
}

// ---------- Text sanitation ----------
//
// Strips characters that Postgres TEXT columns will reject:
//   - U+0000 NULL byte (causes "invalid byte sequence for encoding UTF8: 0x00")
//   - Other C0 control chars except tab / LF / CR which are valid in text.
//
// Stripe-style PDFs in particular love embedding NULs in their text
// streams; if we don't filter them, Prisma writes to `ocrRawText` fail.
function sanitizeText(s: string): string {
  if (!s) return '';
  // Remove all non-printable C0 controls EXCEPT \t (0x09), \n (0x0A), \r (0x0D).
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
