import { NextRequest, NextResponse } from 'next/server';
import { clearGuestSessionCookie, getGuestSession, revokeGuestSession } from '@/lib/guest-session';
import { loadEvent } from '@/lib/guest-access';

export const runtime = 'nodejs';

function originAllowed(request: NextRequest) {
  const origin = request.headers.get('origin');
  const expected = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
  return Boolean(origin && origin.replace(/\/$/, '') === expected.replace(/\/$/, ''));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!originAllowed(request)) return NextResponse.json({ error: 'Request not allowed.' }, { status: 403 });
  const { data: event } = await loadEvent(slug);
  if (!event) return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    await revokeGuestSession(slug, event.id);
    await clearGuestSessionCookie(slug);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Guest logout failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Could not end this session.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
