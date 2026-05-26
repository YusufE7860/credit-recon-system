import {
  Controller,
  Get,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/role.enum';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.REPORTING) // applied to every method below
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  // GET /reports?from=YYYY-MM-DD&to=YYYY-MM-DD
  @Get()
  generate(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException(
        'from and to query parameters are required (YYYY-MM-DD)',
      );
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException(
        'from and to must be valid ISO dates',
      );
    }
    return this.reportsService.generate({ from: fromDate, to: toDate });
  }
}
