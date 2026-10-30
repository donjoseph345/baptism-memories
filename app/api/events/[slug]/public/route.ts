import { NextRequest, NextResponse } from 'next/server';
import { loadEvent } from '@/lib/guest-access';

export const runtime = 'nodejs';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { data: event, error } = await loadEvent(slug);
  if (error || !event) return NextResponse.json({ error: 'Event not found.' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  return NextResponse.json(
    { event: { title: event.title, event_date: event.event_date } },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
