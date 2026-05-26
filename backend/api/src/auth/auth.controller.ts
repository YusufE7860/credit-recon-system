import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  UseGuards,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import type { Response } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { CurrentUser } from './current-user.decorator';
import type { JwtUser } from './role.enum';
import { buildCookieOptions } from './session-config';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private usersService: UsersService,
  ) {}

  // GET /auth/me — returns the current logged-in user.
  // Used by the frontend to decide which nav items / UI sections
  // to show based on role. Protected by JWT — anonymous callers get 401.
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: JwtUser) {
    return this.usersService.getUserById(user.sub);
  }

  // Tighter throttle on login: 5 attempts per minute per IP.
  // Stops a credential-stuffing run cold without affecting real users.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(
    // Default to `{}` so a request with no body doesn't crash on access.
    @Body() body: { email?: string; password?: string } = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    // Validate before touching the auth service. Returns a clean 400
    // instead of letting the server crash with TypeError.
    if (!body?.email || !body?.password) {
      throw new BadRequestException(
        'email and password are required in the request body',
      );
    }

    const user = await this.authService.validateUser(
      body.email,
      body.password,
    );

    if (!user) {
      // Throwing this returns a 401 status to the client.
      // Now the frontend can check `response.ok` to detect bad credentials.
      throw new UnauthorizedException('Invalid credentials');
    }

    const token = await this.authService.login(user);

    // Cookie attributes (secure, sameSite, maxAge) come from one
    // helper so login + the sliding-refresh interceptor + logout all
    // agree. maxAge is the inactivity window (default 10 min).
    res.cookie('token', token.access_token, buildCookieOptions());

    // We intentionally don't return the token in the body.
    // The cookie is set automatically by the browser.
    return { success: true, user: { id: user.id, email: user.email, role: user.role } };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    // Clearing with matching attributes is required by some browsers
    // (Safari especially) — otherwise the cookie persists. We reuse
    // the same options the cookie was issued with (minus maxAge).
    const { maxAge: _ignored, ...clearOpts } = buildCookieOptions();
    res.clearCookie('token', clearOpts);
    return { success: true };
  }

  // Step 1 of password reset. Accepts an email, always returns success
  // (so attackers can't probe for valid emails).
  // Throttled to 3/minute so an attacker can't enumerate emails or
  // mailbomb a real user with reset emails.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  async forgotPassword(@Body() body: { email?: string }) {
    if (!body?.email) {
      throw new BadRequestException('email is required');
    }
    return this.authService.forgotPassword(body.email);
  }

  // Step 2 of password reset. Token + new password.
  // Throttled to 5/minute — guards against token-brute-force attempts.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  async resetPassword(
    @Body() body: { token?: string; newPassword?: string },
  ) {
    if (!body?.token || !body?.newPassword) {
      throw new BadRequestException(
        'token and newPassword are required',
      );
    }
    return this.authService.resetPassword(body.token, body.newPassword);
  }
}