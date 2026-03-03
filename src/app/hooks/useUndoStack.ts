'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { showToastMessage } from '../../lib/toast';

export type UndoEntry = {
  label: string;
  undo: () => Promise<void>;
  timestamp: number;
};

export function useUndoStack(maxSize = 20) {
  const [stack, setStack] = useState<UndoEntry[]>([]);
  const stackRef = useRef(stack);
  useEffect(() => {
    stackRef.current = stack;
  }, [stack]);

  const pushUndo = useCallback(
    (entry: Omit<UndoEntry, 'timestamp'>) => {
      setStack((prev) => [
        ...prev.slice(-(maxSize - 1)),
        { ...entry, timestamp: Date.now() },
      ]);
    },
    [maxSize],
  );

  const performUndo = useCallback(async () => {
    const current = stackRef.current;
    const last = current.at(-1);
    if (!last) return;
    setStack((prev) => prev.slice(0, -1));
    try {
      await last.undo();
      showToastMessage(`${last.label} — reverted`, 'info');
    } catch {
      showToastMessage(`Unable to revert: ${last.label}`, 'error');
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
