import { Module } from '@nestjs/common';
import { StatementsController } from './statements.controller';
import { StatementsService } from './statements.service';
import { PdfParserService } from './pdf-parser.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [StatementsController],
  providers: [StatementsService, PdfParserService],
  exports: [StatementsService],
})
export class StatementsModule {}
