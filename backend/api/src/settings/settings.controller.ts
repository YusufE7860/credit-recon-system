import {
  Controller, Get, Patch, Body, UseGuards, Logger,
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
  private readonly logger = new Logger(SettingsController.name);

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
    // If the rebuild throws (bad SMTP details), don't fail the whole
    // save; log it and let the admin retry. Their category/store/etc.
    // changes shouldn't disappear because SMTP is misconfigured.
    let mailWarning: string | null = null;
    try {
      await this.mailerService.reconfigure();
    } catch (err) {
      mailWarning = (err as Error).message;
      this.logger.warn(
        `Settings saved, but mailer.reconfigure failed: ${mailWarning}`,
      );
    }
    return { success: true, mailWarning };
  }
}
