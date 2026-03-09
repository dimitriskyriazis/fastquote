export type LogCategory = 'view' | 'mutation' | 'delete';

const READ_ONLY_POST_ENDPOINTS = new Set<string>([
  '/api/brands/grid',
  '/api/countries-cities/grid',
  '/api/customer-contacts',
  '/api/customer-groups',
  '/api/customers',
  '/api/duplicates',
  '/api/erp/smoke-test',
  '/api/markets',
  '/api/me',
  '/api/marketing/contact-groups',
  '/api/marketing/mails',
  '/api/offers',
  '/api/offers/batch-summary',
  '/api/price-lists',
  '/api/pricing-policies',
  '/api/pricing-policies/matrix',
  '/api/products',
  '/api/standard-packages',
  '/api/suppliers',
  '/api/user-management/grid',
]);

const READ_ONLY_POST_PATTERNS: RegExp[] = [
  /^\/api\/marketing\/mails\/[^/]+\/contacts$/,
  /^\/api\/marketing\/mails\/[^/]+\/contact-groups$/,
  /^\/api\/marketing\/mails\/[^/]+\/contact-groups\/count$/,
  /^\/api\/offers\/[^/]+\/products$/,
  /^\/api\/offers\/\[[^/]+\]\/products$/,
  /^\/api\/price-lists\/[^/]+\/products$/,
  /^\/api\/price-lists\/\[[^/]+\]\/products$/,
];

export function categoryFromRequest(method: string, endpoint?: string): LogCategory {
  const m = method.toUpperCase();
  if (m === 'DELETE') return 'delete';
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'view';

  if (m === 'POST' && endpoint) {
    const normalizedEndpoint = endpoint.split('?', 1)[0];
    if (
      READ_ONLY_POST_ENDPOINTS.has(normalizedEndpoint) ||
      normalizedEndpoint.endsWith('/grid') ||
      READ_ONLY_POST_PATTERNS.some((pattern) => pattern.test(normalizedEndpoint))
    ) {
      return 'view';
    }
  }

  return 'mutation';
}

export function categoryFromMethod(method: string): LogCategory {
  return categoryFromRequest(method);
}
