import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Role } from '../auth/role.enum';
import type { JwtUser } from '../auth/role.enum';

@Controller('reconciliation')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReconciliationController {
  constructor(private reconService: ReconciliationService) {}

  // POST /reconciliation/run
  // Open to all authenticated users. Body optionally specifies a period;
  // defaults to "current month → today" if omitted. The period bounds
  // which invoices/transactions are considered AND what's snapshotted
  // into the saved ReconReport.
  @Post('run')
  run(
    @CurrentUser() user: JwtUser,
    @Body() body: { from?: string; to?: string } = {},
  ) {
    let period: { from: Date; to: Date } | undefined;
    if (body.from && body.to) {
      period = { from: new Date(body.from), to: new Date(body.to) };
    }
    return this.reconService.runReconciliation(user, period);
  }

  // GET /reconciliation/stats
  // Org-wide totals — kept admin-only because plain USERs get the
  // scoped equivalent via /dashboard/summary.
  @Get('stats')
  @Roles(Role.ADMIN, Role.REPORTING)
  stats() {
    return this.reconService.getStats();
  }

  // POST /reconciliation/match
  // USER can manually match own invoice ↔ own transaction.
  @Post('match')
  match(
    @Body() body: { invoiceId?: string; transactionId?: string },
    @CurrentUser() user: JwtUser,
  ) {
    if (!body?.invoiceId || !body?.transactionId) {
      throw new BadRequestException(
        'invoiceId and transactionId are required',
      );
    }
    return this.reconService.manualMatch(
      body.invoiceId,
      body.transactionId,
      user,
    );
  }

  // POST /reconciliation/unlink/:invoiceId
  // USER can unlink own invoice from its match.
  @Post('unlink/:invoiceId')
  unlink(
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.reconService.unlink(invoiceId, user);
  }
}
