import {
  Controller, Get, Patch, Body, UseGuards,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import { MailerService } from '../mailer/mailer.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Role } from '../auth/role.enum';
import type { JwtUser } from '../auth/role.enum';

@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class SettingsController {
  constructor(
    private settingsService: SettingsService,
    private mailerService: MailerService,
  ) {}

  @Get()
  read() {
    return this.settingsService.readForAdmin();
  }

  // Bulk PATCH — UI sends the whole dict every save.
  @Patch()
  async update(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: JwtUser,
  ) {
    await this.settingsService.setMany(body, user.sub);
    // Mail settings might have changed — rebuild the SMTP transporter.
    await this.mailerService.reconfigure();
    return { success: true };
  }
}
