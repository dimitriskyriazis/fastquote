'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { showToastMessage } from '../../lib/toast';

export type UndoEntry = {
  label: string;
  undo: () => Promise<void>;
  /**
   * Re-applies the change after it was undone. Absent => the entry is not redoable
   * (e.g. operations whose forward action isn't captured yet); such entries are
   * dropped rather than placed on the redo stack when undone.
   */
  redo?: () => Promise<void>;
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

export type PushUndoEntry = {
  label: string;
  undo: () => Promise<void>;
  redo?: () => Promise<void>;
  groupToken?: string | number;
};

/**
 * Composes two optional async reverts into one that runs both (settling each so a
 * failure in one still attempts the other) and surfaces a failure if either rejects.
 * Returns undefined when neither side has a revert, so a coalesced entry stays
 * non-redoable until at least one of its members is redoable.
 */
function composeReverts(
  first: (() => Promise<void>) | undefined,
  second: (() => Promise<void>) | undefined,
  errorMessage: string,
): (() => Promise<void>) | undefined {
  if (!first && !second) return undefined;
  return async () => {
    const results = await Promise.allSettled([first?.(), second?.()]);
    if (results.some((r) => r.status === 'rejected')) {
      throw new Error(errorMessage);
    }
  };
}

/**
 * Pure reducer for pushUndo: returns the next stack after adding `entry`.
 *
 * When `entry.groupToken` matches the top entry's token, the two coalesce into a
 * single composite entry whose `undo` (and `redo`) reverts/re-applies both. This is
 * what makes one Ctrl+Z revert an entire multi-cell paste: each pasted cell saves
 * and pushes its undo asynchronously (and so out of visual order), but a shared
 * token folds them into one step. The composite reuses each edit's own closures, so
 * it stays correct for any field. Extracted as a pure function so the merge logic is
 * unit-testable.
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
      // Re-apply in the same all-or-surface-failure manner. Stays undefined until a
      // member carries a redo, so a partially-redoable batch is still redoable.
      redo: composeReverts(top.redo, entry.redo, 'Failed to re-apply part of the paste'),
    };
    return [...stack.slice(0, -1), merged];
  }
  return [...stack.slice(-(maxSize - 1)), { ...entry, timestamp: now }];
}

export function useUndoStack(maxSize = 20) {
  const [stack, setStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);
  const stackRef = useRef(stack);
  const redoStackRef = useRef(redoStack);
  // Guards against re-entrancy: while an undo/redo is running, the programmatic
  // grid writes it performs must not push new entries or trigger a nested undo.
  const busyRef = useRef(false);

  const setUndo = useCallback((next: UndoEntry[]) => {
    stackRef.current = next;
    setStack(next);
  }, []);
  const setRedo = useCallback((next: UndoEntry[]) => {
    redoStackRef.current = next;
    setRedoStack(next);
  }, []);

  const pushUndo = useCallback(
    (entry: PushUndoEntry) => {
      if (busyRef.current) return; // suppress entries triggered by undo/redo side-effects
      setUndo(appendUndoEntry(stackRef.current, entry, maxSize, Date.now()));
      // A fresh edit invalidates the redo history (standard linear undo/redo model).
      if (redoStackRef.current.length > 0) setRedo([]);
    },
    [maxSize, setUndo, setRedo],
  );

  const performUndo = useCallback(async () => {
    if (busyRef.current) return;
    const last = stackRef.current.at(-1);
    if (!last) return;
    busyRef.current = true;
    try {
      await last.undo();
      // Only mutate the stacks on success, so a failed/partial revert leaves the
      // entry in place and the user can retry instead of losing it forever.
      setUndo(stackRef.current.slice(0, -1));
      if (last.redo) setRedo([...redoStackRef.current, last].slice(-maxSize));
      showToastMessage(`${last.label} - reverted`, 'info');
    } catch {
      showToastMessage(`Unable to revert: ${last.label}`, 'error');
    } finally {
      busyRef.current = false;
    }
  }, [maxSize, setUndo, setRedo]);

  const performRedo = useCallback(async () => {
    if (busyRef.current) return;
    const last = redoStackRef.current.at(-1);
    if (!last || !last.redo) return;
    busyRef.current = true;
    try {
      await last.redo();
      setRedo(redoStackRef.current.slice(0, -1));
      setUndo([...stackRef.current, last].slice(-maxSize));
      showToastMessage(`${last.label} - reapplied`, 'info');
    } catch {
      showToastMessage(`Unable to redo: ${last.label}`, 'error');
    } finally {
      busyRef.current = false;
    }
  }, [maxSize, setUndo, setRedo]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      // Redo: Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z. Undo: Ctrl/Cmd+Z.
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
      const isUndo = key === 'z' && !e.shiftKey;
      if (isRedo) {
        if (redoStackRef.current.length > 0) {
          e.preventDefault();
          void performRedo();
        }
      } else if (isUndo) {
        if (stackRef.current.length > 0) {
          e.preventDefault();
          void performUndo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [performUndo, performRedo]);

  return {
    pushUndo,
    performUndo,
    performRedo,
    canUndo: stack.length > 0,
    canRedo: redoStack.length > 0,
    lastLabel: stack.at(-1)?.label,
    lastRedoLabel: redoStack.at(-1)?.label,
  };
}
