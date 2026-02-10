// Single condition types (existing filter formats)
export type TextCondition = {
  filterType: "text";
  type?: "contains" | "equals" | "notEqual" | "startsWith" | "endsWith" | "blank" | "notBlank";
  filter?: string;
};

export type NumberCondition = {
  filterType: "number";
  type?: "equals" | "notEqual" | "lessThan" | "greaterThan" | "lessThanOrEqual" | "greaterThanOrEqual" | "inRange" | "blank" | "notBlank";
  filter?: number;
  filterTo?: number;
};

export type DateCondition = {
  filterType: "date";
  type?: "equals" | "notEqual" | "lessThan" | "greaterThan" | "lessThanOrEqual" | "greaterThanOrEqual" | "inRange" | "blank" | "notBlank";
  dateFrom?: string;
  dateTo?: string;
  filter?: string;
};

export type SetFilterModel = {
  filterType: "set";
  values?: Array<string | number | boolean>;
};

type CompoundOperator = "AND" | "OR";

// Compound filter types (2-condition filtering, modern and legacy shapes)
export type CompoundTextFilter = {
  filterType: "text";
  operator: CompoundOperator;
  conditions: TextCondition[];
};

export type CompoundNumberFilter = {
  filterType: "number";
  operator: CompoundOperator;
  conditions: NumberCondition[];
};

export type CompoundDateFilter = {
  filterType: "date";
  operator: CompoundOperator;
  conditions: DateCondition[];
};

export type LegacyCompoundTextFilter = {
  filterType: "text";
  operator: CompoundOperator;
  condition1?: TextCondition;
  condition2?: TextCondition;
};

export type LegacyCompoundNumberFilter = {
  filterType: "number";
  operator: CompoundOperator;
  condition1?: NumberCondition;
  condition2?: NumberCondition;
};

export type LegacyCompoundDateFilter = {
  filterType: "date";
  operator: CompoundOperator;
  condition1?: DateCondition;
  condition2?: DateCondition;
};

export type AnyCompoundFilter =
  | CompoundTextFilter
  | CompoundNumberFilter
  | CompoundDateFilter
  | LegacyCompoundTextFilter
  | LegacyCompoundNumberFilter
  | LegacyCompoundDateFilter;

// Union types for backward compatibility
export type TextFilterModel = TextCondition | CompoundTextFilter | LegacyCompoundTextFilter;
export type NumberFilterModel = NumberCondition | CompoundNumberFilter | LegacyCompoundNumberFilter;
export type DateFilterModel = DateCondition | CompoundDateFilter | LegacyCompoundDateFilter;

export type KnownFilterModel =
  | TextFilterModel
  | NumberFilterModel
  | DateFilterModel
  | SetFilterModel;

// Type guard helpers
export function isCompoundFilter(
  filter: KnownFilterModel
): filter is AnyCompoundFilter {
  if (!("operator" in filter)) return false;
  if ("conditions" in filter && Array.isArray(filter.conditions)) return true;
  return "condition1" in filter || "condition2" in filter;
}

export function isSingleConditionFilter(
  filter: KnownFilterModel
): filter is TextCondition | NumberCondition | DateCondition {
  return !isCompoundFilter(filter) && filter.filterType !== 'set';
}

export function getCompoundFilterConditions(
  filter: AnyCompoundFilter
): Array<TextCondition | NumberCondition | DateCondition> {
  if ("conditions" in filter && Array.isArray(filter.conditions)) {
    return filter.conditions;
  }
  const conditions: Array<TextCondition | NumberCondition | DateCondition> = [];
  if ("condition1" in filter && filter.condition1) {
    conditions.push(filter.condition1);
  }
  if ("condition2" in filter && filter.condition2) {
    conditions.push(filter.condition2);
  }
  return conditions;
}
