'use client';

export type MarketFormValues = {
  name: string;
  salesDivision: string;
  enabled: boolean;
};

export const EMPTY_MARKET_FORM: MarketFormValues = {
  name: '',
  salesDivision: '',
  enabled: true,
};

export const validateMarketForm = (form: MarketFormValues): string | null => {
  const trimmedName = (form.name ?? '').trim();
  if (!trimmedName) {
    return 'Market name is required.';
  }
  return null;
};

export const buildMarketPayload = (form: MarketFormValues) => ({
  name: (form.name ?? '').trim(),
  salesDivision: (form.salesDivision ?? '').trim(),
  enabled: Boolean(form.enabled),
});

export type MarketCreationResult = {
  ok: boolean;
  market?: {
    MarketID: number;
    Name: string | null;
    SalesDivision: string | null;
    Enabled: boolean | number | null;
  };
  error?: string;
};

const MARKET_CREATION_ENDPOINT = '/api/markets/create';

export const createMarket = async (form: MarketFormValues): Promise<MarketCreationResult> => {
  try {
    const response = await fetch(MARKET_CREATION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMarketPayload(form)),
    });
    const payload = (await response.json().catch(() => null)) as MarketCreationResult | null;
    if (!response.ok || !payload?.ok || !payload.market) {
      return {
        ok: false,
        error: payload?.error ?? 'Unable to add market.',
      };
    }
    return { ok: true, market: payload.market };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to add market.',
    };
  }
};
