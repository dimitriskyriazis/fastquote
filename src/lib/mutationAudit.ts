import { logger } from './logger';
import type { LogContext } from './logger';

export type AuditId = number | string;

export type FieldUpdate<Field extends string = string, Id extends AuditId = AuditId> = {
  targetId: Id;
  field: Field;
};

export type FieldChange<Field extends string = string, Id extends AuditId = AuditId> = {
  targetId: Id;
  targetName?: string | null;
  field: Field;
  before: unknown;
  after: unknown;
};

export type DeletedRow<Id extends AuditId = AuditId> = {
  id: Id;
  name?: string | null;
  [key: string]: unknown;
};

export type CreatedRow<Id extends AuditId = AuditId> = {
  id: Id;
  name?: string | null;
  [key: string]: unknown;
};

export function indexRowsById<Row, Id extends AuditId>(
  rows: Iterable<Row>,
  getId: (row: Row) => Id,
): Map<Id, Row> {
  const result = new Map<Id, Row>();
  for (const row of rows) {
    result.set(getId(row), row);
  }
  return result;
}

export function buildFieldChanges<Row, Field extends string, Id extends AuditId>(params: {
  updates: Array<FieldUpdate<Field, Id>>;
  beforeById: Map<Id, Row>;
  afterById: Map<Id, Row>;
  getFieldValue: (row: Row | undefined, field: Field) => unknown;
  getTargetName?: (before: Row | undefined, after: Row | undefined) => string | null | undefined;
  onlyChanged?: boolean;
}): Array<FieldChange<Field, Id>> {
  const changes: Array<FieldChange<Field, Id>> = [];
  const onlyChanged = params.onlyChanged ?? true;

  for (const update of params.updates) {
    const before = params.beforeById.get(update.targetId);
    const after = params.afterById.get(update.targetId);
    const beforeValue = params.getFieldValue(before, update.field);
    const afterValue = params.getFieldValue(after, update.field);

    if (onlyChanged && Object.is(beforeValue, afterValue)) continue;

    changes.push({
      targetId: update.targetId,
      targetName: params.getTargetName?.(before, after) ?? null,
      field: update.field,
      before: beforeValue,
      after: afterValue,
    });
  }

  return changes;
}

const MAX_SUMMARY_ITEMS = 10;

function formatRowLabel(row: { id: AuditId; name?: string | null }): string {
  const name = row.name?.toString().trim();
  return name ? `'${name}' (ID: ${row.id})` : `ID: ${row.id}`;
}

function summarizeRows(rows: Array<{ id: AuditId; name?: string | null }>): string {
  if (rows.length === 0) return '';
  const shown = rows.slice(0, MAX_SUMMARY_ITEMS).map(formatRowLabel);
  const extra = rows.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}

function summarizeIds(ids: Array<AuditId>): string {
  if (ids.length === 0) return '';
  const shown = ids.slice(0, MAX_SUMMARY_ITEMS).map((id) => String(id));
  const extra = ids.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}

function summarizeFieldChange(change: FieldChange): string {
  const label = change.targetName ? `'${change.targetName}' (ID: ${change.targetId})` : `ID: ${change.targetId}`;
  const before = JSON.stringify(change.before);
  const after = JSON.stringify(change.after);
  return `${label} ${change.field}: ${before} → ${after}`;
}

export function logEditAuditDetails(params: {
  endpoint: string;
  method?: string;
  userId?: string | null;
  requestId?: string;
  targetEntity: string;
  changes: Array<FieldChange>;
  targetIds?: Array<AuditId>;
  message?: string;
  extra?: LogContext;
}): void {
  const targetIds = params.targetIds ?? Array.from(new Set(params.changes.map((change) => change.targetId)));
  const context: LogContext = {
    category: 'mutation',
    endpoint: params.endpoint,
    method: params.method ?? 'PATCH',
    userId: params.userId ?? null,
    requestId: params.requestId,
    changeType: 'edit',
    targetEntity: params.targetEntity,
    targetIds,
    targetCount: targetIds.length,
    changes: params.changes,
    ...params.extra,
  };

  const base = params.message ?? `Updated ${params.targetEntity}`;
  let message = base;
  if (params.changes.length === 1) {
    message = `${base}: ${summarizeFieldChange(params.changes[0])}`;
  } else if (params.changes.length > 1) {
    const fields = Array.from(new Set(params.changes.map((c) => c.field)));
    const idSummary = summarizeIds(targetIds);
    message = `${base} (${targetIds.length} ${params.targetEntity}, IDs: ${idSummary}; fields: ${fields.join(', ')})`;
  }
  logger.info(message, context);
}

export function logDeleteAuditDetails(params: {
  endpoint: string;
  userId?: string | null;
  requestId?: string;
  targetEntity: string;
  requestedIds?: Array<AuditId>;
  deletedRows: Array<DeletedRow>;
  message?: string;
  extra?: LogContext;
}): void {
  const requestedIds = params.requestedIds ?? [];
  const deletedIds = params.deletedRows.map((row) => row.id);
  const deletedIdSet = new Set(deletedIds);
  const notFoundIds = requestedIds.filter((id) => !deletedIdSet.has(id));

  const context: LogContext = {
    category: 'delete',
    endpoint: params.endpoint,
    method: 'DELETE',
    userId: params.userId ?? null,
    requestId: params.requestId,
    changeType: 'delete',
    targetEntity: params.targetEntity,
    targetIds: deletedIds,
    targetCount: deletedIds.length,
    deletedRows: params.deletedRows,
    requestedIds,
    notFoundIds,
    ...params.extra,
  };

  const base = params.message ?? `Deleted ${params.targetEntity}`;
  let message = base;
  if (params.deletedRows.length === 1) {
    message = `${base}: ${formatRowLabel(params.deletedRows[0])}`;
  } else if (params.deletedRows.length > 1) {
    message = `${base} (${params.deletedRows.length}): ${summarizeRows(params.deletedRows)}`;
  }
  if (notFoundIds.length > 0) {
    message += ` [not found: ${summarizeIds(notFoundIds)}]`;
  }
  logger.info(message, context);
}

export function logAddAuditDetails(params: {
  endpoint: string;
  method?: string;
  userId?: string | null;
  requestId?: string;
  targetEntity: string;
  createdRows: Array<CreatedRow>;
  message?: string;
  extra?: LogContext;
}): void {
  const targetIds = params.createdRows.map((row) => row.id);
  const context: LogContext = {
    category: 'mutation',
    endpoint: params.endpoint,
    method: params.method ?? 'POST',
    userId: params.userId ?? null,
    requestId: params.requestId,
    changeType: 'add',
    targetEntity: params.targetEntity,
    targetIds,
    targetCount: targetIds.length,
    createdRows: params.createdRows,
    ...params.extra,
  };

  const base = params.message ?? `Created ${params.targetEntity}`;
  let message = base;
  if (params.createdRows.length === 1) {
    message = `${base}: ${formatRowLabel(params.createdRows[0])}`;
  } else if (params.createdRows.length > 1) {
    message = `${base} (${params.createdRows.length}): ${summarizeRows(params.createdRows)}`;
  }
  logger.info(message, context);
}
