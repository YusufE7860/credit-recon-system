import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';

// Stable list of keys we accept — guards against typos that would
// silently store garbage rows. UI sends settings as a flat dict.
export const SETTING_KEYS = {
  // Mail
  SMTP_HOST: 'smtp.host',
  SMTP_PORT: 'smtp.port',
  SMTP_SECURE: 'smtp.secure',
  SMTP_USER: 'smtp.user',
  SMTP_PASS: 'smtp.pass',
  MAIL_FROM: 'mail.from',

  // FX rates (per ISO currency code → ZAR)
  FX_USD: 'fx.usd',
  FX_EUR: 'fx.eur',
  FX_GBP: 'fx.gbp',
  FX_CNY: 'fx.cny',
  FX_JPY: 'fx.jpy',
  FX_SAR: 'fx.sar',
  FX_AED: 'fx.aed',
  FX_AUD: 'fx.aud',
  FX_CAD: 'fx.cad',
  FX_INR: 'fx.inr',

  // Reconciliation thresholds
  RECON_AMOUNT_TOLERANCE: 'recon.amountTolerance',
  RECON_DATE_TOLERANCE_DAYS: 'recon.dateToleranceDays',
  RECON_MERCHANT_THRESHOLD: 'recon.merchantThreshold',
  RECON_MIN_SCORE: 'recon.minScore',

  // Edit-request unlock window (hours)
  EDIT_UNLOCK_HOURS: 'editRequest.unlockHours',

  // AI invoice extraction (Claude vision)
  AI_ANTHROPIC_KEY: 'ai.anthropicKey',
  AI_MODEL: 'ai.model',                        // primary (fast, cheap)
  AI_FALLBACK_MODEL: 'ai.fallbackModel',       // used when primary is unsure
  AI_FALLBACK_THRESHOLD: 'ai.fallbackThreshold', // confidence below this triggers fallback
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

// Env-var name that backs each key, so deletion of a DB setting falls
// back to the existing .env config (no behaviour change on first install).
const ENV_FALLBACK: Partial<Record<SettingKey, string>> = {
  [SETTING_KEYS.SMTP_HOST]:   'SMTP_HOST',
  [SETTING_KEYS.SMTP_PORT]:   'SMTP_PORT',
  [SETTING_KEYS.SMTP_SECURE]: 'SMTP_SECURE',
  [SETTING_KEYS.SMTP_USER]:   'SMTP_USER',
  [SETTING_KEYS.SMTP_PASS]:   'SMTP_PASS',
  [SETTING_KEYS.MAIL_FROM]:   'MAIL_FROM',
  [SETTING_KEYS.FX_USD]:      'FX_USD_ZAR',
  [SETTING_KEYS.FX_EUR]:      'FX_EUR_ZAR',
  [SETTING_KEYS.FX_GBP]:      'FX_GBP_ZAR',
  [SETTING_KEYS.FX_CNY]:      'FX_CNY_ZAR',
  [SETTING_KEYS.FX_JPY]:      'FX_JPY_ZAR',
  [SETTING_KEYS.FX_SAR]:      'FX_SAR_ZAR',
  [SETTING_KEYS.FX_AED]:      'FX_AED_ZAR',
  [SETTING_KEYS.FX_AUD]:      'FX_AUD_ZAR',
  [SETTING_KEYS.FX_CAD]:      'FX_CAD_ZAR',
  [SETTING_KEYS.FX_INR]:      'FX_INR_ZAR',
  [SETTING_KEYS.AI_ANTHROPIC_KEY]: 'ANTHROPIC_API_KEY',
};

// In-process cache so we don't hit the DB on every recon-scoring call.
// Invalidated by setMany() so a save is immediately reflected.
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private cache: Map<string, unknown> = new Map();
  private loaded = false;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.refresh();
  }

  // Reload all settings into the in-process cache.
  async refresh(): Promise<void> {
    const rows = await this.prisma.setting.findMany();
    this.cache = new Map(rows.map((r) => [r.key, r.value]));
    this.loaded = true;
  }

  // Typed getters — DB value first, falling back to env, then default.
  getString(key: SettingKey, fallback = ''): string {
    const v = this.cache.get(key);
    if (typeof v === 'string') return v;
    const env = ENV_FALLBACK[key];
    if (env) {
      const envVal = this.config.get<string>(env);
      if (envVal != null) return envVal;
    }
    return fallback;
  }

  getNumber(key: SettingKey, fallback: number): number {
    const v = this.cache.get(key);
    if (typeof v === 'number' && !isNaN(v)) return v;
    if (typeof v === 'string') {
      const parsed = parseFloat(v);
      if (!isNaN(parsed)) return parsed;
    }
    const env = ENV_FALLBACK[key];
    if (env) {
      const envVal = this.config.get<string>(env);
      if (envVal != null) {
        const parsed = parseFloat(envVal);
        if (!isNaN(parsed)) return parsed;
      }
    }
    return fallback;
  }

  getBoolean(key: SettingKey, fallback = false): boolean {
    const v = this.cache.get(key);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true';
    const env = ENV_FALLBACK[key];
    if (env) {
      const envVal = this.config.get<string>(env);
      if (envVal != null) return envVal === 'true';
    }
    return fallback;
  }

  // Returns the full settings dict for the UI to render. Sensitive
  // values (SMTP_PASS) are returned only as a boolean "isSet" flag —
  // we don't ship plaintext passwords to the frontend.
  async readForAdmin() {
    if (!this.loaded) await this.refresh();
    const out: Record<string, unknown> = {};
    for (const key of Object.values(SETTING_KEYS)) {
      const v = this.cache.get(key);
      if (key === SETTING_KEYS.SMTP_PASS || key === SETTING_KEYS.AI_ANTHROPIC_KEY) {
        // Sensitive — return only an "is set" indicator.
        // The UI swaps this back to the real value on save (or leaves it
        // alone so an empty submit doesn't clear an existing key).
        out[key] = v ? '__set__' : '';
      } else {
        out[key] = v ?? '';
      }
    }
    return out;
  }

  // Bulk upsert. Validates keys against SETTING_KEYS.
  async setMany(
    input: Record<string, unknown>,
    updatedBy: string | null,
  ): Promise<void> {
    const allowed = new Set<string>(Object.values(SETTING_KEYS));
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.has(key)) {
        this.logger.warn(`Ignoring unknown settings key: ${key}`);
        continue;
      }
      // Don't write empty strings — treat as "unset".
      if (value === '' || value == null) {
        await this.prisma.setting.deleteMany({ where: { key } });
        this.cache.delete(key);
        continue;
      }
      // Special: passing the sentinel "__set__" for sensitive fields
      // (SMTP_PASS, AI key) means "don't change". Skip.
      if (
        (key === SETTING_KEYS.SMTP_PASS || key === SETTING_KEYS.AI_ANTHROPIC_KEY) &&
        value === '__set__'
      ) continue;

      // Cast to InputJsonValue (write-side type) — null/empty was already
      // filtered above, so this is safe even though the union excludes null.
      await this.prisma.setting.upsert({
        where: { key },
        update: { value: value as Prisma.InputJsonValue, updatedBy },
        create: { key, value: value as Prisma.InputJsonValue, updatedBy },
      });
      this.cache.set(key, value);
    }
  }
}
