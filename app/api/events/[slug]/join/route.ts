import { NextRequest, NextResponse } from 'next/server';
import { normalizeEventAccessCode, verifyEventAccessCode } from '@/lib/event-access-code';
import { createGuestSession } from '@/lib/guest-session';
import { consumeGeneralJoinLimits, finalizeFailedJoinAttempt, renewFailedJoinAttempt, reserveFailedJoinAttempt } from '@/lib/rate-limit';
import { loadEvent } from '@/lib/guest-access';

export const runtime = 'nodejs';
export const maxDuration = 120;
const GENERIC_ERROR = 'Unable to join this event with those details.';

function response(body: unknown, status: number, retryAfterSeconds?: number) {
  const headers: Record<string, string> = { 'Cache-Control': 'private, no-store' };
  if (retryAfterSeconds) headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  return NextResponse.json(body, { status, headers });
}

function validOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const expected = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
  return origin.replace(/\/$/, '') === expected.replace(/\/$/, '');
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!validOrigin(request)) return response({ error: 'Request not allowed.' }, 403);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return response({ error: 'Invalid request.' }, 415);
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 4096) return response({ error: 'Request is too large.' }, 413);

  let body: { accessCode?: unknown; displayName?: unknown };
  try { body = await request.json(); } catch { return response({ error: 'Invalid request.' }, 400); }
  const code = normalizeEventAccessCode(body.accessCode);
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 80) || undefined : undefined;
  if (!code) return response({ error: GENERIC_ERROR }, 401);

  try {
    const general = await consumeGeneralJoinLimits(request, slug);
    if (!general.allowed) return response({ error: 'Too many join attempts. Please try again later.' }, 429, general.retryAfterSeconds);

    const { data: event } = await loadEvent(slug);
    if (!event || !event.is_active || event.event_status !== 'open' || event.access_mode !== 'event_code' || !event.event_code_salt || !event.event_code_hash) {
      return response({ error: GENERIC_ERROR }, 401);
    }

    const reservation = await reserveFailedJoinAttempt(request, slug);
    if (!reservation.allowed) return response({ error: 'Too many join attempts. Please try again later.' }, 429, reservation.retryAfterSeconds);

    let valid = false;
    let settled = false;
    const heartbeat = setInterval(() => { void renewFailedJoinAttempt(reservation.reservationKey).catch(() => undefined); }, 10000);
    try {
      valid = await verifyEventAccessCode(code, event.event_code_salt, event.event_code_hash);
      await finalizeFailedJoinAttempt(reservation.reservationKey, !valid);
      settled = true;
    } finally {
      clearInterval(heartbeat);
      if (!settled) await finalizeFailedJoinAttempt(reservation.reservationKey, true).catch(() => undefined);
    }
    if (!valid) return response({ error: GENERIC_ERROR }, 401);

    await createGuestSession(event.id, slug, displayName, event.event_code_salt, event.event_code_hash);
    return response({ ok: true, event: { title: event.title, event_date: event.event_date } }, 200);
  } catch (error) {
    console.error('Guest join failed:', error instanceof Error ? error.message : 'Unknown error');
    return response({ error: 'Unable to join this event right now.' }, 503);
  }
}
