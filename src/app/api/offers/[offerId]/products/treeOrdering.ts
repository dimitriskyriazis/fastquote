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
  path: number[];
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

export const parseTreeOrderingPath = (value: unknown): number[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
};

export const formatTreeOrderingPath = (path: number[]): string => path.join('.');

export const comparePaths = (a: number[], b: number[]) => {
  const max = Math.max(a.length, b.length);
  for (let idx = 0; idx < max; idx += 1) {
    const hasA = idx < a.length;
    const hasB = idx < b.length;
    if (!hasA && !hasB) return 0;
    if (!hasA) return -1;
    if (!hasB) return 1;
    const diff = a[idx] - b[idx];
    if (diff !== 0) return diff;
  }
  return 0;
};

export const pathsEqual = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false;
  for (let idx = 0; idx < a.length; idx += 1) {
    if (a[idx] !== b[idx]) return false;
  }
  return true;
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

export const collectResequencedUpdates = (roots: TreeOrderingNode[]): TreeOrderingUpdateInput[] => {
  const updates: TreeOrderingUpdateInput[] = [];
  const assign = (nodes: TreeOrderingNode[], parentPath: number[]) => {
    nodes.forEach((node, idx) => {
      const nextPath = [...parentPath, idx + 1];
      if (!pathsEqual(node.path, nextPath)) {
        updates.push({ OfferDetailID: node.id, TreeOrdering: formatTreeOrderingPath(nextPath) });
      }
      if (node.children.length > 0) {
        assign(node.children, nextPath);
      }
    });
  };
  assign(roots, []);
  return updates;
};
