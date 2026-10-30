import type { NextRequest } from 'next/server';
import { tokenHash } from '@/lib/event-token';
import { getGuestSession } from '@/lib/guest-session';
import { supabaseAdmin } from '@/lib/supabase-admin';

export type EventAccess = {
  db: ReturnType<typeof supabaseAdmin>;
  event: { id: string; slug: string; title: string; baby_name: string; event_date: string; venue: string | null; is_active: boolean; event_status: 'open' | 'closed'; access_mode: 'legacy_token' | 'event_code'; event_code_salt: string | null; event_code_hash: string | null };
  mode: 'legacy' | 'session';
};

export async function loadEvent(slug: string) {
  return supabaseAdmin().from('events').select('id,slug,title,baby_name,event_date,venue,is_active,event_status,access_mode,event_code_salt,event_code_hash,guest_token_hash').eq('slug', slug).maybeSingle();
}

export async function authorizeEvent(request: NextRequest, slug: string, forUpload: boolean): Promise<EventAccess | null> {
  const db = supabaseAdmin();
  const { data: event, error } = await loadEvent(slug);
  if (error || !event) return null;
  if (forUpload && (!event.is_active || event.event_status !== 'open')) return null;

  const token = request.nextUrl.searchParams.get('key');
  if (token && token.length >= 20 && token.length <= 100 && event.guest_token_hash === tokenHash(token)) {
    return { db, event: event as EventAccess['event'], mode: 'legacy' };
  }

  const session = await getGuestSession(slug, event.id);
  if (!session) return null;
  return { db, event: event as EventAccess['event'], mode: 'session' };
}
