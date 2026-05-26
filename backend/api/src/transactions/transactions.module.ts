import { Module } from '@nestjs/common';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  // NotificationsModule + AuditModule are needed for the "notify owner
  // of unmatched transaction" admin action.
  imports: [PrismaModule, NotificationsModule, AuditModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}