import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService, SETTING_KEYS, SettingKey } from '../settings/settings.service';
import { HistoricalFxService } from './historical-fx.service';

// ISO 4217 codes for currencies we recognise.
export type Currency =
  | 'ZAR'
  | 'USD'
  | 'EUR'
  | 'GBP'
  | 'CNY'   // Chinese Yuan / Renminbi
  | 'JPY'   // Japanese Yen
  | 'SAR'   // Saudi Riyal
  | 'AED'   // UAE Dirham
  | 'AUD'   // Australian Dollar
  | 'CAD'   // Canadian Dollar
  | 'INR';  // Indian Rupee

// Human-friendly metadata used by the UI dropdown.
export const CURRENCIES: Array<{
  code: Currency;
  label: string;
  symbol: string;
}> = [
  { code: 'ZAR', label: 'South African Rand', symbol: 'R' },
  { code: 'USD', label: 'US Dollar',          symbol: '$' },
  { code: 'GBP', label: 'British Pound',      symbol: '£' },
  { code: 'EUR', label: 'Euro',               symbol: '€' },
  { code: 'CNY', label: 'Chinese Yuan',       symbol: '¥' },
  { code: 'JPY', label: 'Japanese Yen',       symbol: '¥' },
  { code: 'SAR', label: 'Saudi Riyal',        symbol: 'SR' },
  { code: 'AED', label: 'UAE Dirham',         symbol: 'AED' },
  { code: 'AUD', label: 'Australian Dollar',  symbol: 'A$' },
  { code: 'CAD', label: 'Canadian Dollar',    symbol: 'C$' },
  { code: 'INR', label: 'Indian Rupee',       symbol: '₹' },
];

// Fallback rates against ZAR when no env var is set. Conservative
// approximations — admin should override via FX_<CODE>_ZAR env vars
// in production. ZAR is always 1.
const FALLBACK_RATES: Record<Currency, number> = {
  ZAR: 1,
  USD: 18.50,
  GBP: 23.50,
  EUR: 20.20,
  CNY: 2.55,
  JPY: 0.12,
  SAR: 4.93,
  AED: 5.04,
  AUD: 12.15,
  CAD: 13.40,
  INR: 0.22,
};

// Mapping from currency code → matching SettingKey for its ZAR rate.
const FX_KEY_FOR: Partial<Record<string, SettingKey>> = {
  USD: SETTING_KEYS.FX_USD,
  EUR: SETTING_KEYS.FX_EUR,
  GBP: SETTING_KEYS.FX_GBP,
  CNY: SETTING_KEYS.FX_CNY,
  JPY: SETTING_KEYS.FX_JPY,
  SAR: SETTING_KEYS.FX_SAR,
  AED: SETTING_KEYS.FX_AED,
  AUD: SETTING_KEYS.FX_AUD,
  CAD: SETTING_KEYS.FX_CAD,
  INR: SETTING_KEYS.FX_INR,
};

@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);

  constructor(
    private config: ConfigService,
    private settings: SettingsService,
    private historicalFx: HistoricalFxService,
  ) {}

  // Detect the currency a snippet of invoice text appears to be in.
  // Currency codes get a 2x weight over bare symbols because they're
  // unambiguous; $/¥ are shared across currencies so they get less.
  detect(text: string): Currency {
    const counts: Record<Currency, number> = {
      ZAR: 0, USD: 0, EUR: 0, GBP: 0,
      CNY: 0, JPY: 0, SAR: 0, AED: 0,
      AUD: 0, CAD: 0, INR: 0,
    };

    // ISO codes — strong signals.
    for (const code of Object.keys(counts) as Currency[]) {
      const re = new RegExp(`\\b${code}\\b`, 'gi');
      counts[code] += (text.match(re) ?? []).length * 2;
    }

    // Common spelled-out names — also strong.
    const namePatterns: Array<[Currency, RegExp]> = [
      ['CNY', /\b(yuan|renminbi|rmb)\b/gi],
      ['JPY', /\b(yen)\b/gi],
      ['SAR', /\b(riyal|saudi)\b/gi],
      ['AED', /\b(dirham)\b/gi],
      ['INR', /\b(rupee|rupees|inr)\b/gi],
      ['GBP', /\b(pound|sterling)\b/gi],
      ['EUR', /\b(euro|euros)\b/gi],
      ['ZAR', /\b(rand|rands)\b/gi],
    ];
    for (const [code, re] of namePatterns) {
      counts[code] += (text.match(re) ?? []).length * 2;
    }

    // Symbols are weaker signals. "$" could be USD, AUD, or CAD —
    // we attribute to USD by default. "¥" similar for CNY vs JPY.
    counts.USD += (text.match(/\$(?!A|C)/g) ?? []).length;       // $ but not A$/C$
    counts.AUD += (text.match(/A\$/g) ?? []).length;
    counts.CAD += (text.match(/C\$/g) ?? []).length;
    counts.EUR += (text.match(/€/g) ?? []).length;
    counts.GBP += (text.match(/£/g) ?? []).length;
    counts.INR += (text.match(/₹/g) ?? []).length;
    counts.CNY += (text.match(/¥/g) ?? []).length;
    // "R 100" / "R100" is the ZAR convention.
    counts.ZAR += (text.match(/R\s*\d/g) ?? []).length;

    let winner: Currency = 'ZAR';
    let max = 0;
    for (const c of Object.keys(counts) as Currency[]) {
      if (counts[c] > max) {
        winner = c;
        max = counts[c];
      }
    }
    return max === 0 ? 'ZAR' : winner;
  }

  // Look up rate that converts `from` → ZAR.
  // Precedence: DB settings → env var → hardcoded fallback.
  getRateToZAR(from: Currency): number {
    if (from === 'ZAR') return 1;
    const key = FX_KEY_FOR[from];
    if (key) {
      const v = this.settings.getNumber(key, NaN);
      if (!isNaN(v) && v > 0) return v;
    }
    return FALLBACK_RATES[from];
  }

  toZAR(amount: number, currency: Currency): { amount: number; rate: number } {
    const rate = this.getRateToZAR(currency);
    return {
      amount: Math.round(amount * rate * 100) / 100,
      rate,
    };
  }

  // Historical conversion — uses the rate that was actually in
  // effect on `date`, not today's rate. This is what the invoice
  // pipeline should call so a USD invoice dated March 2024 reconciles
  // against its bank transaction using March 2024's exchange rate.
  //
  // Falls through to the current rate when:
  //   - The currency isn't on Frankfurter's list (SAR, AED)
  //   - The API is down or the date is out of its range (future / pre-1999)
  // In both cases the source field tells you what happened.
  //
  // BANK MARKUP: published ECB rates are mid-market. South African card
  // issuers add a 2–3.5% markup on every foreign-currency transaction
  // (the "currency conversion fee"), so the rate the BANK charges is
  // always higher than the published rate. We multiply the base rate by
  // (1 + markup/100) so invoice.totalZAR comes out close to what the
  // bank actually charged — the matching engine compares against that
  // figure, so it has to match the bank's reality. Configurable via
  // FX_MARKUP_PERCENT in Settings; defaults to 2.5%.
  async toZARAtDate(
    amount: number,
    currency: Currency,
    date: Date,
  ): Promise<{ amount: number; rate: number; source: string }> {
    const { rate: baseRate, source } = await this.historicalFx.getRateToZARAt(
      date,
      currency,
      () => this.getRateToZAR(currency),
    );
    // Markup is stored as a percent. 2.5 → multiply by 1.025.
    // Skip for ZAR → ZAR (rate = 1, no markup to apply).
    const markupPercent =
      currency === 'ZAR'
        ? 0
        : this.settings.getNumber(
            SETTING_KEYS.FX_MARKUP_PERCENT,
            DEFAULT_FX_MARKUP_PERCENT,
          );
    const adjustedRate = baseRate * (1 + markupPercent / 100);
    return {
      amount: Math.round(amount * adjustedRate * 100) / 100,
      rate: adjustedRate,
      source,
    };
  }
}

// Default markup % when no Setting row exists. 2.5% is a reasonable
// middle of the road for SA card issuers (FNB / Standard Bank / Absa
// typically charge 2–3.5%). Operators can override via the Settings
// page or by writing a DB row directly.
const DEFAULT_FX_MARKUP_PERCENT = 2.5;
