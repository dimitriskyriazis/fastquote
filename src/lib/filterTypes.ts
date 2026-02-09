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

// Compound filter types (new - for 2-condition filtering)
export type CompoundTextFilter = {
  filterType: "text";
  operator: "AND" | "OR";
  conditions: TextCondition[];
};

export type CompoundNumberFilter = {
  filterType: "number";
  operator: "AND" | "OR";
  conditions: NumberCondition[];
};

export type CompoundDateFilter = {
  filterType: "date";
  operator: "AND" | "OR";
  conditions: DateCondition[];
};

// Union types for backward compatibility
export type TextFilterModel = TextCondition | CompoundTextFilter;
export type NumberFilterModel = NumberCondition | CompoundNumberFilter;
export type DateFilterModel = DateCondition | CompoundDateFilter;

export type KnownFilterModel =
  | TextFilterModel
  | NumberFilterModel
  | DateFilterModel
  | SetFilterModel;

// Type guard helpers
export function isCompoundFilter(
  filter: KnownFilterModel
): filter is CompoundTextFilter | CompoundNumberFilter | CompoundDateFilter {
  return 'operator' in filter && 'conditions' in filter && Array.isArray(filter.conditions);
}

export function isSingleConditionFilter(
  filter: KnownFilterModel
): filter is TextCondition | NumberCondition | DateCondition {
  return !isCompoundFilter(filter) && filter.filterType !== 'set';
}
