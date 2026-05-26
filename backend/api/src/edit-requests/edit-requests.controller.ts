import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { EditRequestsService } from './edit-requests.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Role } from '../auth/role.enum';
import type { JwtUser } from '../auth/role.enum';
import { EditRequestStatus, EditRequestType } from '@prisma/client';

@Controller('edit-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EditRequestsController {
  constructor(private editRequestsService: EditRequestsService) {}

  // GET /edit-requests
  // USER  → their own requests
  // ADMIN → everyone's (the admin queue)
  @Get()
  async list(
    @CurrentUser() user: JwtUser,
    @Query('status') status?: EditRequestStatus,
  ) {
    // Sweep stale unlocks before returning. Cheap; runs at most once per request.
    await this.editRequestsService.sweepExpired();
    return this.editRequestsService.list(user, status);
  }

  // POST /edit-requests
  // body: { invoiceId, reason, fieldsToEdit?, type? }
  //   type: 'FINANCIAL' (default) | 'METADATA'
  @Post()
  create(
    @CurrentUser() user: JwtUser,
    @Body() body: {
      invoiceId?: string;
      reason?: string;
      fieldsToEdit?: string;
      type?: string;
    },
  ) {
    if (!body?.invoiceId || !body?.reason?.trim()) {
      throw new BadRequestException(
        'invoiceId and reason are required',
      );
    }
    // Validate type: only accept the two known enum values, otherwise
    // fall back to the default FINANCIAL so old clients keep working.
    let parsedType: EditRequestType | undefined;
    if (body.type) {
      const upper = body.type.toUpperCase();
      if (upper === 'FINANCIAL' || upper === 'METADATA') {
        parsedType = upper as EditRequestType;
      } else {
        throw new BadRequestException(
          `Invalid type: ${body.type}. Must be FINANCIAL or METADATA.`,
        );
      }
    }
    return this.editRequestsService.create(
      {
        invoiceId: body.invoiceId,
        reason: body.reason,
        fieldsToEdit: body.fieldsToEdit,
        type: parsedType,
      },
      user,
    );
  }

  // POST /edit-requests/:id/approve
  @Post(':id/approve')
  @Roles(Role.ADMIN)
  approve(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.editRequestsService.approve(
      id,
      user.sub,
      body?.note ?? null,
    );
  }

  // POST /edit-requests/:id/reject
  @Post(':id/reject')
  @Roles(Role.ADMIN)
  reject(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.editRequestsService.reject(
      id,
      user.sub,
      body?.note ?? null,
    );
  }
}
