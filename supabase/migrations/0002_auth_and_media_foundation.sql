-- Baptism Memories
-- Phase 2A: authentication and media foundation.
-- Additive only: preserves existing events, photos, and Storage objects.

create extension if not exists pgcrypto;

alter table public.events
  add column if not exists description text,
  add column if not exists event_code_salt text,
  add column if not exists event_code_hash text,
  add column if not exists access_mode text,
  add column if not exists event_status text,
  add column if not exists closed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Event-code-only events do not require a legacy bearer token.
alter table public.events
  alter column guest_token_hash drop not null;

alter table public.events drop constraint if exists events_access_mode_check;
alter table public.events
  add constraint events_access_mode_check
  check (access_mode in ('legacy_token', 'event_code'));

alter table public.events drop constraint if exists events_event_status_check;
alter table public.events
  add constraint events_event_status_check
  check (event_status in ('open', 'closed'));

do $$
begin
  if exists (
    select 1
    from public.events
    where (access_mode is null and event_status is not null)
       or (access_mode is not null and event_status is null)
  ) then
    raise exception 'events contain partially initialized access state';
  end if;
end $$;

update public.events
set
  access_mode = 'legacy_token',
  event_status = case when is_active then 'open' else 'closed' end
where access_mode is null and event_status is null;

-- Existing 0001 rows are mapped deterministically: is_active=true -> open,
-- is_active=false -> closed. Abort if the backfill did not produce a consistent state.
do $$
begin
  if exists (
    select 1 from public.events
    where (is_active and event_status <> 'open')
       or (not is_active and event_status <> 'closed')
  ) then
    raise exception 'events status backfill is inconsistent with is_active';
  end if;
end $$;

do $$
begin
  if exists (select 1 from public.events where access_mode is null or event_status is null) then
    raise exception 'events backfill left null access state';
  end if;
end $$;

alter table public.events
  alter column access_mode set default 'legacy_token',
  alter column event_status set default 'open',
  alter column access_mode set not null,
  alter column event_status set not null;

alter table public.events drop constraint if exists events_access_credentials_check;
alter table public.events
  add constraint events_access_credentials_check
  check (
    (access_mode = 'legacy_token' and guest_token_hash is not null)
    or
    (access_mode = 'event_code' and event_code_salt is not null and event_code_hash is not null)
  );

alter table public.events drop constraint if exists events_active_status_consistency_check;
alter table public.events
  add constraint events_active_status_consistency_check
  check (
    (is_active = true and event_status = 'open')
    or
    (is_active = false and event_status = 'closed')
  );

create index if not exists events_status_idx on public.events(event_status);
create index if not exists events_access_mode_idx on public.events(access_mode);

create table if not exists public.admin_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin',
  created_at timestamptz not null default now(),
  constraint admin_roles_role_check check (role in ('admin'))
);

create table if not exists public.guests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guests_display_name_length_check
    check (display_name is null or char_length(display_name) between 1 and 80)
);

create index if not exists guests_event_idx on public.guests(event_id);

create table if not exists public.guest_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  guest_id uuid not null references public.guests(id) on delete cascade,
  session_hash text not null unique,
  session_status text not null default 'active',
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint guest_sessions_status_check
    check (session_status in ('active', 'expired', 'revoked')),
  constraint guest_sessions_revocation_check
    check (session_status <> 'revoked' or revoked_at is not null)
);

create index if not exists guest_sessions_event_idx on public.guest_sessions(event_id);
create index if not exists guest_sessions_guest_idx on public.guest_sessions(guest_id);
create index if not exists guest_sessions_active_idx
  on public.guest_sessions(session_hash, session_status, expires_at);

create table if not exists public.media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  guest_id uuid references public.guests(id) on delete set null,
  legacy_photo_id uuid unique references public.photos(id) on delete set null,
  legacy_storage_path text,
  original_file_name text,
  uploader_name text,
  caption text,
  mime_type text,
  file_type text not null,
  file_size bigint,
  storage_provider text not null default 'google_drive',
  google_drive_file_id text,
  google_drive_account_type text,
  upload_status text not null default 'pending',
  visibility_status text not null default 'approved',
  upload_error text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uploaded_at timestamptz,
  constraint media_file_type_check check (file_type in ('photo', 'video')),
  constraint media_file_size_check check (file_size is null or file_size >= 0),
  constraint media_legacy_metadata_check
    check (storage_provider <> 'supabase_legacy' or legacy_storage_path is not null),
  constraint media_storage_provider_check
    check (storage_provider in ('google_drive', 'supabase_legacy')),
  constraint media_google_drive_account_type_check
    check (google_drive_account_type is null or google_drive_account_type in ('photos', 'videos')),
  constraint media_upload_status_check
    check (upload_status in ('pending', 'uploading', 'completed', 'failed', 'cancelled')),
  constraint media_visibility_status_check
    check (visibility_status in ('pending', 'approved', 'hidden')),
  constraint media_google_drive_consistency_check
    check (
      (storage_provider = 'supabase_legacy' and google_drive_file_id is null and google_drive_account_type is null)
      or
      (storage_provider = 'google_drive'
        and (upload_status <> 'completed' or (google_drive_file_id is not null and google_drive_account_type is not null)))
    )
);

create index if not exists media_event_created_idx on public.media(event_id, created_at desc);
create index if not exists media_event_type_idx on public.media(event_id, file_type);
create index if not exists media_event_status_idx
  on public.media(event_id, upload_status, visibility_status);
create index if not exists media_drive_file_idx on public.media(google_drive_file_id)
  where google_drive_file_id is not null;
create unique index if not exists media_idempotency_key_idx
  on public.media(event_id, idempotency_key)
  where idempotency_key is not null;

insert into public.media (
  event_id, legacy_photo_id, legacy_storage_path, original_file_name,
  uploader_name, caption, mime_type, file_type, file_size,
  storage_provider, upload_status, visibility_status, created_at, updated_at, uploaded_at
)
select
  p.event_id,
  p.id,
  p.storage_path,
  regexp_replace(p.storage_path, '^.*/', ''),
  p.uploader_name,
  p.caption,
  null,
  'photo',
  null,
  'supabase_legacy',
  case when p.status = 'pending' then 'pending' else 'completed' end,
  p.status,
  p.created_at,
  p.created_at,
  p.created_at
from public.photos p
where not exists (
  select 1 from public.media m where m.legacy_photo_id = p.id
);


create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.admin_roles ar
    where ar.user_id = auth.uid() and ar.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
alter function public.is_admin() owner to postgres;

alter table public.admin_roles enable row level security;
alter table public.guests enable row level security;
alter table public.guest_sessions enable row level security;
alter table public.media enable row level security;

drop policy if exists admin_roles_self_select on public.admin_roles;
drop policy if exists events_admin_select on public.events;
drop policy if exists events_admin_insert on public.events;
drop policy if exists events_admin_update on public.events;
drop policy if exists guests_admin_select on public.guests;
drop policy if exists guest_sessions_admin_select on public.guest_sessions;
drop policy if exists media_admin_select on public.media;
drop policy if exists media_admin_insert on public.media;
drop policy if exists media_admin_update on public.media;

create policy admin_roles_self_select on public.admin_roles
  for select to authenticated using (user_id = auth.uid());

create policy events_admin_select on public.events
  for select to authenticated using (public.is_admin());
create policy events_admin_insert on public.events
  for insert to authenticated with check (public.is_admin());
create policy events_admin_update on public.events
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy guests_admin_select on public.guests
  for select to authenticated using (public.is_admin());
create policy guest_sessions_admin_select on public.guest_sessions
  for select to authenticated using (public.is_admin());

create policy media_admin_select on public.media
  for select to authenticated using (public.is_admin());
create policy media_admin_insert on public.media
  for insert to authenticated with check (public.is_admin());
create policy media_admin_update on public.media
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.admin_roles from public, anon, authenticated;
grant select on public.admin_roles to authenticated;
-- Authenticated users need only role self-select. Application data is server-mediated.
revoke all on public.events from public, authenticated;
revoke all on public.guests from public, authenticated;
revoke all on public.guest_sessions from public, authenticated;
revoke all on public.media from public, authenticated;
revoke all on public.events from anon;
revoke all on public.guests from anon;
revoke all on public.guest_sessions from anon;
revoke all on public.media from anon;
