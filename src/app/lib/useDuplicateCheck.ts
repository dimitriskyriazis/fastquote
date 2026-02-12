import { useCallback, useEffect, useRef, useState } from "react";

export type DuplicateMatch = {
  id: number;
  name: string;
  taxId?: string | null;
  partNumber?: string | null;
  modelNumber?: string | null;
};

export type DuplicateWarningGroup = {
  type: string;
  label: string;
  matches: DuplicateMatch[];
};

type CheckParams = Record<string, string | undefined>;

const DEBOUNCE_MS = 500;

export function useDuplicateCheck(entity: string) {
  const [warnings, setWarnings] = useState<DuplicateWarningGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastParamsRef = useRef<string>("");

  const check = useCallback(
    (params: CheckParams) => {
      // Filter out empty values
      const filtered: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) {
        if (value && value.trim()) {
          filtered[key] = value.trim();
        }
      }

      // No meaningful values to check
      if (Object.keys(filtered).length === 0) {
        setWarnings([]);
        lastParamsRef.current = "";
        return;
      }

      const serialized = JSON.stringify({ entity, ...filtered });
      if (serialized === lastParamsRef.current) return;
      lastParamsRef.current = serialized;

      // Cancel previous timer and request
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();

      timerRef.current = setTimeout(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
        try {
          const response = await fetch("/api/duplicates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entity, ...filtered }),
            signal: controller.signal,
          });
          const data = (await response.json().catch(() => null)) as {
            ok?: boolean;
            warnings?: DuplicateWarningGroup[];
          } | null;
          if (data?.ok && data.warnings) {
            setWarnings(data.warnings);
          } else {
            setWarnings([]);
          }
        } catch {
          // Silently ignore aborted requests and errors
        } finally {
          setLoading(false);
        }
      }, DEBOUNCE_MS);
    },
    [entity],
  );

  const clear = useCallback(() => {
    setWarnings([]);
    lastParamsRef.current = "";
    if (timerRef.current) clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { warnings, loading, check, clear };
}
