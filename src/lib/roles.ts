export type AppRole =
  | 'Developer'
  | 'Administrator'
  | 'Back Office User'
  // Additive role: sits in Role 2/3 next to a real job role and grants exactly
  // one capability, managePaymentTerms. Somebody holding ONLY this role can do
  // nothing else in the app. Exists so payment terms can be trusted to named
  // people without handing out Administrator or opening it to every Sales
  // Manager. dbo.AspNetRoles row 32, created 2026-09-02.
  | 'Finance Manager'
  | 'Sales Manager'
  | 'Sales Team'
  | 'Simple User';

export type Permission =
  | 'dangerousOps'
  | 'criticalOps'
  | 'manageUsers'
  | 'managePriceLists'
  | 'cleanupPriceLists'
  | 'managePricingPolicies'
  | 'manageBrandsSuppliers'
  | 'viewBrandsSuppliers'
  | 'manageCitiesCountries'
  | 'manageMarkets'
  | 'createOffers'
  | 'editOffers'
  | 'manageCustomersContacts'
  // A customer's STANDING payment terms are a commercial commitment, so they are
  // deliberately NOT part of manageCustomersContacts (which every role from
  // Simple User up holds). This permission covers the two places that standing
  // term is set: the /payment-terms catalogue (dbo.PaymentTerms rows) and
  // Customers.PaymentTermID. Held by Finance Manager plus the Administrator /
  // Developer bypass. The term on an individual OFFER is a sales decision and is
  // NOT gated by this: anyone with createOffers / editOffers may change it.
  | 'managePaymentTerms'
  // Merging duplicate customers repoints offers and contacts onto a survivor and
  // disables the records that lost. It is not reversible from the UI, so it
  // deliberately has NO case in the switch below
  // and falls through to `default: return false` — landing on Administrator +
  // Developer only.
  | 'mergeCustomers'
  | 'manageMarketing';

export const APP_ROLE_ORDER: readonly AppRole[] = [
  'Developer',
  'Administrator',
  'Back Office User',
  'Finance Manager',
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
  'finance manager': 'Finance Manager',
  finance: 'Finance Manager',
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
    // Pricelist cleanup tool (parse/normalize uploaded price lists) — open to the
    // sales side too, unlike full price-list management.
    case 'cleanupPriceLists':
      return (
        roles.includes('Sales Team') ||
        roles.includes('Sales Manager') ||
        roles.includes('Back Office User')
      );
    case 'manageMarkets':
      return roles.includes('Back Office User') || roles.includes('Sales Manager');
    // Permission ID 40: brands & suppliers management
    case 'manageBrandsSuppliers':
      return (
        roles.includes('Sales Team') ||
        roles.includes('Sales Manager') ||
        roles.includes('Back Office User')
      );
    // Read-only access to brands & suppliers (superset of the management roles
    // above, plus Simple User). Gates the suppliers grid read endpoint.
    case 'viewBrandsSuppliers':
      return (
        roles.includes('Simple User') ||
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
    case 'managePaymentTerms':
      return roles.includes('Finance Manager');
    case 'manageUsers':
      return false;
    case 'dangerousOps':
    case 'criticalOps':
    default:
      return false;
  }
};
