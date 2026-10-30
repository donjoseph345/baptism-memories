
'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  Copy,
  LoaderCircle,
  LogOut,
  Sparkles,
} from 'lucide-react';

type CreatedEvent = {
  title: string;
  slug: string;
  guestUrl: string;
  qrDataUrl: string;
};

export default function AdminPage() {
  const [title, setTitle] = useState('A Baptism to Remember');
  const [babyName, setBabyName] = useState('');
  const [date, setDate] = useState('');
  const [church, setChurch] = useState('');
  const [created, setCreated] = useState<CreatedEvent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setCreated(null);

    try {
      const res = await fetch('/api/admin/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ title, babyName, date, church }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          [data.error, data.details].filter(Boolean).join(': ') ||
            'Could not create event.'
        );
      }

      setCreated(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Something went wrong.'
      );
    } finally {
      setLoading(false);
    }
  }

  async function copyLink() {
    if (!created) return;

    try {
      await navigator.clipboard.writeText(created.guestUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy the link. Please copy it manually.');
    }
  }

  return (
    <main className="min-h-screen px-5 py-6 md:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" className="inline-flex items-center gap-2 text-sm muted">
            <ArrowLeft size={16} />
            Back to home
          </Link>
          <button
            type="button"
            className="inline-flex items-center gap-2 text-sm muted hover:text-black"
            onClick={async () => {
              try {
                const response = await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
                if (!response.ok) throw new Error('Could not sign out.');
                window.location.href = '/admin/login';
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not sign out.');
              }
            }}
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>

        <div className="mt-10">
          <div className="eyebrow flex items-center gap-2">
            <Sparkles size={14} />
            Your family&apos;s album
          </div>
          <h1 className="serif mt-3 text-4xl md:text-5xl">
            Create an event
          </h1>
          <p className="muted mt-3 max-w-xl leading-7">
            Set up the event once, then share its private guest link or QR code
            with relatives.
          </p>
        </div>

        {!created ? (
          <form
            onSubmit={submit}
            className="card mt-8 space-y-5 p-5 md:p-8"
          >
            <div className="rounded-xl bg-[#f5f1e8] p-3 text-sm muted">
              You are signed in with the administrator account. New events currently use the existing legacy guest-link flow until event-code migrations are enabled.
            </div>

            <div className="divider" />

            <div>
              <label className="mb-2 block text-sm font-semibold">
                Event title
              </label>
              <input
                className="input"
                required
                maxLength={90}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="A Baptism to Remember"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                Baby&apos;s name
              </label>
              <input
                className="input"
                required
                maxLength={80}
                value={babyName}
                onChange={(e) => setBabyName(e.target.value)}
                placeholder="e.g. Noah Joseph"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                Event date
              </label>
              <input
                className="input"
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold">
                Church or venue{' '}
                <span className="font-normal muted">(optional)</span>
              </label>
              <input
                className="input"
                maxLength={120}
                value={church}
                onChange={(e) => setChurch(e.target.value)}
                placeholder="Church / reception venue"
              />
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-xl bg-red-50 p-3 text-sm text-red-700"
              >
                {error}
              </p>
            )}

            <button className="btn w-full" type="submit" disabled={loading}>
              {loading ? (
                <>
                  <LoaderCircle className="animate-spin" size={17} />
                  Creating event…
                </>
              ) : (
                'Create private event'
              )}
            </button>

            <p className="text-xs leading-5 muted">
              Keep the generated guest link private. Anyone with the link may
              be able to access the event according to your gallery settings.
            </p>
          </form>
        ) : (
          <section className="card mt-8 p-5 md:p-8">
            <div className="flex items-center gap-2 text-sm font-semibold text-green-800">
              <Check size={18} />
              Event created
            </div>

            <h2 className="serif mt-3 text-3xl">{created.title}</h2>
            <p className="muted mt-2 text-sm">
              Your guest link and QR code are ready.
            </p>

            <div className="mt-6 grid gap-6 md:grid-cols-[1fr_220px]">
              <div>
                <label className="mb-2 block text-sm font-semibold">
                  Private guest link
                </label>
                <div
                  className="break-all rounded-xl border bg-white p-3 text-sm"
                  style={{ borderColor: 'var(--line)' }}
                >
                  {created.guestUrl}
                </div>

                <button
                  className="btn btn-outline mt-3 w-full"
                  type="button"
                  onClick={copyLink}
                >
                  <Copy size={16} />
                  {copied ? 'Copied' : 'Copy guest link'}
                </button>

                <a
                  className="btn mt-3 w-full"
                  href={created.guestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open guest gallery
                </a>
              </div>

              <div
                className="rounded-2xl border bg-white p-4 text-center"
                style={{ borderColor: 'var(--line)' }}
              >
                <img
                  src={created.qrDataUrl}
                  alt="QR code for private event gallery"
                  className="mx-auto aspect-square w-full max-w-[190px]"
                />
                <div className="mt-2 text-sm font-semibold">
                  Scan to share memories
                </div>
                <a
                  className="mt-3 inline-block text-sm underline underline-offset-4"
                  href={created.qrDataUrl}
                  download={`${created.slug}-qr.png`}
                >
                  Download QR code
                </a>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
