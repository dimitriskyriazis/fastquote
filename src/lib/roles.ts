export type AppRole =
  | 'Developer'
  | 'Administrator'
  | 'Back Office User'
  | 'Sales Manager'
  | 'Sales Team'
  | 'Simple User';

export type Permission =
  | 'dangerousOps'
  | 'criticalOps'
  | 'manageUsers'
  | 'managePriceLists'
  | 'managePricingPolicies'
  | 'manageBrandsSuppliers'
  | 'manageCitiesCountries'
  | 'manageMarkets'
  | 'createOffers'
  | 'editOffers'
  | 'manageCustomersContacts'
  | 'manageMarketing';

export const APP_ROLE_ORDER: readonly AppRole[] = [
  'Developer',
  'Administrator',
  'Back Office User',
  'Sales Manager',
  'Sales Team',
  'Simple User',
];

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

export const sortRoleNames = (roles: readonly string[]): string[] => {
  const order = new Map<string, number>();
  APP_ROLE_ORDER.forEach((role, index) => {
    order.set(role.toLowerCase(), index);
  });

  return [...roles].sort((a, b) => {
    const aOrder = order.get(a.trim().toLowerCase());
    const bOrder = order.get(b.trim().toLowerCase());
    if (aOrder != null && bOrder != null) return aOrder - bOrder;
    if (aOrder != null) return -1;
    if (bOrder != null) return 1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
};

export const roleHasPermission = (roles: readonly AppRole[], permission: Permission): boolean => {
  if (roles.includes('Developer')) return true;
  if (roles.includes('Administrator')) {
    return permission !== 'criticalOps';
  }

  switch (permission) {
    case 'managePriceLists':
    case 'managePricingPolicies':
      return roles.includes('Back Office User') || roles.includes('Sales Manager');
    case 'manageMarkets':
      return roles.includes('Back Office User') || roles.includes('Sales Manager');
    // Permission ID 40: brands & suppliers management
    case 'manageBrandsSuppliers':
      return (
        roles.includes('Sales Team') ||
        roles.includes('Sales Manager') ||
        roles.includes('Back Office User')
      );
    // Permission ID 50: cities & countries management
    case 'manageCitiesCountries':
      return (
        roles.includes('Simple User') ||
        roles.includes('Sales Team') ||
        roles.includes('Sales Manager') ||
        roles.includes('Back Office User')
      );
    case 'createOffers':
    case 'editOffers':
      return roles.includes('Sales Manager') || roles.includes('Sales Team') || roles.includes('Back Office User');
    case 'manageCustomersContacts':
      return (
        roles.includes('Simple User') ||
        roles.includes('Back Office User') ||
        roles.includes('Sales Manager') ||
        roles.includes('Sales Team')
      );
    case 'manageUsers':
      return false;
    case 'dangerousOps':
    case 'criticalOps':
    default:
      return false;
  }
};
