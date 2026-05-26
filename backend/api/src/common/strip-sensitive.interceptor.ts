import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// Field names that must NEVER appear in a JSON response, no matter
// what. The interceptor walks every response body and deletes any
// occurrence at any depth.
//
// This is belt-and-braces defense — every individual service already
// uses `select` to omit `password`, but if any future code path
// forgets, this still catches it. Tiny perf cost (one tree walk per
// response) for a meaningful security guarantee.
const SENSITIVE_KEYS = new Set<string>([
  'password',
  'passwordHash',
  'tokenHash',
  'resetTokenHash',
]);

@Injectable()
export class StripSensitiveInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => this.scrub(body)));
  }

  private scrub(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;

    // Don't touch Buffer / Stream / Date — Nest serializes those specially.
    if (
      value instanceof Date ||
      Buffer.isBuffer(value as any) ||
      typeof (value as any).pipe === 'function'
    ) {
      return value;
    }

    // Cycle protection — shouldn't happen in JSON responses but defensive.
    if (seen.has(value as object)) return value;
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => this.scrub(item, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) continue;
      out[key] = this.scrub(v, seen);
    }
    return out;
  }
}
