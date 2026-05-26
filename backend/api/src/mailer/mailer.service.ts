import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { SettingsService, SETTING_KEYS } from '../settings/settings.service';

// Thin wrapper around nodemailer.
//
//   - Reads SMTP config from env at startup.
//   - If SMTP_HOST or SMTP_USER is missing, falls back to a "console
//     transport" that logs emails to the backend terminal. Lets devs
//     test the password-reset flow without setting up an SMTP account.
//   - Provides a small library of typed helpers (sendPasswordReset)
//     instead of letting callers craft raw HTML in random places.
@Injectable()
export class MailerService implements OnModuleInit {
  private readonly logger = new Logger(MailerService.name);
  private transporter: Transporter | null = null;
  private fromAddress = 'noreply@example.com';
  private liveMode = false;

  constructor(
    private config: ConfigService,
    private settings: SettingsService,
  ) {}

  async onModuleInit() {
    await this.reconfigure();
  }

  // Rebuild the transporter from the latest settings.
  // Called at startup and any time admin saves new mail settings.
  async reconfigure(): Promise<void> {
    // DB settings beat env; getString handles the fallback chain.
    const host = this.settings.getString(SETTING_KEYS.SMTP_HOST);
    const user = this.settings.getString(SETTING_KEYS.SMTP_USER);
    const from = this.settings.getString(SETTING_KEYS.MAIL_FROM);
    if (from) this.fromAddress = from;

    if (host && user) {
      this.transporter = nodemailer.createTransport({
        host,
        port: this.settings.getNumber(SETTING_KEYS.SMTP_PORT, 587),
        secure: this.settings.getBoolean(SETTING_KEYS.SMTP_SECURE, false),
        auth: {
          user,
          pass: this.settings.getString(SETTING_KEYS.SMTP_PASS),
        },
      });
      this.liveMode = true;
      this.logger.log(`Mailer initialised — sending via ${host}`);
    } else {
      this.transporter = null;
      this.liveMode = false;
      this.logger.warn(
        'SMTP not configured. Emails will be logged to the console only. ' +
          'Set SMTP host/user via /admin/settings or in .env.',
      );
    }
  }

  // Generic send. Most callers should use one of the higher-level
  // helpers below, but this is exposed for ad-hoc usage / testing.
  async send(to: string, subject: string, text: string, html?: string) {
    if (!this.liveMode || !this.transporter) {
      // Dev fallback: log the email to console so devs can copy the
      // reset link without an SMTP setup.
      this.logger.log(
        `\n--- EMAIL (console fallback) ---\n` +
          `To:      ${to}\n` +
          `From:    ${this.fromAddress}\n` +
          `Subject: ${subject}\n\n` +
          `${text}\n` +
          `-------------------------------\n`,
      );
      return;
    }
    await this.transporter.sendMail({
      from: this.fromAddress,
      to,
      subject,
      text,
      html,
    });
  }

  // ---------- High-level helpers ----------

  async sendPasswordReset(to: string, name: string, resetUrl: string) {
    const subject = 'Reset your Credit Recon password';
    const text =
      `Hi ${name},\n\n` +
      `Someone requested a password reset for your account.\n` +
      `If that was you, follow this link to set a new password:\n\n` +
      `${resetUrl}\n\n` +
      `This link expires in 1 hour.\n\n` +
      `If you didn't request this, you can safely ignore this email.\n`;
    const html =
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>Someone requested a password reset for your account.</p>` +
      `<p>If that was you, click the button below to set a new password:</p>` +
      `<p><a href="${resetUrl}" style="display:inline-block;background:#000;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">Reset password</a></p>` +
      `<p style="color:#666;font-size:12px;">Or paste this URL into your browser: ${resetUrl}</p>` +
      `<p style="color:#666;font-size:12px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`;

    await this.send(to, subject, text, html);
  }
}

// Naive HTML escape — good enough for plain user names in email body.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
