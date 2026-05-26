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
