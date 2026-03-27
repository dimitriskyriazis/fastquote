export type FarnellPriceTier = {
  from: number;
  to: number;
  cost: number;
};

export type FarnellProduct = {
  sku: string;
  displayName: string;
  manufacturerPartNumber: string | null;
  brandName: string | null;
  description: string | null;
  productURL: string | null;
  stock: number | null;
  prices: FarnellPriceTier[];
  matchedPrice: number | null;
};

export function matchPriceTier(
  prices: FarnellPriceTier[],
  quantity: number,
): number | null {
  if (prices.length === 0) return null;
  const tier = prices.find((p) => quantity >= p.from && quantity <= p.to);
  return tier?.cost ?? prices[0]?.cost ?? null;
}

function parseJsonPrices(
  rawPrices: unknown,
): FarnellPriceTier[] {
  if (!Array.isArray(rawPrices)) return [];
  return rawPrices
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const from = Number(p.from);
      const to = Number(p.to);
      const cost = Number(p.cost);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(cost)) return null;
      return { from, to, cost };
    })
    .filter((p): p is FarnellPriceTier => p != null);
}

function parseApiProducts(data: unknown): unknown[] {
  const d = data as Record<string, unknown> | null;
  const products =
    (d?.manufacturerPartNumberReturn as Record<string, unknown> | undefined)?.products ??
    (d?.manufacturerPartNumberSearchReturn as Record<string, unknown> | undefined)?.products ??
    (d?.premierFarnellPartNumberReturn as Record<string, unknown> | undefined)?.products ??
    (d?.keywordSearchReturn as Record<string, unknown> | undefined)?.products ??
    null;
  return Array.isArray(products) ? products : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRawProduct(product: any, sku: string, qty: number): FarnellProduct {
  const prices = parseJsonPrices(product.prices);
  return {
    sku: String(product.sku ?? sku),
    displayName: String(product.displayName ?? ''),
    manufacturerPartNumber:
      product.translatedManufacturerPartNumber
        ? String(product.translatedManufacturerPartNumber)
        : null,
    brandName: product.brandName ? String(product.brandName) : null,
    description:
      product.productOverview?.description
        ? String(product.productOverview.description)
        : null,
    productURL: product.productURL ? String(product.productURL) : null,
    stock:
      typeof product.stock?.level === 'number'
        ? product.stock.level
        : product.inv != null
          ? Number(product.inv)
          : null,
    prices,
    matchedPrice: matchPriceTier(prices, qty),
  };
}

async function callFarnellApi(
  sku: string,
  searchType: 'id' | 'manuPartNum',
  maxResults: number,
): Promise<unknown> {
  const apiKey = process.env.FARNELL_API_KEY;
  if (!apiKey) {
    console.error('FARNELL_API_KEY is not configured');
    return null;
  }

  const params = new URLSearchParams({
    'versionNumber': '1.4',
    'term': `${searchType}:${sku}`,
    'storeInfo.id': 'be.farnell.com',
    'resultsSettings.offset': '0',
    'resultsSettings.numberOfResults': String(maxResults),
    'resultsSettings.responseGroup': 'large',
    'callInfo.omitXmlSchema': 'false',
    'callInfo.responseDataFormat': 'json',
    'callInfo.apiKey': apiKey,
  });

  const url = `https://api.element14.com/catalog/products?${params.toString()}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    console.error(`Farnell API returned status ${response.status} for SKU ${sku}`);
    return null;
  }

  return response.json();
}

export async function fetchFarnellProduct(
  sku: string,
  quantity?: number,
  searchType: 'id' | 'manuPartNum' = 'id',
): Promise<FarnellProduct | null> {
  try {
    const data = await callFarnellApi(sku, searchType, 1);
    const products = parseApiProducts(data);
    if (products.length === 0) return null;
    const qty = quantity != null && quantity > 0 ? quantity : 1;
    return mapRawProduct(products[0], sku, qty);
  } catch (err) {
    console.error('Failed to fetch Farnell product', err);
    return null;
  }
}

export async function fetchFarnellProducts(
  sku: string,
  quantity?: number,
  searchType: 'id' | 'manuPartNum' = 'id',
  maxResults = 10,
): Promise<FarnellProduct[]> {
  try {
    const data = await callFarnellApi(sku, searchType, maxResults);
    const products = parseApiProducts(data);
    if (products.length === 0) return [];
    const qty = quantity != null && quantity > 0 ? quantity : 1;
    return products.map((p) => mapRawProduct(p, sku, qty));
  } catch (err) {
    console.error('Failed to fetch Farnell products', err);
    return [];
  }
}
