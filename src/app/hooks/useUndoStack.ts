'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { showToastMessage } from '../../lib/toast';

export type UndoEntry = {
  label: string;
  undo: () => Promise<void>;
  timestamp: number;
  /**
   * Edits sharing a groupToken coalesce into a single undo step — e.g. every
   * cell of one clipboard paste, which each save (and so push an undo entry)
   * asynchronously and out of visual order. With a shared token a single Ctrl+Z
   * reverts the whole batch instead of one race-determined row.
   */
  groupToken?: string | number;
  /** Number of edits merged into this entry (1 unless coalesced). */
  count?: number;
  /** Original single-edit label, kept so the coalesced label can be recomputed. */
  baseLabel?: string;
};

export type PushUndoEntry = { label: string; undo: () => Promise<void>; groupToken?: string | number };

/**
 * Pure reducer for pushUndo: returns the next stack after adding `entry`.
 *
 * When `entry.groupToken` matches the top entry's token, the two coalesce into a
 * single composite entry whose `undo` reverts both. This is what makes one Ctrl+Z
 * revert an entire multi-cell paste: each pasted cell saves and pushes its undo
 * asynchronously (and so out of visual order), but a shared token folds them into
 * one step. The composite reuses each edit's own revert closure, so it stays correct
 * for any field. Extracted as a pure function so the merge logic is unit-testable.
 */
export function appendUndoEntry(
  stack: UndoEntry[],
  entry: PushUndoEntry,
  maxSize: number,
  now: number,
): UndoEntry[] {
  const { groupToken } = entry;
  const top = stack.at(-1);
  if (groupToken != null && top && top.groupToken === groupToken) {
    const mergedCount = (top.count ?? 1) + 1;
    const baseLabel = top.baseLabel ?? top.label;
    const prevUndo = top.undo;
    const nextUndo = entry.undo;
    const merged: UndoEntry = {
      label: `${baseLabel} (${mergedCount} cells)`,
      baseLabel,
      groupToken,
      count: mergedCount,
      timestamp: now,
      undo: async () => {
        // Revert every cell even if one fails, then surface a failure.
        const results = await Promise.allSettled([nextUndo(), prevUndo()]);
        if (results.some((r) => r.status === 'rejected')) {
          throw new Error('Failed to revert part of the paste');
        }
      },
    };
    return [...stack.slice(0, -1), merged];
  }
  return [...stack.slice(-(maxSize - 1)), { ...entry, timestamp: now }];
}

export function useUndoStack(maxSize = 20) {
  const [stack, setStack] = useState<UndoEntry[]>([]);
  const stackRef = useRef(stack);
  const undoingRef = useRef(false);

  const pushUndo = useCallback(
    (entry: PushUndoEntry) => {
      if (undoingRef.current) return; // suppress entries triggered by undo side-effects
      const next = appendUndoEntry(stackRef.current, entry, maxSize, Date.now());
      stackRef.current = next;
      setStack(next);
    },
    [maxSize],
  );

  const performUndo = useCallback(async () => {
    if (undoingRef.current) return;
    const current = stackRef.current;
    const last = current.at(-1);
    if (!last) return;
    undoingRef.current = true;
    const next = current.slice(0, -1);
    stackRef.current = next;
    setStack(next);
    try {
      await last.undo();
      showToastMessage(`${last.label} — reverted`, 'info');
    } catch {
      showToastMessage(`Unable to revert: ${last.label}`, 'error');
    } finally {
      undoingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (stackRef.current.length > 0) {
          e.preventDefault();
          performUndo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [performUndo]);

  return {
    pushUndo,
    performUndo,
    canUndo: stack.length > 0,
    lastLabel: stack.at(-1)?.label,
  };
}
