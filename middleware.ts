import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const ADMIN_LOGIN_PATH = '/admin/login';

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  // Never trust this internal marker from the browser. It is added only below
  // for the two exact public admin pages after the client value is removed.
  requestHeaders.delete('x-admin-public-page');
  const pathname = request.nextUrl.pathname;
  const isPublicAdminPage = pathname === '/admin/login' || pathname === '/admin/forbidden';
  if (isPublicAdminPage) requestHeaders.set('x-admin-public-page', '1');

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();
  const isAdminPage = pathname === '/admin' || (pathname.startsWith('/admin/') && !isPublicAdminPage);
  const isAdminApi = pathname.startsWith('/api/admin/');

  if (isAdminPage && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = ADMIN_LOGIN_PATH;
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAdminApi && !user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  }

  return response;
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
