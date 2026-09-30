import { Module } from '@nestjs/common';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  // NotificationsModule + AuditModule are needed for the "notify owner
  // of unmatched transaction" admin action. SettingsModule powers the
  // "invoice chase emails" kill-switch.
  imports: [PrismaModule, NotificationsModule, AuditModule, SettingsModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}