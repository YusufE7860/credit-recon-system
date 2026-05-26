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

import { UsersService } from './users.service';
import type {
  CreateUserInput,
  UpdateUserInput,
} from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/role.enum';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @Roles(Role.ADMIN, Role.REPORTING)
  findAll() {
    return this.usersService.getUsers();
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.REPORTING)
  findOne(@Param('id') id: string) {
    return this.usersService.getUserById(id);
  }

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() body: CreateUserInput) {
    return this.usersService.createUser(body);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() body: UpdateUserInput) {
    return this.usersService.updateUser(id, body);
  }

  // Admin-set password (skip the email flow). Used by the admin UI's
  // "reset this user's password" button.
  @Post(':id/set-password')
  @Roles(Role.ADMIN)
  setPassword(
    @Param('id') id: string,
    @Body() body: { password: string },
  ) {
    return this.usersService.setPassword(id, body.password);
  }

  // DELETE = soft delete (sets active=false). Data is preserved.
  @Delete(':id')
  @Roles(Role.ADMIN)
  deactivate(@Param('id') id: string) {
    return this.usersService.deactivate(id);
  }

  @Patch(':id/reactivate')
  @Roles(Role.ADMIN)
  reactivate(@Param('id') id: string) {
    return this.usersService.reactivate(id);
  }
}
