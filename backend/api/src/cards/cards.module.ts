import { Module } from '@nestjs/common';
import { CardsService } from './cards.service';
import { CardsController } from './cards.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [CardsService],
  controllers: [CardsController],
  // Exporting CardsService lets other modules inject it later
  // (e.g. when Transactions needs to look up a card by id).
  exports: [CardsService],
})
export class CardsModule {}
