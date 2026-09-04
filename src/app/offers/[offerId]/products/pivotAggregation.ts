import type { IAggFuncParams, IRowNode } from 'ag-grid-community';
import { isOfferProductOption } from '../../../../lib/offerProductRows';

type RowData = Record<string, unknown>;

/**
 * Option lines (IsOption) are quoted to the customer as optional extras and stay out of
 * the offer totals: the products endpoint's TOTALS_ROW_PREDICATE drops them from the
 * totals bar and the main grid leaves them out of category totals. The pivot's group
 * sums have to follow the same rule, otherwise a brand/category row adds up to more than
 * the offer it belongs to.
 *
 * AG Grid hands an agg function nothing but the child values, so the option flag is
 * recovered from the row nodes. When the group is a leaf group its children are the
 * offer lines themselves and the value list is rebuilt from them minus the option lines;
 * higher-level groups just combine their children's (already option-free) aggregates.
 * This mirrors how AggregationStage gathers values:
 *   - no pivot columns: values come from rowNode.childrenAfterFilter;
 *   - pivot columns: leaf-group values come from rowNode.childrenMapped walked by the
 *     pivot result column's pivotKeys; pivot total columns re-aggregate other pivot
 *     cells (already option-free) and are passed through untouched.
 */

type PivotRowNode = IRowNode<RowData> & { childrenMapped?: Record<string, unknown> | null };

const isOptionNode = (node: IRowNode<RowData>): boolean => isOfferProductOption(node.data ?? null);

/**
 * The row nodes `params.values` was built from, or null when those values are the
 * aggregates of child groups / other pivot cells rather than offer lines.
 */
export const aggregatedLeafNodes = (params: IAggFuncParams<RowData, unknown>): IRowNode<RowData>[] | null => {
  const rowNode = params.rowNode as PivotRowNode | undefined;
  if (!rowNode || !rowNode.leafGroup) return null;
  const { pivotResultColumn } = params;
  if (!pivotResultColumn) {
    return rowNode.childrenAfterFilter ?? rowNode.childrenAfterGroup ?? [];
  }
  const colDef = pivotResultColumn.getColDef();
  if (colDef.pivotTotalColumnIds?.length) return null;
  let pointer: unknown = rowNode.childrenMapped;
  for (const key of colDef.pivotKeys ?? []) {
    pointer = pointer && typeof pointer === 'object' ? (pointer as Record<string, unknown>)[key] : null;
  }
  return Array.isArray(pointer) ? (pointer as IRowNode<RowData>[]) : null;
};

/** The values AG Grid would aggregate, minus those contributed by option lines. */
export const valuesWithoutOptions = (params: IAggFuncParams<RowData, unknown>): unknown[] => {
  const leaves = aggregatedLeafNodes(params);
  if (!leaves) return params.values;
  const values: unknown[] = [];
  for (const leaf of leaves) {
    if (isOptionNode(leaf)) continue;
    values.push(params.api.getCellValue({ rowNode: leaf, colKey: params.column }));
  }
  return values;
};

/**
 * Drop-in for AG Grid's built-in `sum` (registered under the same name) that leaves
 * option lines out. Same contract: finite numbers add up, anything else is skipped, and
 * a group with nothing to add returns null so the formatters render it blank.
 */
export const sumWithoutOptions = (params: IAggFuncParams<RowData, unknown>): number | null => {
  let result: number | null = null;
  for (const value of valuesWithoutOptions(params)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    result = (result ?? 0) + value;
  }
  return result;
};

/**
 * "Total Cost (Other Currency)" values are per-currency maps so a brand costed in one
 * foreign currency shows a single amount, while a group that mixes currencies lists each
 * one instead of adding unlike currencies together.
 */
export type ForeignCostTotals = Record<string, number>;

export const foreignCostAggFunc = (params: IAggFuncParams<RowData, unknown>): ForeignCostTotals | null => {
  let merged: ForeignCostTotals | null = null;
  for (const value of valuesWithoutOptions(params)) {
    if (!value || typeof value !== 'object') continue;
    for (const [currency, amount] of Object.entries(value as ForeignCostTotals)) {
      if (!Number.isFinite(amount)) continue;
      if (!merged) merged = {};
      merged[currency] = (merged[currency] ?? 0) + amount;
    }
  }
  return merged;
};
