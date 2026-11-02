-- Baptism Memories: private event gallery schema.
-- Apply via Supabase SQL Editor or Supabase CLI.
create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,100}$'),
  title text not null check (char_length(title) between 1 and 90),
  baby_name text not null check (char_length(baby_name) between 1 and 80),
  event_date date not null,
  venue text,
  guest_token_hash text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  storage_path text not null unique,
  uploader_name text check (uploader_name is null or char_length(uploader_name) <= 60),
  caption text check (caption is null or char_length(caption) <= 240),
  status text not null default 'approved' check (status in ('pending','approved','hidden')),
  created_at timestamptz not null default now()
);

create index if not exists photos_event_created_idx on public.photos(event_id, created_at desc);
create index if not exists photos_event_status_idx on public.photos(event_id, status);

-- All application data access is server-mediated with the server-only service key.
-- No browser-facing table policies are granted. Do not expose the service key to clients.
alter table public.events enable row level security;
alter table public.photos enable row level security;
revoke all on public.events from public;
revoke all on public.photos from public;
revoke all on public.events from anon, authenticated;
revoke all on public.photos from anon, authenticated;

-- Private image bucket. Server API uses the service-role key after validating the guest token.
do $$
declare
  existing_public boolean;
  existing_file_size_limit bigint;
  existing_mime_types text[];
  expected_mime_types text[] := array['image/jpeg','image/png','image/webp'];
  normalized_existing text[];
  normalized_expected text[];
begin
  normalized_expected := array(select unnest(expected_mime_types) order by 1);

  select public, file_size_limit, allowed_mime_types
  into existing_public, existing_file_size_limit, existing_mime_types
  from storage.buckets where id = 'event-photos';

  if not found then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('event-photos', 'event-photos', false, 8388608, expected_mime_types);
  else
    normalized_existing := array(select unnest(coalesce(existing_mime_types, array[]::text[])) order by 1);
    if existing_public is distinct from false
       or existing_file_size_limit is distinct from 8388608
       or normalized_existing is distinct from normalized_expected then
      raise exception 'event-photos bucket exists with unexpected configuration; no changes were made';
    end if;
  end if;
end $$;

-- Intentionally no public Storage policies. API routes create signed URLs and validate every guest request.
