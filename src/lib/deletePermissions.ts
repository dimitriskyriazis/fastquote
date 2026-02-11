import { roleHasPermission, coerceRoles, type AppRole, type Permission } from './roles';

export type DeleteCategory =
  | 'offers'
  | 'pricelists'
  | 'pricingPolicies'
  | 'pricingPolicyRules'
  | 'generic';

export type DeletePermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function checkDeletePermission(
  roles: readonly AppRole[],
  count: number,
  category: DeleteCategory,
  basePermission: Permission | null,
): DeletePermissionResult {
  if (basePermission && !roleHasPermission(roles, basePermission)) {
    return { allowed: false, reason: 'You do not have permission to delete these records.' };
  }

  const hasDangerousOps = roleHasPermission(roles, 'dangerousOps');
  const hasCriticalOps = roleHasPermission(roles, 'criticalOps');

  switch (category) {
    case 'offers':
      if (count >= 2) {
        if (!hasCriticalOps)
          return { allowed: false, reason: 'Only developers can delete multiple offers at once.' };
      } else if (count >= 1) {
        if (!hasDangerousOps)
          return { allowed: false, reason: 'Only administrators and developers can delete offers.' };
      }
      break;

    case 'pricelists':
      if (count > 5) {
        if (!hasCriticalOps)
          return { allowed: false, reason: 'Only developers can delete more than 5 price lists at once.' };
      } else if (count >= 2) {
        if (!hasDangerousOps)
          return { allowed: false, reason: 'Only administrators and developers can delete multiple price lists at once.' };
      }
      break;

    case 'pricingPolicies':
      if (!hasDangerousOps)
        return { allowed: false, reason: 'Only administrators and developers can delete pricing policies.' };
      break;

    case 'pricingPolicyRules':
      if (!hasDangerousOps)
        return { allowed: false, reason: 'Only administrators and developers can delete pricing policy rules.' };
      break;

    case 'generic':
      if (count > 50) {
        if (!hasCriticalOps)
          return { allowed: false, reason: 'Only developers can delete more than 50 records at once.' };
      } else if (count > 10) {
        if (!hasDangerousOps)
          return { allowed: false, reason: 'Only administrators and developers can delete more than 10 records at once.' };
      }
      break;
  }

  return { allowed: true };
}

export function checkDeletePermissionForClient(
  roles: readonly string[],
  count: number,
  category: DeleteCategory,
  basePermission: Permission | null,
): DeletePermissionResult {
  const appRoles = coerceRoles([...roles]);
  return checkDeletePermission(appRoles, count, category, basePermission);
}

export function canDeleteAnyForClient(
  roles: readonly string[],
  category: DeleteCategory,
  basePermission: Permission | null,
): boolean {
  return checkDeletePermissionForClient(roles, 1, category, basePermission).allowed;
}
