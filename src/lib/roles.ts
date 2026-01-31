export type AppRole =
  | 'Developer'
  | 'Administrator'
  | 'Back Office User'
  | 'Sales Manager'
  | 'Sales Team'
  | 'Simple User';

export type Permission =
  | 'dangerousOps'
  | 'managePriceLists'
  | 'managePricingPolicies'
  | 'createOffers'
  | 'editOffers'
  | 'manageCustomersContacts';

const ROLE_ALIASES: Record<string, AppRole> = {
  developer: 'Developer',
  administrator: 'Administrator',
  'back office user': 'Back Office User',
  'backoffice user': 'Back Office User',
  'back office': 'Back Office User',
  'sales manager': 'Sales Manager',
  'sales team': 'Sales Team',
  sales: 'Sales Team',
  'simple user': 'Simple User',
};

export const normalizeRoleName = (value: unknown): AppRole | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return ROLE_ALIASES[key] ?? null;
};

export const coerceRoles = (values: Array<string | null | undefined>): AppRole[] => {
  const unique = new Set<AppRole>();
  values.forEach((value) => {
    const normalized = normalizeRoleName(value);
    if (normalized) unique.add(normalized);
  });
  return Array.from(unique);
};

export const roleHasPermission = (roles: readonly AppRole[], permission: Permission): boolean => {
  if (roles.includes('Developer')) return true;
  if (roles.includes('Administrator')) {
    return permission !== 'dangerousOps';
  }

  switch (permission) {
    case 'managePriceLists':
    case 'managePricingPolicies':
      return roles.includes('Back Office User');
    case 'createOffers':
    case 'editOffers':
      return roles.includes('Sales Manager') || roles.includes('Sales Team');
    case 'manageCustomersContacts':
      return roles.includes('Simple User');
    case 'dangerousOps':
    default:
      return false;
  }
};
