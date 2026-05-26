import { Module } from '@nestjs/common';
import { OcrService } from './ocr.service';
import { InvoiceParserService } from './invoice-parser.service';
import { CurrencyService } from './currency.service';
import { AIInvoiceExtractorService } from './ai-extractor.service';
import { HistoricalFxService } from './historical-fx.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [
    OcrService,
    InvoiceParserService,
    CurrencyService,
    AIInvoiceExtractorService,
    HistoricalFxService,
  ],
  exports: [
    OcrService,
    InvoiceParserService,
    CurrencyService,
    AIInvoiceExtractorService,
    HistoricalFxService,
  ],
})
export class OcrModule {}
