import { createHmac, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

const GENERAL_GLOBAL_MAX = 30;
const GENERAL_EVENT_MAX = 12;
const FAILED_GLOBAL_MAX = 20;
const FAILED_EVENT_MAX = 8;
const WINDOW_SECONDS = 900;
const INITIAL_LEASE_SECONDS = 30;

export function trustedClientIp(request: NextRequest): string {
  if (process.env.VERCEL === '1') {
    const value = request.headers.get('x-real-ip')?.trim() ?? '';
    if (/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/.test(value)) return value;
    return 'vercel-invalid-ip';
  }
  return 'local-development';
}

function scopeKey(value: string): string {
  const secret = process.env.RATE_LIMIT_HASH_SECRET;
  if (!secret) throw new Error('Missing rate-limit secret.');
  return createHmac('sha256', secret).update(value).digest('hex');
}

export async function consumeGeneralJoinLimits(request: NextRequest, slug: string) {
  const ip = scopeKey(trustedClientIp(request));
  const event = scopeKey(`${trustedClientIp(request)}:${slug}`);
  const { data, error } = await supabaseAdmin().rpc('consume_general_join_limits', {
    p_global_scope_key: ip,
    p_event_scope_key: event,
    p_now: new Date().toISOString(),
    p_global_window_seconds: 60,
    p_global_max_requests: GENERAL_GLOBAL_MAX,
    p_event_window_seconds: 60,
    p_event_max_requests: GENERAL_EVENT_MAX,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  return { allowed: Boolean(result?.allowed), retryAfterSeconds: Number(result?.retry_after_seconds ?? 1) };
}

export async function reserveFailedJoinAttempt(request: NextRequest, slug: string) {
  const ip = trustedClientIp(request);
  const global = scopeKey(ip);
  const event = scopeKey(`${ip}:${slug}`);
  const reservationKey = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const { data, error } = await supabaseAdmin().rpc('reserve_failed_join_attempt', {
    p_reservation_key: reservationKey,
    p_global_scope_key: global,
    p_event_scope_key: event,
    p_now: new Date().toISOString(),
    p_window_seconds: WINDOW_SECONDS,
    p_global_max_attempts: FAILED_GLOBAL_MAX,
    p_event_max_attempts: FAILED_EVENT_MAX,
    p_lease_seconds: INITIAL_LEASE_SECONDS,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  return { reservationKey, allowed: Boolean(result?.allowed), retryAfterSeconds: Number(result?.retry_after_seconds ?? 1) };
}

export async function renewFailedJoinAttempt(reservationKey: string) {
  const { error } = await supabaseAdmin().rpc('renew_failed_join_attempt', {
    p_reservation_key: reservationKey,
    p_now: new Date().toISOString(),
    p_lease_seconds: INITIAL_LEASE_SECONDS,
  });
  if (error) throw error;
}

export async function finalizeFailedJoinAttempt(reservationKey: string, commit: boolean) {
  const { error } = await supabaseAdmin().rpc('finalize_failed_join_attempt', {
    p_reservation_key: reservationKey,
    p_commit: commit,
    p_now: new Date().toISOString(),
  });
  if (error) throw error;
}
