import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';

export const runtime = 'nodejs';

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  const expected = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
  return Boolean(origin && origin.replace(/\/$/, '') === expected.replace(/\/$/, ''));
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Request not allowed.' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (cause) {
    console.error('Admin logout failed:', cause instanceof Error ? cause.message : 'Unknown error');
    return NextResponse.json({ error: 'Could not sign out.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
