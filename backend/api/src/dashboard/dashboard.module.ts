import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  // Dashboard now computes its own recon tallies (scoped to the
  // user-picked date range), so it no longer depends on
  // ReconciliationModule's all-time getStats().
  imports: [PrismaModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
