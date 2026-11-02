-- Phase 2 Sub-phase 2 guest authentication support.
-- Additive and unapplied; do not run before staging review.

create table if not exists public.guest_join_rate_limits (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null,
  scope_type text not null,
  window_started_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_join_rate_limits_scope_type_check check (
    scope_type in ('general_global','general_event','failed_global','failed_event')
  ),
  unique(scope_key, scope_type, window_started_at)
);

create table if not exists public.guest_join_rate_limit_reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_key text not null,
  scope_key text not null,
  scope_type text not null check (scope_type in ('failed_global','failed_event')),
  window_started_at timestamptz not null,
  status text not null default 'reserved' check (status in ('reserved','committed','refunded','timed_out','expired')),
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique(reservation_key, scope_type)
);

create index if not exists guest_join_rate_limits_updated_idx on public.guest_join_rate_limits(updated_at);
create index if not exists guest_join_reservations_lease_idx on public.guest_join_rate_limit_reservations(status, lease_expires_at);

alter table public.guest_join_rate_limits enable row level security;
alter table public.guest_join_rate_limit_reservations enable row level security;
revoke all on public.guest_join_rate_limits from public, anon, authenticated;
revoke all on public.guest_join_rate_limit_reservations from public, anon, authenticated;
revoke create on schema public from public;
revoke create on schema public from anon;
revoke create on schema public from authenticated;

create or replace function public.consume_general_join_limits(
  p_global_scope_key text, p_event_scope_key text, p_now timestamptz,
  p_global_window_seconds integer, p_global_max_requests integer,
  p_event_window_seconds integer, p_event_max_requests integer
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  g_window timestamptz;
  e_window timestamptz;
  g_count integer;
  e_count integer;
  g_key bigint;
  e_key bigint;
  retry integer := 1;
begin
  if p_global_scope_key is null or length(p_global_scope_key) not between 16 and 128
     or p_event_scope_key is null or length(p_event_scope_key) not between 16 and 128
     or p_global_window_seconds not between 1 and 86400
     or p_event_window_seconds not between 1 and 86400
     or p_global_max_requests not between 1 and 10000
     or p_event_max_requests not between 1 and 10000 then
    raise exception 'invalid rate limit arguments';
  end if;
  g_window := to_timestamp(floor(extract(epoch from p_now) / p_global_window_seconds) * p_global_window_seconds);
  e_window := to_timestamp(floor(extract(epoch from p_now) / p_event_window_seconds) * p_event_window_seconds);
  g_key := guest_join_lock_key('general_global', p_global_scope_key, g_window);
  e_key := guest_join_lock_key('general_event', p_event_scope_key, e_window);
  perform pg_catalog.pg_advisory_xact_lock(g_key, e_key);
  insert into public.guest_join_rate_limits(scope_key,scope_type,window_started_at)
  values (p_global_scope_key,'general_global',g_window),(p_event_scope_key,'general_event',e_window)
  on conflict (scope_key,scope_type,window_started_at) do nothing;
  select attempt_count into g_count from public.guest_join_rate_limits where scope_key=p_global_scope_key and scope_type='general_global' and window_started_at=g_window for update;
  select attempt_count into e_count from public.guest_join_rate_limits where scope_key=p_event_scope_key and scope_type='general_event' and window_started_at=e_window for update;
  if g_count >= p_global_max_requests or e_count >= p_event_max_requests then
    retry := greatest(
      case when g_count >= p_global_max_requests then greatest(1, extract(epoch from (g_window + make_interval(secs => p_global_window_seconds) - p_now))::integer) else 1 end,
      case when e_count >= p_event_max_requests then greatest(1, extract(epoch from (e_window + make_interval(secs => p_event_window_seconds) - p_now))::integer) else 1 end
    );
    return query select false, retry;
    return;
  end if;
  update public.guest_join_rate_limits set attempt_count=attempt_count+1,updated_at=p_now
  where (scope_key=p_global_scope_key and scope_type='general_global' and window_started_at=g_window)
     or (scope_key=p_event_scope_key and scope_type='general_event' and window_started_at=e_window);
  return query select true, 0;
end;
$$;

create or replace function public.reserve_failed_join_attempt(
  p_reservation_key text, p_global_scope_key text, p_event_scope_key text,
  p_event_id uuid, p_now timestamptz, p_window_seconds integer, p_global_max_attempts integer,
  p_event_max_attempts integer, p_lease_seconds integer
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_window timestamptz;
  v_global integer;
  v_event integer;
  v_global_reserved integer;
  v_event_reserved integer;
  v_global_key bigint;
  v_event_key bigint;
  v_reserved_existing integer;
begin
  if p_reservation_key is null or length(p_reservation_key) not between 16 and 128
     or p_global_scope_key is null or length(p_global_scope_key) not between 16 and 128
     or p_event_scope_key is null or length(p_event_scope_key) not between 16 and 128
     or p_event_id is null
     or p_window_seconds not between 1 and 86400
     or p_global_max_attempts not between 1 and 10000
     or p_event_max_attempts not between 1 and 10000
     or p_lease_seconds not between 5 and 120 then
    raise exception 'invalid failed attempt arguments';
  end if;
  v_window := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
  v_global_key := guest_join_lock_key('failed_global', p_global_scope_key, v_window);
  v_event_key := guest_join_lock_key('failed_event', p_event_scope_key, v_window);
  perform pg_catalog.pg_advisory_xact_lock(v_global_key, v_event_key);

  -- Expiry cleanup only releases leases that have already expired.
  with expired as (
    update public.guest_join_rate_limit_reservations
    set status='expired',finalized_at=p_now
    where status in ('reserved','active') and lease_expires_at < p_now
    returning scope_key,scope_type,window_started_at
  ), expired_counts as (
    select scope_key,scope_type,window_started_at,count(*)::integer as expired_count
    from expired
    group by scope_key,scope_type,window_started_at
  )
  update public.guest_join_rate_limits l
  set reserved_count=greatest(0,l.reserved_count-e.expired_count),updated_at=p_now
  from expired_counts e
  where l.scope_key=e.scope_key
    and l.scope_type=e.scope_type
    and l.window_started_at=e.window_started_at;

  insert into public.guest_join_rate_limits(scope_key,scope_type,window_started_at)
  values (p_global_scope_key,'failed_global',v_window),(p_event_scope_key,'failed_event',v_window)
  on conflict (scope_key,scope_type,window_started_at) do nothing;
  select attempt_count,reserved_count into v_global,v_global_reserved from public.guest_join_rate_limits where scope_key=p_global_scope_key and scope_type='failed_global' and window_started_at=v_window for update;
  select attempt_count,reserved_count into v_event,v_event_reserved from public.guest_join_rate_limits where scope_key=p_event_scope_key and scope_type='failed_event' and window_started_at=v_window for update;
  if v_global+v_global_reserved >= p_global_max_attempts or v_event+v_event_reserved >= p_event_max_attempts then
    return query select false,greatest(1,extract(epoch from (v_window + make_interval(secs => p_window_seconds) - p_now))::integer); return;
  end if;

  insert into public.guest_join_reservations(reservation_key,event_id,window_started_at,status,authorization_outcome)
  values (p_reservation_key,p_event_id,v_window,'active','normal')
  on conflict (reservation_key) do nothing;
  v_reserved_existing := row_count;
  if v_reserved_existing = 0 then
    raise exception 'reservation key already exists or parent insert failed';
  end if;

  insert into public.guest_join_rate_limit_reservations(
    reservation_key,parent_reservation_key,event_id,scope_key,scope_type,window_started_at,lease_expires_at,status
  )
  values
    (p_reservation_key,p_reservation_key,p_event_id,p_global_scope_key,'failed_global',v_window,p_now+make_interval(secs => p_lease_seconds),'active'),
    (p_reservation_key,p_reservation_key,p_event_id,p_event_scope_key,'failed_event',v_window,p_now+make_interval(secs => p_lease_seconds),'active')
  on conflict (reservation_key,scope_type) do nothing;

  update public.guest_join_rate_limits set reserved_count=reserved_count+1,updated_at=p_now
  where scope_key in (p_global_scope_key,p_event_scope_key) and scope_type in ('failed_global','failed_event') and window_started_at=v_window;
  return query select true,0;
end;
$$;

create or replace function public.mark_failed_join_attempt_timed_out(
  p_reservation_key text, p_now timestamptz
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_event_id uuid; v_window timestamptz; v_key bigint;
begin
  if p_reservation_key is null or length(p_reservation_key) not between 16 and 128 or p_now is null then
    raise exception 'invalid timeout arguments';
  end if;
  select r.event_id, r.window_started_at into v_event_id, v_window
  from public.guest_join_reservations r where r.reservation_key=p_reservation_key;
  if not found then return false; end if;
  v_key := guest_join_lock_key('failed_global', (select r.scope_key from public.guest_join_rate_limit_reservations r where r.reservation_key=p_reservation_key and r.scope_type='failed_global' limit 1), v_window);
  perform pg_catalog.pg_advisory_xact_lock(v_key);

  update public.guest_join_reservations set status='timed_out',finalized_at=p_now where reservation_key=p_reservation_key and status='active';
  update public.guest_join_rate_limit_reservations set status='timed_out',finalized_at=p_now
  where reservation_key=p_reservation_key and status='active';
  return found;
end;
$$;

create or replace function public.finalize_failed_join_attempt(
  p_reservation_key text, p_commit boolean, p_now timestamptz
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_changed integer; v_counter_rows integer; v_key bigint; v_window timestamptz; v_scope_key text;
begin
  if p_reservation_key is null or length(p_reservation_key) not between 16 and 128 or p_now is null then
    raise exception 'invalid finalization arguments';
  end if;

  select r.window_started_at, c.scope_key into v_window, v_scope_key
  from public.guest_join_reservations r
  join public.guest_join_rate_limit_reservations c on c.reservation_key=r.reservation_key and c.scope_type='failed_global'
  where r.reservation_key=p_reservation_key limit 1;
  if not found then return false; end if;

  v_key := guest_join_lock_key('failed_global', v_scope_key, v_window);
  perform pg_catalog.pg_advisory_xact_lock(v_key);

  perform 1 from public.guest_join_rate_limits l
  join public.guest_join_rate_limit_reservations r on r.scope_key=l.scope_key and r.scope_type=l.scope_type and r.window_started_at=l.window_started_at
  where r.reservation_key=p_reservation_key and l.scope_type in ('failed_global','failed_event')
  order by case when l.scope_type='failed_global' then 0 else 1 end, l.id for update;

  v_changed := 0;
  update public.guest_join_rate_limit_reservations set status=case when p_commit then 'committed' else 'refunded' end,finalized_at=p_now
  where reservation_key=p_reservation_key and status='active';
  v_changed := v_changed + row_count;
  
  update public.guest_join_reservations set status=case when p_commit then 'committed' else 'refunded' end,
    authorization_outcome=case when p_commit then 'normal' else 'late_accounting' end,
    finalized_at=p_now
  where reservation_key=p_reservation_key and status='active';
  v_changed := v_changed + row_count;
  
  if v_changed=0 then return false; end if;
  if v_changed <> 3 then raise exception 'reservation accounting is inconsistent'; end if;

  update public.guest_join_rate_limits l set reserved_count=greatest(0,l.reserved_count-1),
    attempt_count=case when p_commit then l.attempt_count+1 else l.attempt_count end,updated_at=p_now
  from public.guest_join_rate_limit_reservations r where r.reservation_key=p_reservation_key
    and r.scope_key=l.scope_key and r.scope_type=l.scope_type and r.window_started_at=l.window_started_at;
  get diagnostics v_counter_rows = row_count;
  if v_counter_rows <> 2 then raise exception 'rate-limit counter accounting is inconsistent'; end if;
  return true;
end;
$$;

create or replace function public.create_guest_session_for_event(
  p_reservation_key text, p_event_id uuid, p_event_code_salt text, p_event_code_hash text,
  p_display_name text, p_session_hash text, p_expires_at timestamptz
) returns table(id uuid,event_id uuid,guest_id uuid,expires_at timestamptz,session_status text)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  e public.events%rowtype; g uuid; s uuid;
  v_child_count integer; v_key bigint; v_window timestamptz;
  v_scope_key text;
begin
  if p_reservation_key is null or length(p_reservation_key) not between 16 and 128
     or p_event_id is null or p_session_hash is null or length(p_session_hash)<>64
     or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '31 days'
     or p_display_name is not null and char_length(p_display_name)>80 then
    raise exception 'invalid guest session arguments';
  end if;

  -- Find the window and scope for advisory locking
  select r.window_started_at, c.scope_key into v_window, v_scope_key
  from public.guest_join_reservations r
  join public.guest_join_rate_limit_reservations c on c.reservation_key=r.reservation_key and c.scope_type='failed_global'
  where r.reservation_key=p_reservation_key limit 1;
  if not found then raise exception 'reservation not found'; end if;

  -- Lock in canonical order: advisory locks first
  v_key := guest_join_lock_key('failed_global', v_scope_key, v_window);
  perform pg_catalog.pg_advisory_xact_lock(v_key);

  -- Validate parent reservation state
  perform 1 from public.guest_join_reservations where reservation_key=p_reservation_key and status='active' and authorization_outcome='normal' for update;
  if not found then raise exception 'reservation not available'; end if;

  -- Check both child rows exist and are active
  select count(*) into v_child_count from public.guest_join_rate_limit_reservations
    where reservation_key=p_reservation_key and status='active';
  if v_child_count <> 2 then raise exception 'reservation pair incomplete'; end if;

  -- Lock and validate event
  select * into e from public.events where id=p_event_id for update;
  if not found or not e.is_active or e.event_status<>'open' or e.access_mode<>'event_code'
     or e.event_code_salt is null or e.event_code_hash is null
     or e.event_code_salt<>p_event_code_salt or e.event_code_hash<>p_event_code_hash then
    raise exception 'event is not available';
  end if;

  -- Atomic transition: active -> session_created on both parent and children
  update public.guest_join_reservations set status='session_created',
    guest_session_id=s,finalized_at=clock_timestamp()
    where reservation_key=p_reservation_key and status='active';
  
  insert into public.guests(event_id,display_name) values(p_event_id,nullif(trim(p_display_name),''))
    returning guests.id into g;
  insert into public.guest_sessions(event_id,guest_id,session_hash,expires_at)
    values(p_event_id,g,p_session_hash,p_expires_at) returning guest_sessions.id into s;
  
  update public.guest_join_rate_limit_reservations set status='session_created',
    finalized_at=clock_timestamp()
    where reservation_key=p_reservation_key and status='active';
  
  update public.guest_join_rate_limits set reserved_count=greatest(0,reserved_count-1),
    updated_at=clock_timestamp()
  from public.guest_join_rate_limit_reservations r where r.reservation_key=p_reservation_key
    and r.scope_key=guest_join_rate_limits.scope_key
    and r.scope_type=guest_join_rate_limits.scope_type
    and r.window_started_at=guest_join_rate_limits.window_started_at;
  
  return query select s,p_event_id,g,p_expires_at,'active'::text;
end;
$$;

create or replace function public.revoke_guest_session(p_event_id uuid,p_session_hash text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if p_event_id is null or p_session_hash is null or length(p_session_hash)<>64 then raise exception 'invalid session arguments'; end if;
  update public.guest_sessions set session_status='revoked',revoked_at=clock_timestamp() where event_id=p_event_id and session_hash=p_session_hash and session_status='active';
  return found;
end;
$$;

revoke all on function public.consume_general_join_limits(text,text,timestamptz,integer,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.reserve_failed_join_attempt(text,text,text,uuid,timestamptz,integer,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.mark_failed_join_attempt_timed_out(text,timestamptz) from public,anon,authenticated;
revoke all on function public.finalize_failed_join_attempt(text,boolean,timestamptz) from public,anon,authenticated;
revoke all on function public.finalize_late_join_attempt(text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.create_guest_session_for_event(text,uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.revoke_guest_session(uuid,text) from public,anon,authenticated;
revoke all on function public.renew_failed_join_attempt(text,timestamptz,integer) from public,anon,authenticated;
revoke all on function public.recover_orphaned_join_attempt(text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.cleanup_guest_join_rate_limits(timestamptz,integer) from public,anon,authenticated;
revoke all on function public.guest_join_lock_key(text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.consume_general_join_limits(text,text,timestamptz,integer,integer,integer,integer) to service_role;
grant execute on function public.reserve_failed_join_attempt(text,text,text,uuid,timestamptz,integer,integer,integer,integer) to service_role;
grant execute on function public.mark_failed_join_attempt_timed_out(text,timestamptz) to service_role;
grant execute on function public.finalize_failed_join_attempt(text,boolean,timestamptz) to service_role;
grant execute on function public.finalize_late_join_attempt(text,text,timestamptz) to service_role;
grant execute on function public.create_guest_session_for_event(text,uuid,text,text,text,text,timestamptz) to service_role;
grant execute on function public.revoke_guest_session(uuid,text) to service_role;
grant execute on function public.renew_failed_join_attempt(text,timestamptz,integer) to service_role;
grant execute on function public.recover_orphaned_join_attempt(text,text,timestamptz) to service_role;
grant execute on function public.cleanup_guest_join_rate_limits(timestamptz,integer) to service_role;
grant execute on function public.guest_join_lock_key(text,text,timestamptz) to service_role;

alter function public.consume_general_join_limits(text,text,timestamptz,integer,integer,integer,integer) owner to postgres;
alter function public.reserve_failed_join_attempt(text,text,text,uuid,timestamptz,integer,integer,integer,integer) owner to postgres;
alter function public.mark_failed_join_attempt_timed_out(text,timestamptz) owner to postgres;
alter function public.finalize_failed_join_attempt(text,boolean,timestamptz) owner to postgres;
alter function public.finalize_late_join_attempt(text,text,timestamptz) owner to postgres;
alter function public.create_guest_session_for_event(text,uuid,text,text,text,text,timestamptz) owner to postgres;
alter function public.revoke_guest_session(uuid,text) owner to postgres;
alter function public.renew_failed_join_attempt(text,timestamptz,integer) owner to postgres;
alter function public.recover_orphaned_join_attempt(text,text,timestamptz) owner to postgres;
alter function public.cleanup_guest_join_rate_limits(timestamptz,integer) owner to postgres;
alter function public.guest_join_lock_key(text,text,timestamptz) owner to postgres;


create or replace function public.cleanup_guest_join_rate_limits(p_before timestamptz,p_batch_size integer)
returns integer
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  if p_before is null or p_batch_size not between 1 and 10000 then
    raise exception 'invalid rate-limit cleanup arguments';
  end if;

  with candidates as (
    select id
    from public.guest_join_rate_limit_reservations
    where status in ('committed','refunded','expired','timed_out')
      and coalesce(finalized_at, created_at) < p_before
    order by coalesce(finalized_at, created_at), id
    limit p_batch_size
    for update
  )
  delete from public.guest_join_rate_limit_reservations r
  using candidates c
  where r.id=c.id;
  get diagnostics removed = row_count;

  delete from public.guest_join_rate_limits l
  where l.window_started_at < p_before
    and l.reserved_count = 0
    and not exists (
      select 1 from public.guest_join_rate_limit_reservations r
      where r.scope_key=l.scope_key
        and r.scope_type=l.scope_type
        and r.window_started_at=l.window_started_at
    );

  return removed;
end;
$$;

alter function public.cleanup_guest_join_rate_limits(timestamptz,integer) owner to postgres;
revoke all on function public.cleanup_guest_join_rate_limits(timestamptz,integer) from public,anon,authenticated;
grant execute on function public.cleanup_guest_join_rate_limits(timestamptz,integer) to service_role;

-- Phase A parent reservation model and canonical lock identity.
create table if not exists public.guest_join_reservations (
  reservation_key text primary key,
  event_id uuid not null references public.events(id) on delete restrict,
  window_started_at timestamptz not null,
  status text not null default 'active',
  authorization_outcome text not null default 'normal',
  guest_session_id uuid references public.guest_sessions(id) on delete restrict,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  constraint guest_join_reservations_status_check check (status in ('active','timed_out','committed','refunded','session_created','expired')),
  constraint guest_join_reservations_outcome_check check (authorization_outcome in ('normal','late_accounting','operator_recovery'))
);

alter table public.guest_join_rate_limit_reservations
  add column if not exists event_id uuid references public.events(id) on delete restrict,
  add column if not exists parent_reservation_key text references public.guest_join_reservations(reservation_key) on delete restrict;

alter table public.guest_join_rate_limit_reservations drop constraint if exists guest_join_reservations_status_check;
alter table public.guest_join_rate_limit_reservations
  add constraint guest_join_reservations_status_check
  check (status in ('active','timed_out','committed','refunded','session_created','expired'));

alter table public.guest_join_reservations enable row level security;
revoke all on public.guest_join_reservations from public, anon, authenticated;

create or replace function public.guest_join_lock_key(
  p_scope_type text,
  p_scope_key text,
  p_window_started_at timestamptz
)
returns bigint
language sql immutable strict
set search_path = pg_catalog, public
as $$
  select pg_catalog.hashtextextended(
    'guest-join-rate-limit:v1|'
    || length(p_scope_type)::text || ':' || p_scope_type || '|'
    || length(p_scope_key)::text || ':' || p_scope_key || '|'
    || to_char(p_window_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    20260324::bigint
  );
$$;

revoke all on function public.guest_join_lock_key(text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.guest_join_lock_key(text,text,timestamptz) to service_role;

