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

export async function fetchFarnellProduct(
  sku: string,
  quantity?: number,
  searchType: 'id' | 'manuPartNum' = 'id',
): Promise<FarnellProduct | null> {
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
    'resultsSettings.numberOfResults': '1',
    'resultsSettings.responseGroup': 'large',
    'callInfo.omitXmlSchema': 'false',
    'callInfo.responseDataFormat': 'json',
    'callInfo.apiKey': apiKey,
  });

  const url = `https://api.element14.com/catalog/products?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`Farnell API returned status ${response.status} for SKU ${sku}`);
      return null;
    }

    const data = await response.json();

    const products =
      data?.manufacturerPartNumberReturn?.products ??
      data?.manufacturerPartNumberSearchReturn?.products ??
      data?.premierFarnellPartNumberReturn?.products ??
      data?.keywordSearchReturn?.products ??
      null;

    if (!Array.isArray(products) || products.length === 0) {
      return null;
    }

    const product = products[0];

    const prices = parseJsonPrices(product.prices);
    const qty = quantity != null && quantity > 0 ? quantity : 1;

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
  } catch (err) {
    console.error('Failed to fetch Farnell product', err);
    return null;
  }
}
