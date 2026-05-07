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

const buildSegmentList = (
  nodes: TreeOrderingNode[],
  depth: number,
  forceRenumber: boolean,
  rootStart: number,
): string[] => {
  // With forceRenumber, assign sequentially so gaps (e.g. from a deletion)
  // close up. At root level we count up from `rootStart` so a user-applied
  // "Starting Item No" survives unrelated edits like deletes; sub-levels
  // always count from 1.
  // Otherwise preserve each node's existing segment unless the sibling group
  // carries a renumber sentinel: reorder/insert flag rows rewrite their last
  // segment to "0", so bespoke numbering like a root "6" survives.
  if (forceRenumber) {
    const start = depth === 0 ? rootStart : 1;
    return nodes.map((_, idx) => String(idx + start));
  }
  const existing = nodes.map((n) => (n.path.length > depth ? n.path[depth] : '0'));
  const hasSentinel = existing.some((seg) => seg === '0' || seg === '');
  if (!hasSentinel) return existing;
  const start = depth === 0 ? rootStart : 1;
  return nodes.map((_, idx) => String(idx + start));
};

const computeRootStart = (roots: TreeOrderingNode[]): number => {
  let min: number | null = null;
  for (const root of roots) {
    if (root.id === VIRTUAL_NODE_ID) continue;
    const seg = root.path[0];
    const parsed = Number(seg);
    if (!Number.isFinite(parsed) || parsed < 1) continue;
    if (min == null || parsed < min) min = parsed;
  }
  return min ?? 1;
};

export const collectResequencedUpdates = (
  roots: TreeOrderingNode[],
  options: { forceRenumber?: boolean } = {},
): TreeOrderingUpdateInput[] => {
  const forceRenumber = options.forceRenumber === true;
  const rootStart = computeRootStart(roots);
  const updates: TreeOrderingUpdateInput[] = [];
  const assign = (nodes: TreeOrderingNode[], parentPath: string[]) => {
    const segments = buildSegmentList(nodes, parentPath.length, forceRenumber, rootStart);
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
