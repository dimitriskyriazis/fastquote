'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Auto-saves dirty form fields after a period of inactivity (default 3 s).
 * Also flushes all dirty fields on `beforeunload` so closing the tab
 * doesn't lose in-progress edits.
 *
 * Usage:
 *   const { scheduleAutoSave, cancelAutoSave } = useAutoSaveTimer({ ... });
 *   // call scheduleAutoSave(fieldId) inside handleValueChange
 *   // call cancelAutoSave(fieldId)  inside handleBlur (blur already saves)
 */

type FieldLike = { id: string; updateField?: string };

export function useAutoSaveTimer<T extends FieldLike>({
  values,
  savedValuesRef,
  fieldDefinitions,
  saveField,
  delay = 3000,
}: {
  values: Record<string, string>;
  savedValuesRef: React.RefObject<Record<string, string>>;
  fieldDefinitions: T[];
  saveField: (def: T, value: string) => void;
  delay?: number;
}) {
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const valuesRef = useRef(values);
  const fieldDefsRef = useRef(fieldDefinitions);
  const saveFieldRef = useRef(saveField);

  useEffect(() => {
    valuesRef.current = values;
    fieldDefsRef.current = fieldDefinitions;
    saveFieldRef.current = saveField;
  });

  const cancelAutoSave = useCallback((fieldId: string) => {
    if (timersRef.current[fieldId]) {
      clearTimeout(timersRef.current[fieldId]);
      delete timersRef.current[fieldId];
    }
  }, []);

  const scheduleAutoSave = useCallback(
    (fieldId: string) => {
      cancelAutoSave(fieldId);
      timersRef.current[fieldId] = setTimeout(() => {
        delete timersRef.current[fieldId];
        const currentValue = valuesRef.current[fieldId] ?? '';
        if (currentValue === savedValuesRef.current[fieldId]) return;
        const def = fieldDefsRef.current.find((d) => d.id === fieldId);
        if (!def?.updateField) return;
        saveFieldRef.current(def, currentValue);
      }, delay);
    },
    [cancelAutoSave, delay, savedValuesRef],
  );

  // Flush all dirty fields on beforeunload (tab/window close)
  useEffect(() => {
    const flush = () => {
      for (const id of Object.keys(timersRef.current)) {
        clearTimeout(timersRef.current[id]);
        delete timersRef.current[id];
      }
      for (const def of fieldDefsRef.current) {
        if (!def.updateField) continue;
        const cur = valuesRef.current[def.id] ?? '';
        if (cur !== savedValuesRef.current[def.id]) {
          saveFieldRef.current(def, cur);
        }
      }
    };

    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [savedValuesRef]);

  // Cleanup timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id of Object.keys(timers)) {
        clearTimeout(timers[id]);
      }
    };
  }, []);

  return { scheduleAutoSave, cancelAutoSave };
}
