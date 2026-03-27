export type TreeOrderingRow = {
  OfferDetailID: number;
  TreeOrdering: string | null;
};

export type TreeOrderingUpdateInput = {
  OfferDetailID: number;
  TreeOrdering: string | null;
};

export type TreeOrderingNode = {
  id: number;
  path: string[];
  children: TreeOrderingNode[];
  parent: TreeOrderingNode | null;
};

export const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export const normalizeTreeOrderingValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const parseTreeOrderingPath = (value: unknown): string[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
};

export const formatTreeOrderingPath = (path: string[]): string => path.join('.');

const compareSegments = (a: string, b: string): number => {
  const numA = Number(a);
  const numB = Number(b);
  const aIsNum = Number.isFinite(numA);
  const bIsNum = Number.isFinite(numB);
  if (aIsNum && bIsNum) return numA - numB;
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return a.localeCompare(b);
};

export const comparePaths = (a: string[], b: string[]) => {
  const max = Math.max(a.length, b.length);
  for (let idx = 0; idx < max; idx += 1) {
    const hasA = idx < a.length;
    const hasB = idx < b.length;
    if (!hasA && !hasB) return 0;
    if (!hasA) return -1;
    if (!hasB) return 1;
    const diff = compareSegments(a[idx], b[idx]);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const pathsEqual = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  for (let idx = 0; idx < a.length; idx += 1) {
    if (a[idx] !== b[idx]) return false;
  }
  return true;
};

const VIRTUAL_NODE_ID = -1;

const ensureAncestors = (
  path: string[],
  byPath: Map<string, TreeOrderingNode>,
  roots: TreeOrderingNode[],
) => {
  for (let depth = 1; depth < path.length; depth += 1) {
    const ancestorPath = path.slice(0, depth);
    const key = formatTreeOrderingPath(ancestorPath);
    if (byPath.has(key)) continue;
    const virtual: TreeOrderingNode = {
      id: VIRTUAL_NODE_ID,
      path: ancestorPath,
      children: [],
      parent: null,
    };
    byPath.set(key, virtual);
    const parentPath = ancestorPath.slice(0, -1);
    if (parentPath.length === 0) {
      roots.push(virtual);
    } else {
      const parentKey = formatTreeOrderingPath(parentPath);
      const parent = byPath.get(parentKey);
      if (parent) {
        virtual.parent = parent;
        parent.children.push(virtual);
      } else {
        roots.push(virtual);
      }
    }
  }
};

export const buildTreeFromRows = (rows: TreeOrderingRow[]): TreeOrderingNode[] => {
  const nodes: TreeOrderingNode[] = rows
    .map((row) => ({
      id: row.OfferDetailID,
      path: parseTreeOrderingPath(normalizeTreeOrderingValue(row.TreeOrdering)),
      children: [],
      parent: null,
    }))
    .filter((node) => Number.isInteger(node.id) && node.path.length > 0);

  const byPath = new Map<string, TreeOrderingNode>();
  nodes.forEach((node) => {
    const key = formatTreeOrderingPath(node.path);
    if (!byPath.has(key)) {
      byPath.set(key, node);
    }
  });

  const roots: TreeOrderingNode[] = [];

  nodes.forEach((node) => {
    ensureAncestors(node.path, byPath, roots);
  });

  nodes.forEach((node) => {
    const parentPath = node.path.slice(0, -1);
    if (parentPath.length === 0) {
      roots.push(node);
      return;
    }
    const parentKey = formatTreeOrderingPath(parentPath);
    const parent = byPath.get(parentKey);
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  const sortTree = (entries: TreeOrderingNode[]) => {
    entries.sort((a, b) => comparePaths(a.path, b.path));
    entries.forEach((entry) => sortTree(entry.children));
  };
  sortTree(roots);

  return roots;
};

const buildSegmentList = (nodes: TreeOrderingNode[]): string[] => {
  // Preserve existing segment numbers when they're already in ascending order.
  // Only assign new numbers for nodes that are out of order or would collide.
  // This avoids renumbering the entire tree when adding/moving a single item.
  const result: string[] = [];
  let lastUsed = 0;
  for (const node of nodes) {
    const existing = node.path.length > 0
      ? Number.parseInt(node.path[node.path.length - 1], 10)
      : NaN;
    if (Number.isFinite(existing) && existing > lastUsed) {
      result.push(String(existing));
      lastUsed = existing;
    } else {
      lastUsed += 1;
      result.push(String(lastUsed));
    }
  }
  return result;
};

export const collectResequencedUpdates = (roots: TreeOrderingNode[]): TreeOrderingUpdateInput[] => {
  const updates: TreeOrderingUpdateInput[] = [];
  const assign = (nodes: TreeOrderingNode[], parentPath: string[]) => {
    const segments = buildSegmentList(nodes);
    nodes.forEach((node, idx) => {
      const nextPath = [...parentPath, segments[idx]];
      if (node.id !== VIRTUAL_NODE_ID && !pathsEqual(node.path, nextPath)) {
        updates.push({ OfferDetailID: node.id, TreeOrdering: formatTreeOrderingPath(nextPath) });
      }
      node.path = nextPath;
      if (node.children.length > 0) {
        assign(node.children, nextPath);
      }
    });
  };
  assign(roots, []);
  return updates;
};
