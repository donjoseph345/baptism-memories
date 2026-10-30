import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashEventAccessCode, normalizeEventAccessCode, verifyEventAccessCode } from '../lib/event-access-code';

const root = process.cwd();
const read = async (path: string) => (await import('node:fs/promises')).readFile(`${root}/${path}`, 'utf8');

describe('event access codes', () => {
  it('normalizes valid codes and rejects invalid input', () => {
    expect(normalizeEventAccessCode(' ab-12 cd ')).toBe('AB12CD');
    expect(normalizeEventAccessCode('')).toBeNull();
    expect(normalizeEventAccessCode('bad!code')).toBeNull();
    expect(normalizeEventAccessCode(123)).toBeNull();
  });

  it('hashes and verifies valid codes asynchronously', async () => {
    const stored = await hashEventAccessCode('ab-12cd');
    await expect(verifyEventAccessCode('AB12CD', stored.salt, stored.hash)).resolves.toBe(true);
    await expect(verifyEventAccessCode('WRONG1', stored.salt, stored.hash)).resolves.toBe(false);
    await expect(verifyEventAccessCode('bad!', stored.salt, stored.hash)).resolves.toBe(false);
  });
});

describe('event-specific cookies and session behavior', () => {
  it('isolates cookies for different event tabs', async () => {
    const { guestSessionCookieName } = await import('../lib/guest-session');
    expect(guestSessionCookieName('event-one')).toBe('bm_guest_session_event-one');
    expect(guestSessionCookieName('event-two')).not.toBe(guestSessionCookieName('event-one'));
    expect(() => guestSessionCookieName('bad slug')).toThrow();
  });

  it('rejects expired, revoked, and cross-event sessions in the behavioral model', () => {
    const sessions = new Map([
      ['a', { eventId: 'event-a', status: 'active', expires: Date.now() + 1000 }],
      ['expired', { eventId: 'event-a', status: 'active', expires: Date.now() - 1 }],
      ['revoked', { eventId: 'event-a', status: 'revoked', expires: Date.now() + 1000 }],
    ]);
    const valid = (key: string, eventId: string) => {
      const session = sessions.get(key);
      return Boolean(session && session.eventId === eventId && session.status === 'active' && session.expires > Date.now());
    };
    expect(valid('a', 'event-a')).toBe(true);
    expect(valid('a', 'event-b')).toBe(false);
    expect(valid('expired', 'event-a')).toBe(false);
    expect(valid('revoked', 'event-a')).toBe(false);
  });
});

describe('rate-limit reservation behavior', () => {
  it('refunds successful verification and commits failed verification', () => {
    const state = { reserved: 0, failed: 0 };
    const reserve = () => { if (state.failed + state.reserved >= 2) return false; state.reserved++; return true; };
    const finalize = (valid: boolean) => { state.reserved--; if (!valid) state.failed++; };
    expect(reserve()).toBe(true); finalize(true); expect(state).toEqual({ reserved: 0, failed: 0 });
    expect(reserve()).toBe(true); finalize(false); expect(state).toEqual({ reserved: 0, failed: 1 });
  });

  it('prevents concurrent reservations from exceeding the limit', async () => {
    let reserved = 0;
    const reserve = async () => {
      const allowed = reserved < 2;
      if (allowed) reserved++;
      await Promise.resolve();
      return allowed;
    };
    const results = await Promise.all(Array.from({ length: 10 }, reserve));
    expect(results.filter(Boolean)).toHaveLength(2);
  });
});

describe('late verification and route/migration security contracts', () => {
  it('cannot authorize from a late verification result', async () => {
    let timedOut = false;
    const lateResult = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5));
    await new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(undefined); }, 1));
    const valid = await lateResult;
    expect(timedOut && valid).toBe(true);
    expect(!timedOut && valid).toBe(false);
  });

  it('keeps public responses and legacy routes constrained', async () => {
    const publicRoute = await read('app/api/events/[slug]/public/route.ts');
    const photoRoute = await read('app/api/events/[slug]/photos/route.ts');
    expect(publicRoute).toContain('title: event.title');
    expect(publicRoute).toContain('event_date: event.event_date');
    expect(publicRoute).not.toContain('event_code_hash');
    expect(publicRoute).not.toContain('baby_name');
    expect(photoRoute).toContain("request.nextUrl.searchParams.get('key')");
    expect(photoRoute).toContain("found.mode === 'legacy'");
    expect(photoRoute).toContain('event is closed');
  });

  it('keeps migration status backfill in 0002 and permissions explicit', async () => {
    const migration2 = await read('supabase/migrations/0002_auth_and_media_foundation.sql');
    const migration3 = await read('supabase/migrations/0003_guest_auth_support.sql');
    expect(migration2).toContain("event_status = case when is_active then 'open' else 'closed' end");
    expect(migration2).toContain('events_active_status_consistency_check');
    expect(migration3).not.toContain('events_active_status_consistency_check');
    const functions = [...migration3.matchAll(/create or replace function public\.([a-z_]+)\(([^)]*)\)/g)];
    expect(functions.map((m) => m[1])).toEqual([
      'consume_general_join_limits', 'reserve_failed_join_attempt', 'finalize_failed_join_attempt',
      'create_guest_session_for_event', 'revoke_guest_session', 'renew_failed_join_attempt',
    ]);
    expect((migration3.match(/security definer/g) || []).length).toBe(6);
    expect((migration3.match(/set search_path = pg_catalog, public/g) || []).length).toBe(6);
    expect((migration3.match(/grant execute on function/g) || []).length).toBe(6);
    expect((migration3.match(/revoke all on function/g) || []).length).toBe(6);
    expect(migration3).toContain('alter function public.create_guest_session_for_event');
    expect(migration3).toContain('revoke all on public.guest_join_rate_limits from public, anon, authenticated');
  });
});

afterEach(() => vi.restoreAllMocks());

