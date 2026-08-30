import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebounce } from '@/hooks/useDebounce';

export function useUrlState() {
  const [params, setParams] = useSearchParams();

  const get = useCallback((key: string) => params.get(key) ?? undefined, [params]);

  const patch = useCallback(
    (updates: Record<string, string | null | undefined>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(updates)) {
            if (value == null || value === '' || value === 'all') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return { params, get, patch };
}

export function useUrlSearch(key = 'q') {
  const { get, patch } = useUrlState();
  const urlValue = get(key) ?? '';
  const [value, setValue] = useState(urlValue);
  const debounced = useDebounce(value, 300);

  useEffect(() => {
    setValue(urlValue);
  }, [urlValue]);

  useEffect(() => {
    if (debounced === urlValue) return;
    patch({ [key]: debounced.trim() || null });
  }, [debounced, key, patch, urlValue]);

  return { value, setValue, committed: urlValue };
}
