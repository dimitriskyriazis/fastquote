import { redirect } from 'next/navigation';
import { headers, cookies } from 'next/headers';
import { resolveAuditUserId } from '../../../lib/auditTrail';
import { fetchUserRoles } from '../../../lib/authz';
import { roleHasPermission, type AppRole } from '../../../lib/roles';
import CustomerDuplicatesClient from './CustomerDuplicatesClient';

export const metadata = {
  title: 'Possible duplicate customers',
};

// Needs the per-request user to resolve roles.
export const dynamic = 'force-dynamic';

export default async function CustomerDuplicatesPage() {
  let roles: AppRole[] = [];
  try {
    const [hdrs, cookieStore] = await Promise.all([headers(), cookies()]);
    const userId = resolveAuditUserId({ headers: hdrs as unknown as Headers, cookies: cookieStore });
    roles = await fetchUserRoles(userId);
  } catch (err) {
    console.error('Failed to resolve roles for duplicate customers', err);
  }

  // Administrator + Developer only; the API route enforces the same permission.
  if (!roleHasPermission(roles, 'mergeCustomers')) {
    redirect('/');
  }

  return <CustomerDuplicatesClient />;
}
