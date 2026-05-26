import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
} from './categories.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/role.enum';

@Controller('categories')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  // Any authenticated user can read the category list — needed for the
  // upload-page dropdown and the invoice-detail edit form.
  @Get()
  list(@Query('includeInactive') includeInactive?: string) {
    return this.categoriesService.list({
      includeInactive: includeInactive === 'true',
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.categoriesService.getById(id);
  }

  // Mutations are admin-only.
  @Post()
  @Roles(Role.ADMIN)
  create(@Body() body: CreateCategoryInput) {
    return this.categoriesService.create(body);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() body: UpdateCategoryInput) {
    return this.categoriesService.update(id, body);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.categoriesService.delete(id);
  }
}
