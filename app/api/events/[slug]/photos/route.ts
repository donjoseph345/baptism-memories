import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { authorizeEvent } from '@/lib/guest-access';

export const runtime = 'nodejs';
const BUCKET = 'event-photos';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);
type Params = { params: Promise<{ slug: string }> };
function noStore(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
export async function GET(request: NextRequest, { params }: Params) {
  const { slug } = await params;
  try {
    const found = await authorizeEvent(request, slug, false);
    if (!found) return noStore({ error: 'This event link or session is invalid.' }, 401);
    const { data: rows, error } = await found.db.from('photos').select('id,storage_path,uploader_name,caption,created_at').eq('event_id', found.event.id).eq('status', 'approved').order('created_at', { ascending: false }).limit(120);
    if (error) throw error;
    const photos = await Promise.all((rows || []).map(async (row) => { const { data } = await found.db.storage.from(BUCKET).createSignedUrl(row.storage_path, 60 * 30); return data?.signedUrl ? { id: row.id, uploader_name: row.uploader_name, caption: row.caption, created_at: row.created_at, signedUrl: data.signedUrl } : null; }));
    return noStore({ event: { title: found.event.title, baby_name: found.event.baby_name, event_date: found.event.event_date, venue: found.event.venue, slug: found.event.slug }, photos: photos.filter(Boolean) });
  } catch (error) { console.error('Gallery fetch failed:', error instanceof Error ? error.message : 'Unknown error'); return noStore({ error: 'Unable to load photos right now.' }, 500); }
}
export async function POST(request: NextRequest, { params }: Params) {
  const { slug } = await params;
  try {
    const form = await request.formData(); const file = form.get('file');
    if (!(file instanceof File)) return noStore({ error: 'Choose an image first.' }, 400);
    const ext = ALLOWED.get(file.type); if (!ext) return noStore({ error: 'Only JPEG, PNG, and WebP images are supported.' }, 415);
    if (file.size < 1 || file.size > MAX_FILE_BYTES) return noStore({ error: 'Each photo must be smaller than 8 MB.' }, 413);
    const found = await authorizeEvent(request, slug, true); if (!found) return noStore({ error: 'This event link or session is invalid, or the event is closed.' }, 401);
    const { count, error: countError } = await found.db.from('photos').select('id', { count: 'exact', head: true }).eq('event_id', found.event.id);
    if (countError) throw countError; if ((count || 0) >= 500) return noStore({ error: 'This event cannot accept more photos right now.' }, 429);
    const buffer = Buffer.from(await file.arrayBuffer()); if (!validImageSignature(buffer, ext)) return noStore({ error: 'The file contents do not match the selected image type.' }, 415);
    const path = `${found.event.id}/${randomUUID()}.${ext}`;
    const { error: uploadError } = await found.db.storage.from(BUCKET).upload(path, buffer, { contentType: file.type, upsert: false, cacheControl: '3600' }); if (uploadError) throw uploadError;
    const uploaderName = String(form.get('uploaderName') || '').trim().slice(0, 60) || null; const caption = String(form.get('caption') || '').trim().slice(0, 240) || null;
    const { data: photo, error: insertError } = await found.db.from('photos').insert({ event_id: found.event.id, storage_path: path, uploader_name: uploaderName, caption, status: 'approved' }).select('id').single();
    if (insertError) { await found.db.storage.from(BUCKET).remove([path]); throw insertError; }
    if (found.mode === 'legacy') {
      try {
        const token = request.nextUrl.searchParams.get('key') || '';
        const channel = found.db.channel(`event-${slug}-${token}`, { config: { broadcast: { ack: true, self: false } } });
        await channel.send({ type: 'broadcast', event: 'photo-added', payload: { photoId: photo.id } });
        await found.db.removeChannel(channel);
      } catch { /* Gallery reload still provides the new photo. */ }
    }
    return noStore({ ok: true, id: photo.id }, 201);
  } catch (error) { console.error('Photo upload failed:', error instanceof Error ? error.message : 'Unknown error'); return noStore({ error: 'Photo upload failed. Please try again.' }, 500); }
}
function validImageSignature(buf: Buffer, ext: string) { if (ext === 'jpg') return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff; if (ext === 'png') return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); if (ext === 'webp') return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'; return false; }
