import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const GUEST_SESSION_COOKIE_PREFIX = 'bm_guest_session_';
const SLUG_PATTERN = /^[a-z0-9-]{3,100}$/;

export function guestSessionCookieName(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) throw new Error('Invalid event slug.');
  return `${GUEST_SESSION_COOKIE_PREFIX}${slug}`;
}
export const GUEST_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

type GuestSession = {
  id: string;
  event_id: string;
  guest_id: string;
  expires_at: string;
  session_status: 'active' | 'expired' | 'revoked';
};

function sessionHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createSessionIdentifier(): string {
  return randomBytes(32).toString('base64url');
}

export async function setGuestSessionCookie(slug: string, identifier: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set({
    name: guestSessionCookieName(slug),
    value: identifier,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: GUEST_SESSION_TTL_SECONDS,
  });
}

export async function clearGuestSessionCookie(slug: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(guestSessionCookieName(slug));
}

export async function getGuestSession(slug: string, eventId: string): Promise<GuestSession | null> {
  const identifier = (await cookies()).get(guestSessionCookieName(slug))?.value;
  if (!identifier) return null;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from('guest_sessions')
    .select('id,event_id,guest_id,expires_at,session_status')
    .eq('session_hash', sessionHash(identifier))
    .eq('event_id', eventId)
    .eq('session_status', 'active')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;

  await db
    .from('guest_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', data.id);

  return data as GuestSession;
}

export async function revokeGuestSession(slug: string, eventId: string): Promise<boolean> {
  const identifier = (await cookies()).get(guestSessionCookieName(slug))?.value;
  if (!identifier) return false;
  const db = supabaseAdmin();
  const { data, error } = await db.rpc('revoke_guest_session', {
    p_event_id: eventId,
    p_session_hash: sessionHash(identifier),
  });
  if (error) throw error;
  return Boolean(data);
}

export async function createGuestSession(eventId: string, slug: string, displayName?: string, eventCodeSalt?: string, eventCodeHash?: string) {
  const identifier = createSessionIdentifier();
  const now = Date.now();
  const expiresAt = new Date(now + GUEST_SESSION_TTL_SECONDS * 1000).toISOString();
  const db = supabaseAdmin();

  const { data: created, error: createError } = await db.rpc('create_guest_session_for_event', {
    p_event_id: eventId,
    p_event_code_salt: eventCodeSalt ?? null,
    p_event_code_hash: eventCodeHash ?? null,
    p_display_name: displayName || null,
    p_session_hash: sessionHash(identifier),
    p_expires_at: expiresAt,
  });

  const session = Array.isArray(created) ? created[0] : created;
  if (createError || !session) {
    throw createError ?? new Error('Could not create guest session.');
  }

  try {
    await setGuestSessionCookie(slug, identifier);
  } catch (error) {
    try {
      await db.rpc('revoke_guest_session', { p_event_id: eventId, p_session_hash: sessionHash(identifier) });
    } catch (cleanupError) {
      console.error('Guest session cleanup failed:', cleanupError instanceof Error ? cleanupError.message : 'Unknown error');
    }
    throw error;
  }
  return session as GuestSession;


}
