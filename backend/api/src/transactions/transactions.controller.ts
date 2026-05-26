import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';

import { TransactionsService } from './transactions.service';
import type { UpdateTransactionInput } from './transactions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Role } from '../auth/role.enum';
import type { JwtUser } from '../auth/role.enum';

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TransactionsController {
  constructor(
    private transactionsService: TransactionsService,
  ) {}

  // Manual create / delete are admin-only (they bypass statement import).
  @Post()
  @Roles(Role.ADMIN)
  create(@Body() body: any) {
    return this.transactionsService.createTransaction(body);
  }

  @Get()
  findAll(
    @CurrentUser() user: JwtUser,
    @Query('userId') userId?: string,
  ) {
    // Service enforces RBAC — non-privileged callers can't actually
    // pass a different userId, even if they try.
    return this.transactionsService.getTransactions(user, { userId });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.transactionsService.getTransactionById(id, user);
  }

  // Admin-only edit. Fixes bank-statement typos / missing categories
  // without needing direct DB access.
  @Patch(':id')
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() body: UpdateTransactionInput) {
    return this.transactionsService.updateTransaction(id, body);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.transactionsService.deleteTransaction(id);
  }

  // POST /transactions/:id/notify-owner
  // Admin/Reporting only. Sends an in-app notification to the card
  // owner asking them to upload an invoice for this unmatched
  // transaction. Used by the Reports → Unmatched tab's "Notify" button.
  @Post(':id/notify-owner')
  @Roles(Role.ADMIN, Role.REPORTING)
  notifyOwner(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.transactionsService.notifyOwnerAboutUnmatched(id, user);
  }
}
