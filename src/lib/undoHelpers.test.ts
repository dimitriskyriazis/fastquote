import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeOfferDetailRevert } from './undoHelpers';

type RevertParams = Parameters<typeof makeOfferDetailRevert>[0];

const makeNode = (data: Record<string, unknown>) => {
  const setDataValue = vi.fn();
  const node = { data, setDataValue } as unknown as RevertParams['node'];
  return { node, setDataValue };
};

const makeApi = () => {
  const refreshServerSide = vi.fn();
  const api = { refreshServerSide } as unknown as RevertParams['api'];
  return { api, refreshServerSide };
};

const stubFetch = (payload: unknown, ok = true) => {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => payload }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('makeOfferDetailRevert', () => {
  it('repaints server-recomputed derived columns (e.g. Customer Discount) on a List Price revert', async () => {
    stubFetch({
      ok: true,
      resolvedRows: [{ OfferDetailID: 42, CustomerDiscount: 10, NetUnitPrice: 90, ListPrice: 100 }],
    });
    const { node, setDataValue } = makeNode({ OfferDetailID: 42 });
    const { api } = makeApi();

    await makeOfferDetailRevert({
      endpoint: '/api/offers/1/products',
      offerDetailId: 42,
      patch: { ListPrice: 100 },
      cells: [['ListPrice', 100]],
      node,
      api,
    })();

    // Derived columns restored from resolvedRows, all with source 'api'.
    expect(setDataValue).toHaveBeenCalledWith('CustomerDiscount', 10, 'api');
    expect(setDataValue).toHaveBeenCalledWith('NetUnitPrice', 90, 'api');
    // The explicitly-reverted field is also written.
    expect(setDataValue).toHaveBeenCalledWith('ListPrice', 100, 'api');
  });

  it('throws when the PATCH response is not ok (so the entry is kept for retry)', async () => {
    stubFetch({ ok: false }, false);
    const { node } = makeNode({ OfferDetailID: 42 });
    const { api } = makeApi();
    await expect(
      makeOfferDetailRevert({
        endpoint: '/x',
        offerDetailId: 42,
        patch: { Quantity: 1 },
        cells: [['Quantity', 1]],
        node,
        api,
      })(),
    ).rejects.toThrow(/revert/i);
  });

  it('skips the derived List Price on a foreign-currency row when not reverting List Price', async () => {
    stubFetch({
      ok: true,
      resolvedRows: [{ OfferDetailID: 7, Margin: 20, ListPrice: 999 }],
    });
    const { node, setDataValue } = makeNode({ OfferDetailID: 7, OtherCurrencyID: 5 });
    const { api } = makeApi();

    await makeOfferDetailRevert({
      endpoint: '/x',
      offerDetailId: 7,
      patch: { Margin: 20 },
      cells: [['Margin', 20]],
      node,
      api,
    })();

    expect(setDataValue).toHaveBeenCalledWith('Margin', 20, 'api');
    // EffectiveListPrice (999) must NOT be written into the List Price cell here.
    expect(setDataValue).not.toHaveBeenCalledWith('ListPrice', 999, 'api');
  });

  it('still applies the derived List Price when List Price itself is being reverted on a foreign-currency row', async () => {
    stubFetch({
      ok: true,
      resolvedRows: [{ OfferDetailID: 7, CustomerDiscount: 5, ListPrice: 250 }],
    });
    const { node, setDataValue } = makeNode({ OfferDetailID: 7, OtherCurrencyID: 5 });
    const { api } = makeApi();

    await makeOfferDetailRevert({
      endpoint: '/x',
      offerDetailId: 7,
      patch: { ListPrice: 250 },
      cells: [['ListPrice', 250]],
      node,
      api,
    })();

    expect(setDataValue).toHaveBeenCalledWith('CustomerDiscount', 5, 'api');
    expect(setDataValue).toHaveBeenCalledWith('ListPrice', 250, 'api');
  });
});
