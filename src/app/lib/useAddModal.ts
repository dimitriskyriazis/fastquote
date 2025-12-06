'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

export type AddModalState<T> = {
  values: T;
  setField: <K extends keyof T>(field: K, value: T[K]) => void;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  saving: boolean;
  setSaving: Dispatch<SetStateAction<boolean>>;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useAddModal<T extends Record<string, unknown>>(initializer: () => T): AddModalState<T> {
  const [initialValues] = useState(initializer);
  const [values, setValues] = useState(initialValues);
  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setValues(initialValues);
    setSaving(false);
    setError(null);
  }, [initialValues]);

  const open = useCallback(() => {
    reset();
    setIsOpen(true);
  }, [reset]);

  const close = useCallback(() => {
    reset();
    setIsOpen(false);
  }, [reset]);

  const setField = useCallback(
    <K extends keyof T>(field: K, value: T[K]) => {
      setValues((prev) => ({ ...prev, [field]: value }));
      setError(null);
    },
    [],
  );

  return {
    values,
    setField,
    isOpen,
    open,
    close,
    saving,
    setSaving,
    error,
    setError,
  };
}
