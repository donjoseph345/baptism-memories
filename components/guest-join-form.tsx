'use client';
import { FormEvent, useEffect, useState } from 'react';
import Gallery from '@/components/gallery';

type PublicEvent = { title: string; event_date: string };

export default function GuestJoinForm({ slug }: { slug: string }) {
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/events/${encodeURIComponent(slug)}/public`, { cache: 'no-store' })
      .then(async (r) => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Event unavailable.'); return data; })
      .then((data) => setEvent(data.event))
      .catch((e) => setError(e instanceof Error ? e.message : 'Event unavailable.'))
      .finally(() => setLoading(false));
  }, [slug]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setSubmitting(true); setError('');
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(slug)}/join`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessCode: code, displayName }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Unable to join this event.');
      setCode(''); setJoined(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to join this event.'); }
    finally { setSubmitting(false); }
  }

  if (joined) return <Gallery slug={slug} guestToken="" accessMode="session" />;
  return <main className="min-h-screen px-5 py-12"><section className="card mx-auto max-w-lg p-6 md:p-8">
    {loading ? <p className="muted">Loading event…</p> : <>
      <div className="eyebrow">You&apos;re invited</div>
      <h1 className="serif mt-3 text-4xl">{event?.title || 'Shared memories'}</h1>
      {event?.event_date && <p className="muted mt-2">{new Date(`${event.event_date}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'long' })}</p>}
      <p className="muted mt-5 leading-7">Enter the event code to join and share memories with the family.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm font-semibold">Event code<input className="input mt-2" required maxLength={32} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
        <label className="block text-sm font-semibold">Your name <span className="muted">(optional)</span><input className="input mt-2" maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <button className="btn w-full" disabled={submitting}>{submitting ? 'Joining…' : 'Join Event'}</button>
      </form>
    </>}
  </section></main>;
}
