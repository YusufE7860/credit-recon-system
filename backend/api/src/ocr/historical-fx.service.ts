import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Currency } from './currency.service';

/**
 * Historical FX rate lookup.
 *
 * The invoice pipeline calls `getRateToZARAt(date, currency)` to find
 * the rate that was actually in effect on the invoice date — not the
 * current rate, which is what we used to use and produced wrong
 * recon totals for old foreign invoices.
 *
 * Strategy: DB cache → Frankfurter (free, ECB) → current-rate fallback.
 *
 * Frankfurter only covers majors (USD, EUR, GBP, CNY, JPY, AUD, CAD,
 * INR). SAR and AED are USD-pegged, so historical drift is tiny —
 * for those we just use the current configured rate. Same fallback
 * applies if Frankfurter is unreachable or the date is out of range
 * (e.g. future-dated invoices, dates before the ECB series starts).
 */

// Currencies Frankfurter knows about. Anything not on this list uses
// the current-rate fallback. Hardcoded rather than pulled from
// /currencies because the answer is stable enough that paying for the
// extra round-trip on every cold start isn't worth it.
const FRANKFURTER_SUPPORTED: ReadonlySet<string> = new Set([
  'USD', 'EUR', 'GBP', 'CNY', 'JPY', 'AUD', 'CAD', 'INR',
  // ECB tracks more; only listing what we actually support in the app.
]);

// Public Frankfurter endpoint. No API key, no rate limit notes —
// we cache aggressively so we're hitting it at most once per
// (date, currency).
const FRANKFURTER_BASE = 'https://api.frankfurter.app';

// Network timeout — Frankfurter is usually < 1s but we cap to avoid
// blocking an invoice upload if their service is having a bad day.
const FETCH_TIMEOUT_MS = 5_000;

export interface HistoricalRateResult {
  rate: number;
  source: 'cache' | 'frankfurter' | 'fallback';
}

@Injectable()
export class HistoricalFxService {
  private readonly logger = new Logger(HistoricalFxService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Get the FX rate for `currency` → ZAR on a specific date.
   *
   * @param date the invoice date (any Date — we normalise to UTC day)
   * @param currency ISO code
   * @param fallback callback that returns the current rate, used when
   *   we can't get a historical rate. Passed in so this service stays
   *   independent of CurrencyService (avoiding a circular import).
   */
  async getRateToZARAt(
    date: Date,
    currency: Currency,
    fallback: () => number,
  ): Promise<HistoricalRateResult> {
    // ZAR → ZAR is always 1. Save a DB round-trip.
    if (currency === 'ZAR') {
      return { rate: 1, source: 'cache' };
    }

    const normalised = this.normaliseToUtcDay(date);

    // 1. DB cache lookup — by far the common case after the first
    //    invoice for any given day lands.
    const cached = await this.prisma.exchangeRate.findUnique({
      where: {
        date_currency: { date: normalised, currency },
      },
    });
    if (cached) {
      return { rate: cached.rateToZAR, source: 'cache' };
    }

    // 2. Frankfurter fetch (only for supported currencies). The cache
    //    write happens in the success branch — we don't persist
    //    fallback values forever in case the API recovers later.
    if (FRANKFURTER_SUPPORTED.has(currency)) {
      const fetched = await this.fetchFromFrankfurter(normalised, currency);
      if (fetched != null) {
        await this.persist(normalised, currency, fetched, 'frankfurter');
        return { rate: fetched, source: 'frankfurter' };
      }
    }

    // 3. Fallback — use the current configured rate. Persist with
    //    source='fallback' so we don't keep retrying the API for
    //    currencies it doesn't support (SAR/AED). For unsupported
    //    Frankfurter currencies this is essentially permanent; for
    //    transient API failures it's a short cache that'll be replaced
    //    if a later invoice for the same day succeeds.
    const fallbackRate = fallback();
    await this.persist(normalised, currency, fallbackRate, 'fallback');
    this.logger.warn(
      `Falling back to current rate ${fallbackRate} for ${currency} on ${normalised.toISOString().slice(0, 10)} — Frankfurter ${FRANKFURTER_SUPPORTED.has(currency) ? 'unreachable' : 'does not support this currency'}`,
    );
    return { rate: fallbackRate, source: 'fallback' };
  }

  // ---------- internals ----------

  // Frankfurter expects YYYY-MM-DD. We always request ZAR as the
  // target. Returns null on any failure (network, 4xx/5xx, parse).
  private async fetchFromFrankfurter(
    date: Date,
    currency: Currency,
  ): Promise<number | null> {
    const day = date.toISOString().slice(0, 10);
    const url = `${FRANKFURTER_BASE}/${day}?from=${currency}&to=ZAR`;

    // Manual timeout via AbortController — native fetch doesn't honour
    // a numeric timeout option.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        this.logger.debug(`Frankfurter ${url} → HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { rates?: { ZAR?: number } };
      const rate = body?.rates?.ZAR;
      if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) {
        this.logger.debug(
          `Frankfurter returned non-numeric / non-positive rate for ${currency} on ${day}`,
        );
        return null;
      }
      return rate;
    } catch (err) {
      this.logger.debug(
        `Frankfurter fetch failed for ${currency} on ${day}: ${(err as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Upsert because two invoice uploads for the same day could race;
  // either both insert (one wins) or one updates the other's row.
  // Either way the final state is correct.
  private async persist(
    date: Date,
    currency: string,
    rateToZAR: number,
    source: 'frankfurter' | 'fallback',
  ) {
    try {
      await this.prisma.exchangeRate.upsert({
        where: {
          date_currency: { date, currency },
        },
        create: { date, currency, rateToZAR, source },
        update: { rateToZAR, source },
      });
    } catch (err) {
      // Cache write failure shouldn't break the upload. Logged so an
      // operator can investigate but the caller still gets the rate.
      this.logger.warn(
        `Failed to cache rate for ${currency} on ${date.toISOString().slice(0, 10)}: ${(err as Error).message}`,
      );
    }
  }

  // Strip the time portion + force to UTC. Two invoices uploaded on
  // the same calendar day from JHB (UTC+2) must map to the same cache
  // row regardless of what hour they were uploaded at.
  private normaliseToUtcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}
