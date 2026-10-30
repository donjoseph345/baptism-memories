import type { User } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/supabase-server';

export type AdminAuthStatus =
  | { authenticated: false; user: null; isAdmin: false; authError: boolean }
  | { authenticated: true; user: User; isAdmin: boolean; authError: false };

export class AdminAuthorizationError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super(status === 401 ? 'Authentication required.' : 'Administrator permission required.');
    this.name = 'AdminAuthorizationError';
    this.status = status;
  }
}

export async function getAdminAuthStatus(): Promise<AdminAuthStatus> {
  const supabase = await supabaseServer();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) return { authenticated: false, user: null, isAdmin: false, authError: true };
  if (!user) return { authenticated: false, user: null, isAdmin: false, authError: false };

  const { data: role, error: roleError } = await supabase
    .from('admin_roles')
    .select('role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .maybeSingle();

  return { authenticated: true, user, isAdmin: !roleError && Boolean(role), authError: false };
}

export async function getAdminUser(): Promise<User | null> {
  const status = await getAdminAuthStatus();
  return status.authenticated && status.isAdmin ? status.user : null;
}

export async function requireAdminUser(): Promise<User> {
  const status = await getAdminAuthStatus();
  if (!status.authenticated) throw new AdminAuthorizationError(401);
  if (!status.isAdmin) throw new AdminAuthorizationError(403);
  return status.user;
}
