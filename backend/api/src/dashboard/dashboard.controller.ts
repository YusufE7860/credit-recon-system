import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/role.enum';

@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  // GET /dashboard/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=<uuid>
  // - from/to: optional period bounds. If omitted the service defaults
  //   to the current calendar month.
  // - userId: admin/reporting only — narrow the whole dashboard to a
  //   single user's spend. Silently ignored for non-privileged callers.
  @Get('summary')
  summary(
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId') userId?: string,
  ) {
    return this.dashboardService.getSummary(user, { from, to, userId });
  }
}
