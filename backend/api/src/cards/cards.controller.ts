import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { CardsService } from './cards.service';
import type {
  CreateCardInput,
  UpdateCardInput,
} from './cards.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Role } from '../auth/role.enum';
// JwtUser is an interface (type-only). With isolatedModules +
// emitDecoratorMetadata, types used in @decorator() signatures must
// use `import type` so TS doesn't try to emit runtime metadata for them.
import type { JwtUser } from '../auth/role.enum';

@Controller('cards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CardsController {
  constructor(private cardsService: CardsService) {}

  // GET /cards — USER sees only cards assigned to them; REPORTING/ADMIN see all.
  @Get()
  findAll(@CurrentUser() user: JwtUser) {
    return this.cardsService.getCards(user);
  }

  // GET /cards/live-spend — per-card {creditLimit, liveSpend, available}
  // for the dashboard "live spend tracker" widget. Scoped by role:
  // USERs see only cards assigned to them, admins see all.
  @Get('live-spend')
  liveSpend(@CurrentUser() user: JwtUser) {
    return this.cardsService.getLiveSpend(user);
  }

  // ---------- Advances ----------

  // GET /cards/:id/advances — every top-up recorded on this card.
  @Get(':id/advances')
  listAdvances(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.cardsService.listAdvancesForCard(id, user);
  }

  // GET /cards/user/:userId/advances — every top-up across all cards
  // assigned to a user. Used by the admin user-profile page's
  // "Cash Advances" section.
  @Get('user/:userId/advances')
  listAdvancesByUser(
    @Param('userId') userId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.cardsService.listAdvancesForUser(userId, user);
  }

  // POST /cards/:id/advances — record an OFF-STATEMENT advance
  // (money the business transferred onto the card outside a
  // statement's own credit lines). Body: { amount, occurredAt,
  // sourceRef?, notes? }. Admin/reporting only.
  @Post(':id/advances')
  @Roles(Role.ADMIN, Role.REPORTING)
  createAdvance(
    @Param('id') id: string,
    @Body()
    body: {
      amount: number;
      occurredAt: string;
      sourceRef?: string;
      notes?: string;
    },
    @CurrentUser() user: JwtUser,
  ) {
    return this.cardsService.createAdvance(
      {
        cardId: id,
        amount: body.amount,
        occurredAt: body.occurredAt,
        sourceRef: body.sourceRef ?? null,
        notes: body.notes ?? null,
      },
      user,
    );
  }

  // DELETE /cards/advances/:advanceId — remove a recorded advance.
  // Note: the URL is /cards/advances/:advanceId (not nested under
  // /cards/:cardId/) so the caller doesn't need to know the parent
  // card id to reverse a mistake.
  @Delete('advances/:advanceId')
  @Roles(Role.ADMIN, Role.REPORTING)
  deleteAdvance(
    @Param('advanceId') advanceId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.cardsService.deleteAdvance(advanceId, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.cardsService.getCardById(id, user);
  }

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() body: CreateCardInput) {
    return this.cardsService.createCard(body);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() body: UpdateCardInput) {
    return this.cardsService.updateCard(id, body);
  }

  @Patch(':id/assign')
  @Roles(Role.ADMIN)
  assign(
    @Param('id') id: string,
    @Body() body: { userId: string | null },
  ) {
    return this.cardsService.assignToUser(id, body.userId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.cardsService.deleteCard(id);
  }

  // POST /cards/:id/merge — re-route every transaction from `losingId`
  // to this card's last4, then delete the loser. For cleaning up
  // duplicate cards that statement formatting created over multiple
  // months.
  @Post(':id/merge')
  @Roles(Role.ADMIN)
  merge(
    @Param('id') winningId: string,
    @Body() body: { losingId?: string },
  ) {
    return this.cardsService.mergeCards(winningId, body?.losingId ?? '');
  }
}
