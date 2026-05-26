import { Module } from '@nestjs/common';
import { ReconReportsController } from './recon-reports.controller';
import { ReconReportsService } from './recon-reports.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ReconReportsController],
  providers: [ReconReportsService],
  exports: [ReconReportsService], // Reconciliation module imports this
})
export class ReconReportsModule {}
