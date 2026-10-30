import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const root = process.cwd();
const read = (path: string) => readFile(`${root}/${path}`, 'utf8');

describe('admin authentication contracts', () => {
  it('does not trust a client-forged public-page marker', async () => {
    const middleware = await read('middleware.ts');
    expect(middleware).toContain("requestHeaders.delete('x-admin-public-page')");
    expect(middleware).toContain("pathname === '/admin/login' || pathname === '/admin/forbidden'");
    expect(middleware).toContain("requestHeaders.set('x-admin-public-page', '1')");
  });

  it('protects admin event creation with Auth-first transition logic', async () => {
    const route = await read('app/api/admin/events/route.ts');
    expect(route).toContain('getAdminAuthStatus');
    expect(route).toContain("authStatus.authError");
    expect(route).toContain("authStatus.authenticated && !authStatus.isAdmin");
    expect(route).toContain('ADMIN_SETUP_SECRET');
    expect(route).toContain("if (!authStatus.authenticated)");
    expect(route).toContain('const db = supabaseAdmin()');
    expect(route.indexOf('getAdminAuthStatus')).toBeLessThan(route.indexOf('supabaseAdmin()'));
    expect(route).toContain('MAX_BODY_BYTES');
    expect(route).toContain('sameOrigin');
    expect(route).toContain("'private, no-store'");
    expect(route).toContain('is_active: true');
    expect(route).toContain('guest_token_hash');
    expect(route).not.toContain('event_code_hash');
    expect(route).not.toContain('event_code_salt');
  });


  it('uses the Auth session for dashboard event creation without sending the setup secret', async () => {
    const page = await read('app/admin/page.tsx');
    expect(page).toContain("credentials: 'same-origin'");
    expect(page).toContain("fetch('/api/admin/events'");
    expect(page).not.toContain('x-admin-setup-secret');
    expect(page).not.toContain('ADMIN_SETUP_SECRET');
    expect(page).toContain("fetch('/api/admin/logout'");
  });

  it('keeps guest paths outside admin middleware matching', async () => {
    const middleware = await read('middleware.ts');
    expect(middleware).toContain("matcher: ['/admin/:path*', '/api/admin/:path*']");
    expect(middleware).not.toContain("matcher: ['/((?!_next");
  });

  it('documents the protected and public admin path contract', async () => {
    const middleware = await read('middleware.ts');
    expect(middleware).toContain("const isAdminPage = pathname === '/admin'");
    expect(middleware).toContain("const isAdminApi = pathname.startsWith('/api/admin/')");
    expect(middleware).toContain("pathname === '/admin/login' || pathname === '/admin/forbidden'");
    expect(middleware).toContain("matcher: ['/admin/:path*', '/api/admin/:path*']");
  });

  it('keeps logout session-ending and separate from privileged admin authorization', async () => {
    const logout = await read('app/api/admin/logout/route.ts');
    expect(logout).toContain('supabase.auth.signOut()');
    expect(logout).toContain('sameOrigin');
    expect(logout).not.toContain('requireAdminUser');
    expect(logout).toContain("'private, no-store'");
  });

});
