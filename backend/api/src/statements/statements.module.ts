import { Module } from '@nestjs/common';
import { StatementsController } from './statements.controller';
import { StatementsService } from './statements.service';
import { PdfParserService } from './pdf-parser.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';

@Module({
  // ReconciliationModule is imported so that after a statement is
  // imported (or re-imported following a delete), we can automatically
  // run a full org-wide recon over the statement's period — picking up
  // any invoices users uploaded earlier in the month.
  imports: [PrismaModule, ReconciliationModule],
  controllers: [StatementsController],
  providers: [StatementsService, PdfParserService],
  exports: [StatementsService],
})
export class StatementsModule {}
