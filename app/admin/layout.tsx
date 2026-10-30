import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminAuthorizationError, requireAdminUser } from '@/lib/admin-auth';

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  if (requestHeaders.get('x-admin-public-page') === '1') return children;

  try {
    await requireAdminUser();
  } catch (error) {
    if (error instanceof AdminAuthorizationError && error.status === 401) redirect('/admin/login');
    if (error instanceof AdminAuthorizationError && error.status === 403) redirect('/admin/forbidden');
    throw error;
  }

  return <>{children}</>;
}
