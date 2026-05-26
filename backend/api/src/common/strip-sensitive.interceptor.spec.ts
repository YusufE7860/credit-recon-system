import { firstValueFrom, of } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { StripSensitiveInterceptor } from './strip-sensitive.interceptor';

// Helper: run a value through the interceptor and return what the
// outer caller would actually see.
async function runThrough(body: unknown): Promise<unknown> {
  const interceptor = new StripSensitiveInterceptor();
  const handler: CallHandler = {
    handle: () => of(body),
  };
  // ExecutionContext isn't read by the interceptor; cast a stub.
  return firstValueFrom(
    interceptor.intercept({} as ExecutionContext, handler),
  );
}

// JSON.stringify-then-search: catches the field at ANY depth without
// us having to hand-write assertions for nested cases.
function bodyContainsPasswordField(body: unknown): boolean {
  return JSON.stringify(body).includes('"password"');
}

describe('StripSensitiveInterceptor', () => {
  it('removes password from a single user object', async () => {
    const out = await runThrough({
      id: 'u1',
      email: 'a@b.com',
      password: '$2b$10$XXX',
    });
    expect(bodyContainsPasswordField(out)).toBe(false);
    expect(out).toEqual({ id: 'u1', email: 'a@b.com' });
  });

  it('removes password from an array of users', async () => {
    const out = (await runThrough([
      { id: 'u1', email: 'a@b.com', password: 'h1' },
      { id: 'u2', email: 'c@d.com', password: 'h2' },
    ])) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    expect(bodyContainsPasswordField(out)).toBe(false);
    expect(out[0]).not.toHaveProperty('password');
    expect(out[1]).not.toHaveProperty('password');
  });

  it('removes password from a nested user inside another object', async () => {
    const out = await runThrough({
      invoice: { id: 'i1', total: 250 },
      uploader: { id: 'u1', name: 'Jane', password: 'h' },
    });
    expect(bodyContainsPasswordField(out)).toBe(false);
  });

  it('removes deeply nested password fields', async () => {
    const out = await runThrough({
      level1: { level2: { level3: { user: { password: 'h' } } } },
    });
    expect(bodyContainsPasswordField(out)).toBe(false);
  });

  it('also strips token hashes and reset token hashes', async () => {
    const out = (await runThrough({
      token: { id: 't1', tokenHash: 'aaa', userId: 'u1' },
      reset: { resetTokenHash: 'bbb' },
    })) as any;
    expect(out.token).not.toHaveProperty('tokenHash');
    expect(out.reset).not.toHaveProperty('resetTokenHash');
    expect(out.token).toHaveProperty('id');
    expect(out.token).toHaveProperty('userId');
  });

  it('preserves all non-sensitive fields untouched', async () => {
    const input = {
      id: 'u1',
      email: 'a@b.com',
      name: 'Test',
      role: 'ADMIN',
      active: true,
      createdAt: new Date('2024-01-01').toISOString(),
      nested: {
        count: 5,
        list: [1, 2, 3],
        flag: false,
        nothing: null,
      },
    };
    const out = await runThrough(input);
    expect(out).toEqual(input);
  });

  it('handles null and primitive bodies without errors', async () => {
    expect(await runThrough(null)).toBeNull();
    expect(await runThrough(undefined)).toBeUndefined();
    expect(await runThrough('hello')).toBe('hello');
    expect(await runThrough(42)).toBe(42);
    expect(await runThrough(true)).toBe(true);
  });

  it('does not loop forever on cyclic objects', async () => {
    const cyclic: any = { id: 'u1', password: 'h' };
    cyclic.self = cyclic;
    // Should not throw or hang. The password key still gets stripped
    // at the top level.
    const out = (await runThrough(cyclic)) as any;
    expect(out).not.toHaveProperty('password');
  });

  it('preserves Date objects as-is (does not unpack their fields)', async () => {
    const d = new Date('2024-06-15T12:00:00Z');
    const out = (await runThrough({ when: d, password: 'h' })) as any;
    // Date should round-trip through the interceptor without being
    // mangled into a plain object.
    expect(out.when).toBeInstanceOf(Date);
    expect(out).not.toHaveProperty('password');
  });
});
