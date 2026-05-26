import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { UsersService } from '../users/users.service';
import { AuditLogService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

// How long a password reset link is valid for.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private prisma: PrismaService,
    private mailer: MailerService,
    private config: ConfigService,
    private audit: AuditLogService,
  ) {}

  async validateUser(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      await this.audit.record({
        action: AuditAction.USER_LOGIN_FAILED,
        metadata: { email, reason: 'no_such_user' },
      });
      return null;
    }
    if (!user.active) {
      await this.audit.record({
        actorId: user.id,
        action: AuditAction.USER_LOGIN_FAILED,
        metadata: { email, reason: 'inactive' },
      });
      return null;
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      await this.audit.record({
        actorId: user.id,
        action: AuditAction.USER_LOGIN_FAILED,
        metadata: { email, reason: 'bad_password' },
      });
      return null;
    }

    await this.audit.record({
      actorId: user.id,
      action: AuditAction.USER_LOGIN_SUCCESS,
      metadata: { email },
    });
    return user;
  }

  async login(user: { id: string; email: string; role: string }) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  // ---------- Password reset flow ----------

  // Step 1: user submits their email. We create a token + send the email.
  // SECURITY: We return success even if the email doesn't exist, so the
  // endpoint can't be used to enumerate registered emails.
  async forgotPassword(email: string) {
    const user = await this.usersService.findByEmail(email);

    // Always return the same shape — leak nothing about existence.
    if (!user || !user.active) {
      this.logger.log(
        `Password reset requested for ${email} — no active user (silent).`,
      );
      return { success: true };
    }

    // Generate a strong random token. We send the RAW token in the email,
    // but only store its SHA-256 hash in the DB. If the DB is compromised
    // the attacker can't replay outstanding reset links.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001';
    const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

    await this.mailer.sendPasswordReset(user.email, user.name, resetUrl);

    return { success: true };
  }

  // Step 2: user clicks the link, posts the token + new password.
  async resetPassword(rawToken: string, newPassword: string) {
    if (!rawToken || newPassword.length < 8) {
      throw new BadRequestException(
        'Token and new password (min 8 chars) are required.',
      );
    }

    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!record) {
      throw new BadRequestException('Invalid or expired reset link.');
    }
    if (record.usedAt) {
      throw new BadRequestException(
        'This reset link has already been used.',
      );
    }
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This reset link has expired.');
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    // Update the password + mark the token used, atomically.
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { password: hashed },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      // Also invalidate any other outstanding reset tokens for this user.
      this.prisma.passwordResetToken.updateMany({
        where: {
          userId: record.userId,
          usedAt: null,
          id: { not: record.id },
        },
        data: { usedAt: new Date() },
      }),
    ]);

    return { success: true };
  }
}
