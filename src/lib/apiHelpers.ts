import { NextRequest, NextResponse } from 'next/server';
import { getRequestId } from './requestId';
import { resolveAuditUserId } from './auditTrail';
import { handleApiError, createErrorResponse } from './errorHandler';
import { logger, categoryFromRequest } from './logger';
import type { LogContext } from './logger';
import { SESSION_COOKIE_NAME } from './authConstants';

export type ApiHandlerContext = {
  requestId: string;
  userId: string | null;
  userName: string | null;
  endpoint: string;
  method: string;
};

type CookieStore = {
  get(name: string): { value?: string } | undefined;
};

function resolveSessionUserName(cookies?: CookieStore): string | null {
  if (!cookies || typeof cookies.get !== 'function') return null;
  try {
    const raw = cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
    if (!raw) return null;
    const [encoded] = raw.split('.', 2);
    if (!encoded) return null;
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as { win?: string };
    return decoded?.win ?? null;
  } catch {
    return null;
  }
}

export async function createApiContext(
  req: NextRequest,
  endpoint: string,
  method: string = req.method,
): Promise<ApiHandlerContext> {
  return {
    requestId: await getRequestId(req),
    userId: resolveAuditUserId(req),
    userName: resolveSessionUserName(req.cookies),
    endpoint,
    method,
  };
}

const MAX_AUDIT_IDS = 25;
const MAX_AUDIT_FIELDS = 25;
const MAX_AUDIT_CHANGE_ITEMS = 50;

const ACTION_SEGMENTS = new Set([
  'add',
  'create',
  'duplicate',
  'edit',
  'grid',
  'import',
  'lookups',
  'paste',
  'requested',
  'requests',
  'resolve',
  'summary',
  'update',
]);

const NON_FIELD_KEYS = new Set([
  'field',
  'fields',
  'filtermodel',
  'groupkeys',
  'ids',
  'request',
  'rowgroupcols',
  'sortmodel',
  'updates',
  'value',
]);

const ID_KEY_PATTERN = /(^|_)(id|ids)$/i;
const SENSITIVE_KEY_PATTERN = /(password|token|secret|cookie|authorization|auth)/i;

type ChangeType = 'add' | 'edit' | 'delete' | 'mutation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeScalarId(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
  }
  return null;
}

function collectIds(node: unknown, ids: Set<number | string>, keyHint = ''): void {
  if (ids.size >= MAX_AUDIT_IDS) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectIds(item, ids, keyHint);
      if (ids.size >= MAX_AUDIT_IDS) break;
    }
    return;
  }
  if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      collectIds(value, ids, key);
      if (ids.size >= MAX_AUDIT_IDS) break;
    }
    return;
  }
  if (!ID_KEY_PATTERN.test(keyHint)) return;
  const normalized = normalizeScalarId(node);
  if (normalized != null) ids.add(normalized);
}

function collectChangedFields(body: unknown, method: string): string[] {
  const fields = new Set<string>();
  if (!isRecord(body)) return [];

  const directField = body.field;
  if (typeof directField === 'string' && directField.trim()) {
    fields.add(directField.trim());
  }

  const updates = body.updates;
  if (Array.isArray(updates)) {
    for (const item of updates) {
      if (!isRecord(item)) continue;
      const updateField = item.field;
      if (typeof updateField === 'string' && updateField.trim()) {
        fields.add(updateField.trim());
      } else {
        for (const key of Object.keys(item)) {
          const normalizedKey = key.trim();
          if (!normalizedKey || ID_KEY_PATTERN.test(normalizedKey)) continue;
          fields.add(normalizedKey);
          if (fields.size >= MAX_AUDIT_FIELDS) break;
        }
      }
      if (fields.size >= MAX_AUDIT_FIELDS) break;
    }
  }

  const upperMethod = method.toUpperCase();
  if ((upperMethod === 'PATCH' || upperMethod === 'PUT') && fields.size === 0) {
    for (const key of Object.keys(body)) {
      const normalizedKey = key.trim();
      if (!normalizedKey || NON_FIELD_KEYS.has(normalizedKey.toLowerCase()) || ID_KEY_PATTERN.test(normalizedKey)) {
        continue;
      }
      fields.add(normalizedKey);
      if (fields.size >= MAX_AUDIT_FIELDS) break;
    }
  }

  return Array.from(fields).slice(0, MAX_AUDIT_FIELDS);
}

function estimateChangeCount(body: unknown, ids: Array<number | string>): number | undefined {
  if (Array.isArray(body)) return body.length;
  if (isRecord(body)) {
    if (Array.isArray(body.updates)) return body.updates.length;
    for (const [key, value] of Object.entries(body)) {
      if (ID_KEY_PATTERN.test(key) && Array.isArray(value)) return value.length;
    }
  }
  if (ids.length > 0) return ids.length;
  return undefined;
}

function inferChangeType(method: string, endpoint: string, body: unknown): ChangeType {
  const upperMethod = method.toUpperCase();
  if (upperMethod === 'DELETE') return 'delete';
  if (upperMethod === 'PATCH' || upperMethod === 'PUT') return 'edit';
  if (upperMethod !== 'POST') return 'mutation';

  if (/\/(create|add|duplicate|import)(\/|$)/i.test(endpoint)) return 'add';
  if (/\/(update|edit|paste|status-history)(\/|$)/i.test(endpoint)) return 'edit';
  if (isRecord(body) && (Array.isArray(body.updates) || typeof body.field === 'string')) return 'edit';
  return 'add';
}

function resolveTargetEntity(endpoint: string): string | undefined {
  const path = endpoint.split('?', 1)[0];
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2 || parts[0] !== 'api') return undefined;
  const candidates = parts
    .slice(1)
    .filter((segment) => !ID_KEY_PATTERN.test(segment))
    .filter((segment) => !segment.startsWith('[') && !segment.endsWith(']'))
    .filter((segment) => !ACTION_SEGMENTS.has(segment.toLowerCase()))
    .filter((segment) => !/^\d+$/.test(segment));
  if (candidates.length === 0) return parts[1];
  return candidates[candidates.length - 1];
}

function toPreviewValue(value: unknown): string | number | boolean | null | undefined {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  return undefined;
}

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  const scalar = toPreviewValue(value);
  if (scalar !== undefined) return scalar;
  if (depth >= 2) return '[complex]';

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => sanitizeAuditValue(entry, depth + 1));
  }

  if (isRecord(value)) {
    const preview: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (Object.keys(preview).length >= 8) break;
      if (!key || SENSITIVE_KEY_PATTERN.test(key)) continue;
      preview[key] = sanitizeAuditValue(nested, depth + 1);
    }
    return preview;
  }

  return String(value);
}

function extractIdsFromRecord(record: Record<string, unknown>): Array<number | string> {
  const ids: Array<number | string> = [];
  for (const [key, value] of Object.entries(record)) {
    if (!ID_KEY_PATTERN.test(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = normalizeScalarId(item);
        if (normalized != null) ids.push(normalized);
      }
      continue;
    }
    const normalized = normalizeScalarId(value);
    if (normalized != null) ids.push(normalized);
  }
  return ids;
}

function collectRequestedDeletes(body: unknown): Array<number | string> {
  if (!isRecord(body)) return [];
  const result = new Set<number | string>();
  for (const [key, value] of Object.entries(body)) {
    if (!ID_KEY_PATTERN.test(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = normalizeScalarId(item);
        if (normalized != null) result.add(normalized);
        if (result.size >= MAX_AUDIT_IDS) break;
      }
      continue;
    }
    const normalized = normalizeScalarId(value);
    if (normalized != null) result.add(normalized);
  }
  return Array.from(result).slice(0, MAX_AUDIT_IDS);
}

function collectRequestedChanges(body: unknown): Array<Record<string, unknown>> {
  const changes: Array<Record<string, unknown>> = [];
  if (!isRecord(body)) return changes;

  const pushChange = (entry: Record<string, unknown>) => {
    if (changes.length >= MAX_AUDIT_CHANGE_ITEMS) return;
    changes.push(entry);
  };

  if (Array.isArray(body.updates)) {
    for (const item of body.updates) {
      if (!isRecord(item)) continue;
      const itemIds = extractIdsFromRecord(item);
      const fieldValue = typeof item.field === 'string' ? item.field.trim() : '';
      const rawValue = Object.prototype.hasOwnProperty.call(item, 'value')
        ? item.value
        : (fieldValue && Object.prototype.hasOwnProperty.call(item, fieldValue) ? item[fieldValue] : undefined);

      const change: Record<string, unknown> = {};
      if (itemIds.length > 0) change.targetId = itemIds[0];
      if (fieldValue) change.field = fieldValue;
      if (rawValue !== undefined) change.newValue = sanitizeAuditValue(rawValue);
      if (Object.keys(change).length === 0) {
        change.update = sanitizeAuditValue(item);
      }
      pushChange(change);
      if (changes.length >= MAX_AUDIT_CHANGE_ITEMS) break;
    }
  }

  const directField = typeof body.field === 'string' ? body.field.trim() : '';
  if (directField) {
    const directIds = extractIdsFromRecord(body);
    const directChange: Record<string, unknown> = {
      field: directField,
      newValue: sanitizeAuditValue(body.value),
    };
    if (directIds.length > 0) directChange.targetId = directIds[0];
    pushChange(directChange);
  }

  return changes;
}

function buildPayloadPreview(body: unknown): Record<string, string | number | boolean | null> | undefined {
  const source = isRecord(body)
    ? body
    : Array.isArray(body) && body.length > 0 && isRecord(body[0])
      ? body[0]
      : null;
  if (!source) return undefined;

  const preview: Record<string, string | number | boolean | null> = {};
  for (const [key, rawValue] of Object.entries(source)) {
    if (Object.keys(preview).length >= 12) break;
    if (!key || SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (NON_FIELD_KEYS.has(key.toLowerCase())) continue;
    const value = toPreviewValue(rawValue);
    if (value !== undefined) {
      preview[key] = value;
    }
  }

  return Object.keys(preview).length > 0 ? preview : undefined;
}

async function summarizeMutationRequest(
  request: Request,
  method: string,
  endpoint: string,
): Promise<LogContext> {
  const body = await request.json().catch(() => null);
  const idsSet = new Set<number | string>();
  collectIds(body, idsSet);
  const ids = Array.from(idsSet).slice(0, MAX_AUDIT_IDS);
  const changedFields = collectChangedFields(body, method);
  const payloadKeys = isRecord(body) ? Object.keys(body).slice(0, MAX_AUDIT_FIELDS) : undefined;
  const changeCount = estimateChangeCount(body, ids);
  const payloadPreview = buildPayloadPreview(body);
  const changeType = inferChangeType(method, endpoint, body);
  const requestedChanges = changeType === 'edit' ? collectRequestedChanges(body) : [];
  const requestedDeletes = changeType === 'delete' ? collectRequestedDeletes(body) : [];

  const details: LogContext = {
    changeType,
    targetEntity: resolveTargetEntity(endpoint),
  };
  if (ids.length > 0) {
    details.targetIds = ids;
    details.targetCount = changeCount ?? ids.length;
  } else if (changeCount != null) {
    details.targetCount = changeCount;
  }
  if (changedFields.length > 0) details.changedFields = changedFields;
  if (payloadKeys && payloadKeys.length > 0) details.payloadKeys = payloadKeys;
  if (payloadPreview) details.payloadPreview = payloadPreview;
  if (requestedChanges.length > 0) details.requestedChanges = requestedChanges;
  if (requestedDeletes.length > 0) {
    details.requestedIds = requestedDeletes;
    if (!details.targetIds) {
      details.targetIds = requestedDeletes;
      details.targetCount = requestedDeletes.length;
    }
  }
  return details;
}

function buildDescriptiveMessage(method: string, endpoint: string, details?: LogContext): string {
  const path = endpoint.split('?')[0];
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== 'api') return `${method} ${endpoint}`;

  const actionWord = details?.changeType
    ? String(details.changeType)
    : method.toUpperCase() === 'GET' ? 'view'
      : method.toUpperCase() === 'DELETE' ? 'delete'
        : method.toUpperCase() === 'PATCH' || method.toUpperCase() === 'PUT' ? 'edit'
          : 'view';

  const action = actionWord.charAt(0).toUpperCase() + actionWord.slice(1);

  const entityParts: string[] = [];
  const ids: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (/^\d+$/.test(seg)) {
      ids.push(seg);
    } else if (!ACTION_SEGMENTS.has(seg.toLowerCase())) {
      entityParts.push(seg);
    }
  }

  const entity = entityParts.join(' ') || 'resource';
  const idStr = ids.length > 0 ? ` #${ids.join('/')}` : '';
  let msg = `${action} ${entity}${idStr}`;

  if (details?.changedFields && Array.isArray(details.changedFields)) {
    const fields = details.changedFields as string[];
    if (fields.length > 0) {
      msg += `: ${fields.slice(0, 5).join(', ')}`;
    }
  }

  if (details?.requestedChanges && Array.isArray(details.requestedChanges)) {
    const changes = details.requestedChanges as Array<Record<string, unknown>>;
    const parts: string[] = [];
    for (const change of changes.slice(0, 3)) {
      if (change.field != null && change.newValue !== undefined) {
        parts.push(`${change.field} → ${change.newValue}`);
      }
    }
    if (parts.length > 0) {
      msg += ` (${parts.join(', ')})`;
    }
  }

  if (details?.requestedIds && Array.isArray(details.requestedIds)) {
    const delIds = details.requestedIds as Array<number | string>;
    if (delIds.length > 0) {
      msg += ` [IDs: ${delIds.slice(0, 10).join(', ')}]`;
    }
  }

  return msg;
}

export function logRequest(req: NextRequest, endpoint: string): void {
  const requestPath = req.nextUrl?.pathname || endpoint;
  const category = categoryFromRequest(req.method, requestPath);
  const baseContext: LogContext = {
    endpoint: requestPath,
    method: req.method,
    userId: resolveAuditUserId(req),
    userName: resolveSessionUserName(req.cookies),
    category,
  };
  if (requestPath !== endpoint) {
    baseContext.endpointTemplate = endpoint;
  }

  if (category === 'view') {
    return;
  }

  // Skip body inspection for multipart uploads: the body is binary (e.g. an
  // Excel file), not JSON, and reading it via a clone races with the route
  // handler's own req.formData() call on the teed stream — causing the
  // multipart parser to fail with "Failed to parse body as FormData."
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    logger.info(buildDescriptiveMessage(req.method, requestPath), baseContext);
    return;
  }

  let requestForAudit: Request;
  try {
    requestForAudit = req.clone();
  } catch {
    logger.info(buildDescriptiveMessage(req.method, requestPath), baseContext);
    return;
  }

  void summarizeMutationRequest(requestForAudit, req.method, requestPath)
    .then((details) => {
      logger.info(buildDescriptiveMessage(req.method, requestPath, details), {
        ...baseContext,
        ...details,
      });
    })
    .catch(() => {
      logger.info(buildDescriptiveMessage(req.method, requestPath), baseContext);
    });
}

export function logApiRequest(context: ApiHandlerContext, message?: string): void {
  logger.info(message || buildDescriptiveMessage(context.method, context.endpoint), {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
    userName: context.userName,
    category: categoryFromRequest(context.method, context.endpoint),
  });
}

export function logApiSuccess(context: ApiHandlerContext, message?: string, extra?: LogContext): void {
  logger.info(message || buildDescriptiveMessage(context.method, context.endpoint, extra), {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
    userName: context.userName,
    category: categoryFromRequest(context.method, context.endpoint),
    ...extra,
  });
}

export async function handleApiErrorResponse(
  error: unknown,
  context: ApiHandlerContext,
): Promise<NextResponse> {
  return await handleApiError(error, {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
  });
}

export async function createErrorResponseWithContext(
  message: string,
  status: number,
  context: ApiHandlerContext,
): Promise<NextResponse> {
  return await createErrorResponse(message, status, {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
  });
}
