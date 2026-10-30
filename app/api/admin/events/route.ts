
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { getAdminAuthStatus } from '@/lib/admin-auth';
import {
  createGuestToken,
  safeSlug,
  tokenHash,
} from '@/lib/event-token';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 4096;

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  const expected = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
  return Boolean(origin && origin.replace(/\/$/, '') === expected.replace(/\/$/, ''));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return noStore({ error: 'Request not allowed.' }, 403);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return noStore({ error: 'Invalid request.' }, 415);
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) return noStore({ error: 'Request is too large.' }, 413);

  const authStatus = await getAdminAuthStatus();
  if (authStatus.authError) return noStore({ error: 'Authentication required.' }, 401);
  if (authStatus.authenticated && !authStatus.isAdmin) return noStore({ error: 'Administrator permission required.' }, 403);

  if (!authStatus.authenticated) {
    const expected = process.env.ADMIN_SETUP_SECRET;
    const provided = request.headers.get('x-admin-setup-secret');
    if (!expected || !provided || !constantTimeEqual(provided, expected)) {
      return noStore({ error: 'Authentication required.' }, 401);
    }
  }

  let body: {
    title?: string;
    babyName?: string;
    date?: string;
    church?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON request body.' },
      { status: 400 }
    );
  }

  const title =
    typeof body.title === 'string'
      ? body.title.trim().slice(0, 90)
      : '';

  const babyName =
    typeof body.babyName === 'string'
      ? body.babyName.trim().slice(0, 80)
      : '';

  const date =
    typeof body.date === 'string' ? body.date : '';

  const church =
    typeof body.church === 'string'
      ? body.church.trim().slice(0, 120)
      : '';

  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00.000Z`)
    : null;

  if (
    !title ||
    !babyName ||
    !parsedDate ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    return noStore({ error: "Add an event title, baby's name, and valid date." }, 400);
  }

  const slug = `${safeSlug(babyName) || 'baptism'}-${date}-${randomUUID().slice(0, 5)}`;
  const guestToken = createGuestToken();

  try {
    const db = supabaseAdmin();

    const { data, error } = await db
      .from('events')
      .insert({
        slug,
        title,
        baby_name: babyName,
        event_date: date,
        venue: church || null,
        guest_token_hash: tokenHash(guestToken),
        is_active: true,
      })
      .select('slug')
      .single();

    if (error) {
      console.error('Supabase event insert failed:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });

      if (error.code === '42P01') {
        throw new Error(
          'The events table does not exist. Run the database migration in Supabase SQL Editor.'
        );
      }

      if (error.code === '42703') {
        throw new Error(
          'A required database column is missing. Check that the migration matches the current code.'
        );
      }

      if (error.code === '23505') {
        throw new Error(
          'This event has a duplicate value. Try creating it again.'
        );
      }

      throw new Error(`Database insert failed: ${error.message}`);
    }

    const base = (
      process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin
    ).replace(/\/+$/, '');

    const guestUrl =
      `${base}/e/${data.slug}?key=${encodeURIComponent(guestToken)}`;

    const qrDataUrl = await QRCode.toDataURL(guestUrl, {
      width: 640,
      margin: 2,
      color: {
        dark: '#282720',
        light: '#ffffff',
      },
    });

    return noStore({ title, slug: data.slug, guestUrl, qrDataUrl });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';

    console.error('Event creation failed:', message);

    return noStore({
      error: 'Could not create event.',
      ...(process.env.NODE_ENV === 'development' ? { details: message } : {}),
    }, 500);
  }
}
