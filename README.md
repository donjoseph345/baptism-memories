# Baptism Memories

A mobile-first, real-time guest photo album for baptisms and family events. Built with Next.js, TypeScript, Supabase Storage/Postgres/Realtime, and Vercel.

## Features

- Event creation with a private high-entropy guest link and downloadable QR code
- Mobile photo uploads (JPEG, PNG, WebP; 8 MB per photo)
- Private Supabase Storage bucket and short-lived signed photo URLs
- Live gallery refresh using Supabase Realtime Broadcast
- Guest names/captions, upload progress, photo viewer, and downloads
- Server-side validation of event tokens and file signatures
- Server-only Supabase service key; browser does not query protected tables directly

## Requirements

- Node.js 20.9+ (use a current supported LTS release)
- npm
- Supabase project
- Vercel account for hosting

## 1. Install locally

```bash
npm install
cp .env.example .env.local
```

Fill `.env.local` with values from Supabase Project Settings/API. `SUPABASE_SERVICE_ROLE_KEY` is privileged and must remain server-only. Never prefix it with `NEXT_PUBLIC_` or commit `.env.local`.

Generate a long random `ADMIN_SETUP_SECRET` (for example with `openssl rand -base64 32`). Use a unique secret and do not share it with guests.

## 2. Configure Supabase

1. Create a Supabase project in a region near most guests.
2. Database migrations are currently postponed. Do not apply them to production.
3. For staging validation, apply `0001_initial_schema.sql`, then review and apply `0002_auth_and_media_foundation.sql`, then `0003_guest_auth_support.sql` only after a staging backup and explicit validation of existing rows, RLS, functions, rate limits, and Storage preservation.
4. Confirm `events`, `photos`, `admin_roles`, `guests`, `guest_sessions`, and `media` exist and RLS is enabled in staging before considering production migration.
5. Confirm the `event-photos` bucket remains private, with its existing file limit and allowed MIME types.
6. Copy the staging Project URL and publishable/anon key into the staging environment only.
7. Copy the staging-only server service-role key into `SUPABASE_SERVICE_ROLE_KEY` only. Never use production credentials for staging validation.

The application uses server-side service-role calls after validating a high-entropy guest token. Keep that key private. Realtime uses a public Broadcast channel name derived from the guest token, so the event's private link must be treated like a password. Do not post it publicly.

## 3. Run locally

```bash
npm run dev
```

Open http://localhost:3000. Sign in at `/admin/login` with the Supabase Auth administrator account, then create an event from `/admin`. During the controlled transition, the server still retains `ADMIN_SETUP_SECRET` as a temporary fallback for requests without an Auth session; it is not sent by the browser dashboard and must be removed after the initial administrator has been provisioned and verified. New events continue using the existing legacy guest URL/QR flow until the event-code migrations are enabled. Save the guest URL and scan its QR code. Open the same URL in two browser sessions and upload a test photo to verify the live update.

## 4. Deploy to Vercel

1. Create a private GitHub repository and push this project.
2. In Vercel, choose **Add New → Project**, import the repository, and use the default Next.js settings.
3. Add the environment variables from `.env.local` under Project Settings → Environment Variables. Set `NEXT_PUBLIC_SITE_URL` to the final production URL (for example `https://your-project.vercel.app`).
4. Deploy, then test the production URL and upload flow.
5. If you change environment variables, redeploy so the deployment receives them.

## Security and operational notes

- Admin access uses Supabase Auth plus the server-side `admin_roles` check. `ADMIN_SETUP_SECRET` remains only as a temporary controlled transition fallback for requests without an Auth session; it must be removed after the initial administrator is provisioned and verified. The browser dashboard never sends this secret.
- Add a durable rate limit (Upstash or another trusted service) to protect guest upload endpoints from abuse. This starter enforces file size/type and a per-event 500-photo cap, but serverless in-memory rate limiting is not durable.
- The private guest URL is a bearer credential. Anyone with it can view and upload to that event. Share only with invited guests; rotate/recreate access if it leaks.
- Realtime Broadcast channel names are visible to a connected browser. Because the channel includes the high-entropy guest token, keep the link private; for stronger isolation, implement authenticated private channels and guest membership.
- Admin logout intentionally ends the current Supabase Auth session and does not require an administrator role; privileged admin data APIs independently require Auth plus `admin_roles`.
- Signed photo URLs expire after 30 minutes. Reload the gallery if an image URL has expired.
- This starter supports JPEG, PNG and WebP only; HEIC is not accepted unless a conversion pipeline is added.
- Use a backup/export process for originals before an important event. Free-tier limits, bandwidth, and platform terms can change.
- Run `npm run build` before deployment. Confirm all database migration and upload tests on a test event before inviting guests.

## Commands

```bash
npm run dev
npm run build
npm start
```
