import { Module, Global } from '@nestjs/common';
import { MailerService } from './mailer.service';

// Global: makes MailerService available everywhere without re-importing.
@Global()
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
