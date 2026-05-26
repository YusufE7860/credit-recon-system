import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { StoresService } from './stores.service';
import type { CreateStoreInput, UpdateStoreInput } from './stores.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/role.enum';

@Controller('stores')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StoresController {
  constructor(private storesService: StoresService) {}

  // Any authenticated user can read the store list — needed for the
  // upload-page dropdown.
  @Get()
  list(@Query('includeInactive') includeInactive?: string) {
    return this.storesService.list({
      includeInactive: includeInactive === 'true',
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.storesService.getById(id);
  }

  // Mutations are admin-only.
  @Post()
  @Roles(Role.ADMIN)
  create(@Body() body: CreateStoreInput) {
    return this.storesService.create(body);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() body: UpdateStoreInput) {
    return this.storesService.update(id, body);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.storesService.delete(id);
  }
}
