import { describe, it, expect } from 'vitest';
import type { IAggFuncParams, IRowNode } from 'ag-grid-community';
import {
  aggregatedLeafNodes,
  foreignCostAggFunc,
  sumWithoutOptions,
  valuesWithoutOptions,
} from '../pivotAggregation';

/**
 * The offer pivot must leave option lines (IsOption) out of its group sums, the same way
 * the totals bar and the main grid's category totals do. AG Grid only passes child
 * values to an agg function, so the helpers rebuild the leaf value list from the row
 * nodes. These tests drive them with hand-built nodes shaped like AggregationStage's.
 */

type RowData = Record<string, unknown>;
type Node = IRowNode<RowData>;

const leaf = (data: RowData): Node => ({ data, group: false, leafGroup: undefined } as unknown as Node);

const leafGroup = (children: Node[], extra: Record<string, unknown> = {}): Node =>
  ({ group: true, leafGroup: true, childrenAfterFilter: children, childrenAfterGroup: children, ...extra } as unknown as Node);

const parentGroup = (children: Node[]): Node =>
  ({ group: true, leafGroup: false, childrenAfterFilter: children, childrenAfterGroup: children } as unknown as Node);

const column = (colId: string) => ({ getColId: () => colId, getColDef: () => ({ field: colId }) });

const pivotColumn = (colDef: Record<string, unknown>) => ({ getColId: () => 'pivot_x', getColDef: () => colDef });

// Mirrors what AG Grid's `values` would be for the node: leaf values for leaf groups,
// child aggregates for parent groups.
const buildParams = (
  rowNode: Node,
  colId: string,
  values: unknown[],
  pivotResultColumn?: ReturnType<typeof pivotColumn>,
): IAggFuncParams<RowData, unknown> => {
  const col = column(colId);
  return {
    values,
    column: col,
    colDef: col.getColDef(),
    pivotResultColumn,
    rowNode,
    data: rowNode.data,
    api: {
      getCellValue: ({ rowNode: node, colKey }: { rowNode: Node; colKey: unknown }) => {
        const key = typeof colKey === 'string' ? colKey : (colKey as { getColId: () => string }).getColId();
        return node.data?.[key] ?? null;
      },
    },
    context: undefined,
  } as unknown as IAggFuncParams<RowData, unknown>;
};

const leafValues = (nodes: Node[], colId: string) => nodes.map((node) => node.data?.[colId] ?? null);

describe('sumWithoutOptions', () => {
  it('leaves option lines out of a leaf group sum', () => {
    const lines = [
      leaf({ TotalPrice: 100, IsOption: 0 }),
      leaf({ TotalPrice: 250, IsOption: 1 }),
      leaf({ TotalPrice: 40, IsOption: null }),
    ];
    const params = buildParams(leafGroup(lines), 'TotalPrice', leafValues(lines, 'TotalPrice'));
    expect(sumWithoutOptions(params)).toBe(140);
  });

  it('recognises every stored IsOption spelling', () => {
    const lines = [
      leaf({ TotalCost: 10, IsOption: true }),
      leaf({ TotalCost: 20, IsOption: '1' }),
      leaf({ TotalCost: 30, IsOption: 1 }),
      leaf({ TotalCost: 5, IsOption: false }),
      leaf({ TotalCost: 7, IsOption: '0' }),
    ];
    const params = buildParams(leafGroup(lines), 'TotalCost', leafValues(lines, 'TotalCost'));
    expect(sumWithoutOptions(params)).toBe(12);
  });

  it('returns null when only option lines remain so the cell renders blank', () => {
    const lines = [leaf({ TotalNet: 99, IsOption: 1 }), leaf({ TotalNet: 1, IsOption: 1 })];
    const params = buildParams(leafGroup(lines), 'TotalNet', leafValues(lines, 'TotalNet'));
    expect(sumWithoutOptions(params)).toBeNull();
  });

  it('skips non-numeric leaf values like the built-in sum', () => {
    const lines = [leaf({ Quantity: 2 }), leaf({ Quantity: null }), leaf({ Quantity: 'n/a' }), leaf({ Quantity: 3 })];
    const params = buildParams(leafGroup(lines), 'Quantity', leafValues(lines, 'Quantity'));
    expect(sumWithoutOptions(params)).toBe(5);
  });

  it('adds up child-group aggregates untouched for a parent group', () => {
    // Brand -> Part No layout: the brand row combines the part-number rows' aggregates,
    // which are already option-free; the leaf data hanging off the children is not consulted.
    const partA = leafGroup([leaf({ TotalPrice: 999, IsOption: 1 })]);
    const partB = leafGroup([leaf({ TotalPrice: 999, IsOption: 1 })]);
    const params = buildParams(parentGroup([partA, partB]), 'TotalPrice', [120, null, 30]);
    expect(sumWithoutOptions(params)).toBe(150);
  });

  it('uses childrenAfterFilter so quick-filtered lines stay out, like AG Grid does', () => {
    const kept = [leaf({ TotalPrice: 10, IsOption: 0 })];
    const all = [...kept, leaf({ TotalPrice: 500, IsOption: 0 })];
    const node = { group: true, leafGroup: true, childrenAfterFilter: kept, childrenAfterGroup: all } as unknown as Node;
    const params = buildParams(node, 'TotalPrice', leafValues(kept, 'TotalPrice'));
    expect(sumWithoutOptions(params)).toBe(10);
  });
});

describe('pivot columns', () => {
  it('walks childrenMapped by the pivot keys for a leaf group cell', () => {
    const acme = [leaf({ TotalPrice: 100, IsOption: 0 }), leaf({ TotalPrice: 60, IsOption: 1 })];
    const other = [leaf({ TotalPrice: 1000, IsOption: 0 })];
    const node = leafGroup([...acme, ...other], { childrenMapped: { Acme: acme, Other: other } });
    const pivotCol = pivotColumn({ pivotKeys: ['Acme'], pivotValueColumn: column('TotalPrice') });
    const params = buildParams(node, 'TotalPrice', leafValues(acme, 'TotalPrice'), pivotCol);
    expect(aggregatedLeafNodes(params)).toBe(acme);
    expect(sumWithoutOptions(params)).toBe(100);
  });

  it('passes pivot total columns through since they combine option-free cells', () => {
    const node = leafGroup([leaf({ TotalPrice: 5, IsOption: 1 })], { childrenMapped: {} });
    const totalCol = pivotColumn({ pivotKeys: [], pivotTotalColumnIds: ['pivot_a', 'pivot_b'] });
    const params = buildParams(node, 'TotalPrice', [100, 200], totalCol);
    expect(aggregatedLeafNodes(params)).toBeNull();
    expect(sumWithoutOptions(params)).toBe(300);
  });

  it('falls back to the given values when the mapped set cannot be resolved', () => {
    const node = leafGroup([leaf({ TotalPrice: 5, IsOption: 1 })], { childrenMapped: null });
    const pivotCol = pivotColumn({ pivotKeys: ['Missing'] });
    const params = buildParams(node, 'TotalPrice', [7], pivotCol);
    expect(valuesWithoutOptions(params)).toEqual([7]);
  });
});

describe('foreignCostAggFunc', () => {
  it('merges per-currency maps and leaves option lines out', () => {
    const lines = [
      leaf({ NetCostOtherCurrency: { $: 100 }, IsOption: 0 }),
      leaf({ NetCostOtherCurrency: { $: 999 }, IsOption: 1 }),
      leaf({ NetCostOtherCurrency: { '£': 20 }, IsOption: 0 }),
      leaf({ NetCostOtherCurrency: null, IsOption: 0 }),
    ];
    const params = buildParams(leafGroup(lines), 'NetCostOtherCurrency', leafValues(lines, 'NetCostOtherCurrency'));
    expect(foreignCostAggFunc(params)).toEqual({ $: 100, '£': 20 });
  });

  it('returns null when nothing is left to merge', () => {
    const lines = [leaf({ NetCostOtherCurrency: { $: 999 }, IsOption: 1 })];
    const params = buildParams(leafGroup(lines), 'NetCostOtherCurrency', leafValues(lines, 'NetCostOtherCurrency'));
    expect(foreignCostAggFunc(params)).toBeNull();
  });
});
