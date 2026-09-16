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
      // Skip TLS hostname verification when the admin has flipped the
      // toggle — needed for shared-cPanel style SMTP where the vanity
      // hostname doesn't match the wildcard cert served up. Full TLS
      // negotiation and encryption still happen; ONLY the hostname
      // check is bypassed. Default off (full verification).
      const skipTlsVerify = this.settings.getBoolean(
        SETTING_KEYS.SMTP_TLS_REJECT_UNAUTHORIZED,
        false,
      );
      this.transporter = nodemailer.createTransport({
        host,
        port: this.settings.getNumber(SETTING_KEYS.SMTP_PORT, 587),
        secure: this.settings.getBoolean(SETTING_KEYS.SMTP_SECURE, false),
        tls: skipTlsVerify
          ? { rejectUnauthorized: false }
          : undefined,
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

  // Helper — grab the app's public URL from settings/env so email
  // links point at the right host regardless of where the API is
  // deployed. Falls back to a sensible-ish default in dev.
  private appUrl(): string {
    // Same env key used by the password-reset flow — one source of truth
    // for "where the user's browser reaches the frontend from".
    return (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3001'
    );
  }

  // Sent to a cardholder whenever a statement is uploaded that includes
  // one of their cards. Lists their unmatched transactions inside the
  // statement's period so they can go and upload the missing receipts.
  async sendStatementUploadedToCardholder(params: {
    to: string;
    name: string;
    statementName: string;
    periodStart: Date | null;
    periodEnd: Date | null;
    unmatched: Array<{ merchant: string; amount: number; date: Date; cardLast4: string | null }>;
  }) {
    const { to, name, statementName, periodStart, periodEnd, unmatched } = params;
    const url = this.appUrl();
    const period =
      periodStart && periodEnd
        ? `${fmtDate(periodStart)} — ${fmtDate(periodEnd)}`
        : 'the latest period';
    const subject =
      unmatched.length > 0
        ? `${unmatched.length} receipt${unmatched.length === 1 ? '' : 's'} needed — statement uploaded (${period})`
        : `New statement uploaded (${period}) — please review`;

    const list = unmatched
      .map(
        (t) =>
          `  • ${fmtDate(t.date)} — ${t.merchant} — R ${t.amount.toFixed(2)}${t.cardLast4 ? ` (…${t.cardLast4})` : ''}`,
      )
      .join('\n');

    const text =
      `Hi ${name},\n\n` +
      `A new credit-card statement has been uploaded covering ${period}.\n\n` +
      (unmatched.length > 0
        ? `We couldn't match ${unmatched.length} of your transaction${unmatched.length === 1 ? '' : 's'} to a receipt:\n\n${list}\n\n` +
          `Please upload the missing receipts (or match them to existing ones) so accounts can close the period:\n${url}/transactions?matched=unmatched\n\n`
        : `All your transactions on this statement already have matching receipts — thanks for staying on top of it. You can double-check here:\n${url}/dashboard\n\n`) +
      `— FFG Recon\n`;

    const listHtml = unmatched
      .map(
        (t) =>
          `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${fmtDate(t.date)}</td>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(t.merchant)}${t.cardLast4 ? ` <span style="color:#888">…${t.cardLast4}</span>` : ''}</td>` +
          `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums;">R ${t.amount.toFixed(2)}</td></tr>`,
      )
      .join('');

    const html =
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>A new credit-card statement <strong>${escapeHtml(statementName)}</strong> has been uploaded, covering <strong>${escapeHtml(period)}</strong>.</p>` +
      (unmatched.length > 0
        ? `<p>We couldn't match <strong>${unmatched.length}</strong> of your transaction${unmatched.length === 1 ? '' : 's'} to a receipt yet:</p>` +
          `<table style="border-collapse:collapse;margin:8px 0 16px 0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;">${listHtml}</table>` +
          `<p><a href="${url}/transactions?matched=unmatched" style="display:inline-block;background:#f97316;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Upload missing receipts</a></p>`
        : `<p>All your transactions on this statement already have matching receipts — thanks for staying on top of it.</p>` +
          `<p><a href="${url}/dashboard" style="display:inline-block;background:#f97316;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open dashboard</a></p>`) +
      `<p style="color:#666;font-size:12px;margin-top:24px;">— FFG Recon</p>`;

    await this.send(to, subject, text, html);
  }

  // Sent to every ADMIN when a USER / UPLOADER raises an edit request.
  async sendEditRequestToAdmin(params: {
    to: string;
    adminName: string;
    requesterName: string;
    requesterRole: string;
    invoiceSupplier: string;
    invoiceId: string;
    reason: string;
    fields?: string | null;
    type: 'FINANCIAL' | 'METADATA';
  }) {
    const {
      to, adminName, requesterName, requesterRole,
      invoiceSupplier, invoiceId, reason, fields, type,
    } = params;
    const url = this.appUrl();
    const subject = `Edit request: ${requesterName} → ${invoiceSupplier}`;

    const text =
      `Hi ${adminName},\n\n` +
      `${requesterName} (${requesterRole}) has requested a ${type.toLowerCase()} edit on:\n` +
      `  ${invoiceSupplier}\n\n` +
      `Reason:\n  ${reason}\n\n` +
      (fields ? `Fields they want changed:\n  ${fields}\n\n` : '') +
      `Review it here:\n${url}/admin/edit-requests\n\n` +
      `Or open the invoice directly:\n${url}/invoices/${invoiceId}\n`;

    const html =
      `<p>Hi ${escapeHtml(adminName)},</p>` +
      `<p><strong>${escapeHtml(requesterName)}</strong> <span style="color:#888">(${escapeHtml(requesterRole)})</span> has requested a <strong>${type.toLowerCase()}</strong> edit on:</p>` +
      `<p style="padding:8px 12px;background:#f8fafc;border-left:3px solid #f97316;margin:8px 0;">${escapeHtml(invoiceSupplier)}</p>` +
      `<p><strong>Reason:</strong><br>${escapeHtml(reason).replace(/\n/g, '<br>')}</p>` +
      (fields
        ? `<p><strong>Fields to change:</strong><br>${escapeHtml(fields).replace(/\n/g, '<br>')}</p>`
        : '') +
      `<p style="margin-top:16px;"><a href="${url}/admin/edit-requests" style="display:inline-block;background:#f97316;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Review request</a> ` +
      `<a href="${url}/invoices/${invoiceId}" style="display:inline-block;background:#fff;color:#111;border:1px solid #e2e8f0;padding:10px 20px;border-radius:8px;text-decoration:none;margin-left:6px;">Open invoice</a></p>` +
      `<p style="color:#666;font-size:12px;margin-top:24px;">— FFG Recon</p>`;

    await this.send(to, subject, text, html);
  }

  // Sent to a cardholder when an admin uses "Notify" on an unmatched
  // transaction — mirrors the in-app notification with an email so
  // users who don't check the app daily still see it.
  async sendInvoiceChaseToUser(params: {
    to: string;
    name: string;
    merchant: string;
    amount: number;
    transactionDate: Date;
    cardLast4: string | null;
  }) {
    const { to, name, merchant, amount, transactionDate, cardLast4 } = params;
    const url = this.appUrl();
    const subject = `Receipt needed: ${merchant} — R ${amount.toFixed(2)}`;

    const text =
      `Hi ${name},\n\n` +
      `Please upload the receipt for the following card transaction:\n\n` +
      `  ${fmtDate(transactionDate)} — ${merchant} — R ${amount.toFixed(2)}` +
      (cardLast4 ? ` (card …${cardLast4})` : '') +
      `\n\nUpload it here:\n${url}/upload\n\n` +
      `— FFG Recon\n`;

    const html =
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>Please upload the receipt for this card transaction:</p>` +
      `<table style="border-collapse:collapse;margin:8px 0 16px 0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;">` +
      `<tr><td style="padding:4px 10px 4px 0;color:#666;">Date</td><td style="padding:4px 0;">${fmtDate(transactionDate)}</td></tr>` +
      `<tr><td style="padding:4px 10px 4px 0;color:#666;">Merchant</td><td style="padding:4px 0;"><strong>${escapeHtml(merchant)}</strong></td></tr>` +
      `<tr><td style="padding:4px 10px 4px 0;color:#666;">Amount</td><td style="padding:4px 0;font-variant-numeric:tabular-nums;"><strong>R ${amount.toFixed(2)}</strong></td></tr>` +
      (cardLast4 ? `<tr><td style="padding:4px 10px 4px 0;color:#666;">Card</td><td style="padding:4px 0;">…${escapeHtml(cardLast4)}</td></tr>` : '') +
      `</table>` +
      `<p><a href="${url}/upload" style="display:inline-block;background:#f97316;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Upload receipt</a></p>` +
      `<p style="color:#666;font-size:12px;margin-top:24px;">— FFG Recon</p>`;

    await this.send(to, subject, text, html);
  }

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

// Short DD MMM YYYY for email bodies.
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

// Naive HTML escape — good enough for plain user names in email body.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
