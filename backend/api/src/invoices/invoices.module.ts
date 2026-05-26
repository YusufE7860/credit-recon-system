import { Module, forwardRef } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PrismaModule } from '../prisma/prisma.module';
import { OcrModule } from '../ocr/ocr.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';

@Module({
  // OcrModule provides OCR services for invoice extraction.
  // ReconciliationModule provides matchSingleInvoice — called right
  // after upload so newly created invoices auto-match against any
  // existing unmatched transaction in the date window.
  // `forwardRef` guards against any future circular import (the recon
  // engine doesn't depend on invoices today, but if that ever changes
  // this stays robust).
  imports: [PrismaModule, OcrModule, forwardRef(() => ReconciliationModule)],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
