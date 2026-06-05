import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { SystemService } from './system.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtUser } from '../auth/role.enum';

// All endpoints require ADMIN. The in-app updater is a foot-gun by
// design — only the most trusted role gets to point it at production.
function assertAdmin(user: JwtUser) {
  if (user.role !== 'ADMIN') {
    throw new ForbiddenException('Admins only');
  }
}

@Controller('system')
@UseGuards(JwtAuthGuard)
export class SystemController {
  constructor(private systemService: SystemService) {}

  // GET /system/version[?check=true]
  // Returns the running git SHA + commit message. When ?check=true is
  // set, ALSO runs `git fetch` and reports what's on origin/main so
  // the UI can show "update available". The fetch is gated behind the
  // query param because it does a network round-trip and the page
  // loads /version on mount — we don't want to fetch every page open.
  @Get('version')
  async version(
    @CurrentUser() user: JwtUser,
    @Query('check') check?: string,
  ) {
    assertAdmin(user);
    return this.systemService.getVersion(check === 'true' || check === '1');
  }

  // POST /system/update
  // Kicks off the update. Returns immediately ("started" or "rejected
  // because already running"). The actual work happens in a detached
  // child process; the UI polls /system/update/status for progress.
  @Post('update')
  triggerUpdate(@CurrentUser() user: JwtUser) {
    assertAdmin(user);
    return this.systemService.startUpdate();
  }

  // GET /system/update/status
  // Returns whether an update is in flight + a tail of the log file.
  // The UI calls this on a 3s interval while running=true.
  @Get('update/status')
  status(@CurrentUser() user: JwtUser) {
    assertAdmin(user);
    return this.systemService.getStatus();
  }
}
