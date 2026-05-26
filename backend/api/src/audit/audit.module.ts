import { Module, Global } from '@nestjs/common';
import { AuditLogService } from './audit.service';
import { AuditLogController } from './audit.controller';
import { PrismaModule } from '../prisma/prisma.module';

// Global so every feature module can inject AuditLogService without
// repeatedly importing the module everywhere.
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuditLogService],
  controllers: [AuditLogController],
  exports: [AuditLogService],
})
export class AuditModule {}
