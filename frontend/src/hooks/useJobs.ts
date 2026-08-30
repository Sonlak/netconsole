import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJobs } from '@/api/jobs';
import { toError } from '@/lib/errors';
import type { Job } from '@/types/job';

export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (silent) setIsRefreshing(true);
    else setIsLoading(true);
    try {
      const next = await fetchJobs();
      setJobs(Array.isArray(next) ? (next as Job[]) : []);
      setError(null);
      setLastUpdatedAt(new Date().toISOString());
    } catch (cause) {
      setError(toError(cause, 'Could not load jobs'));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh({ silent: true });
    }, 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const stats = useMemo(
    () => ({
      total: jobs.length,
      pending: jobs.filter((job) => job.status === 'PENDING').length,
      running: jobs.filter((job) => job.status === 'RUNNING').length,
      success: jobs.filter((job) => job.status === 'SUCCESS').length,
      failed: jobs.filter((job) => job.status === 'FAILED').length,
    }),
    [jobs],
  );

  return { jobs, stats, isLoading, isRefreshing, error, lastUpdatedAt, refresh };
}
