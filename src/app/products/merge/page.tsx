import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { headers, cookies } from 'next/headers';
import { resolveAuditUserId } from '../../../lib/auditTrail';
import { fetchUserRoles } from '../../../lib/authz';
import { roleHasPermission, type AppRole } from '../../../lib/roles';
import ProductMergeClient from './ProductMergeClient';

export const metadata = {
  title: 'Merge products',
};

// Needs the per-request user to resolve roles.
export const dynamic = 'force-dynamic';

export default async function ProductMergePage() {
  let roles: AppRole[] = [];
  try {
    const [hdrs, cookieStore] = await Promise.all([headers(), cookies()]);
    const userId = resolveAuditUserId({ headers: hdrs as unknown as Headers, cookies: cookieStore });
    roles = await fetchUserRoles(userId);
  } catch (err) {
    console.error('Failed to resolve roles for product merge', err);
  }

  // Administrator + Developer only. This is UX, not the security boundary — the
  // audit id it resolves from is forgeable, so the real check is the
  // requirePermission call inside every /api/products/merge* route.
  if (!roleHasPermission(roles, 'mergeProducts')) {
    redirect('/');
  }

  return (
    <Suspense fallback={null}>
      <ProductMergeClient />
    </Suspense>
  );
}
