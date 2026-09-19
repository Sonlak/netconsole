import { useCallback, useRef } from 'react';

/**
 * useMetricHistory — keeps an in-memory sliding window of numeric samples per key.
 *
 * Used to give `MetricCard` enough history to render a sparkline without
 * changing the backend contract. The refresh interval drives samples: every
 * 15s we push the current value, after `limit` samples we drop the oldest.
 *
 * History is stored on a module-level map so it survives component remounts
 * inside the same tab session. Reset via the returned `clearAll()` if a
 * filter changes the scope of a metric (eg. switching site filter).
 */

const HISTORY = new Map<string, number[]>();
const MAX_HISTORY = 60;

export function useMetricHistory() {
  // Track ordered keys we've registered so we can iterate without losing
  // ordering if a key is later removed.
  const keysRef = useRef<Set<string>>(new Set());

  const push = useCallback((key: string, value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return;
    const next = HISTORY.get(key) ?? [];
    next.push(value);
    if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
    HISTORY.set(key, next);
    keysRef.current.add(key);
  }, []);

  const samples = useCallback((key: string): number[] => HISTORY.get(key) ?? [], []);

  const last = useCallback((key: string): number | null => {
    const arr = HISTORY.get(key);
    return arr && arr.length > 0 ? arr[arr.length - 1] : null;
  }, []);

  const clearAll = useCallback(() => {
    HISTORY.clear();
    keysRef.current.clear();
  }, []);

  const clearKey = useCallback((key: string) => {
    HISTORY.delete(key);
    keysRef.current.delete(key);
  }, []);

  return { push, samples, last, clearAll, clearKey };
}

/** Sample size of the in-memory history window. */
export const METRIC_HISTORY_LIMIT = MAX_HISTORY;
