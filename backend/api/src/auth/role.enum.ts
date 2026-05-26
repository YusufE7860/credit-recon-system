// Single source of truth for the role values used across the app.
// Matches the Postgres enum `Role` defined in schema.prisma.
//
// Why a `const` object instead of a TS `enum`?  TS enums emit runtime
// JavaScript that can be flaky under isolatedModules + emitDecoratorMetadata.
// A `const` object + a derived union type gives the same ergonomics
// (`Role.ADMIN`, `Role` as a type) without the compiler weirdness.
export const Role = {
  USER: 'USER',
  UPLOADER: 'UPLOADER',
  REPORTING: 'REPORTING',
  ADMIN: 'ADMIN',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

// Privileged = sees all org data. UPLOADER does NOT — they see only
// the invoices they personally uploaded.
export function isPrivileged(role: Role): boolean {
  return role === Role.ADMIN || role === Role.REPORTING;
}

// True if the role is one of the "low visibility" roles that should
// NOT see money totals on the dashboard.
export function hidesAmounts(role: Role): boolean {
  return role === Role.UPLOADER;
}

// Shape of the JWT payload attached to req.user by JwtAuthGuard.
// Centralized so callers don't have to keep re-typing it.
export interface JwtUser {
  sub: string;   // user id
  email: string;
  role: Role;
}
