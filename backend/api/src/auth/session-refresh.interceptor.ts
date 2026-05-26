import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { buildCookieOptions } from './session-config';

/**
 * Sliding-session refresh.
 *
 * Runs after JwtAuthGuard, so by the time this fires we know whether
 * the request was authenticated (req.user is set by passport-jwt) AND
 * whether the original cookie was valid (otherwise the guard would
 * have already 401'd).
 *
 * We re-issue the EXISTING JWT cookie with a fresh maxAge after every
 * authenticated, successful response. The net effect: the inactivity
 * window resets on every interaction, so an actively-used session
 * never times out, but a closed/idle browser hits the wall after the
 * configured window.
 *
 * Special cases:
 *   - /auth/login → already sets a fresh cookie; we skip to avoid
 *     stomping on it (especially the freshly-rotated token).
 *   - /auth/logout → just cleared the cookie; we skip so we don't
 *     accidentally bring it back from the dead.
 */
@Injectable()
export class SessionRefreshInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SessionRefreshInterceptor.name);

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      tap(() => {
        // HTTP-only — skip cleanly for non-HTTP contexts (e.g. WS).
        if (context.getType() !== 'http') return;
        const http = context.switchToHttp();
        const req = http.getRequest<Request & { user?: unknown }>();
        const res = http.getResponse<Response>();

        // Skip if the route didn't authenticate (no req.user means
        // either no guard ran or it was an anonymous endpoint).
        if (!req.user) return;

        // Skip auth lifecycle endpoints — they manage the cookie
        // themselves and re-issuing here would either duplicate
        // (login) or undo (logout) their work.
        const url = req.originalUrl ?? req.url ?? '';
        if (
          url.startsWith('/auth/login') ||
          url.startsWith('/auth/logout')
        ) {
          return;
        }

        // The current token comes in on req.cookies.token — passport
        // already validated it, so this value is good to re-issue.
        // If the cookie middleware isn't wired (it should be — main.ts
        // registers cookie-parser), bail rather than crash.
        const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
        const currentToken = cookies?.token;
        if (!currentToken) return;

        try {
          res.cookie('token', currentToken, buildCookieOptions());
        } catch (err) {
          // A response that's already been sent (e.g. streamed) can't
          // accept a new cookie — log and move on. Not fatal.
          this.logger.debug(
            `Skipped session refresh: ${(err as Error).message}`,
          );
        }
      }),
    );
  }
}
