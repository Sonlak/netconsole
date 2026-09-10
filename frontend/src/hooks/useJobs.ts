import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJobs, jobsRangeToSince, type JobsRange } from '@/api/jobs';
import { toError } from '@/lib/errors';
import type { Job } from '@/types/job';

const DEFAULT_LIMIT = 1000;

export interface UseJobsOptions {
  /** Max number of rows the server returns. Defaults to 1000 (the server's hard cap). */
  limit?: number;
  /**
   * Time-window filter. The hook re-fetches automatically when this
   * changes. `null` = no time filter (server returns the most recent N).
   */
  range?: JobsRange;
}

export function useJobs(options: UseJobsOptions = {}) {
  const { limit = DEFAULT_LIMIT, range = null } = options;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const refresh = useCallback(
    async (refreshOptions?: { silent?: boolean }) => {
      const silent = Boolean(refreshOptions?.silent);
      if (silent) setIsRefreshing(true);
      else setIsLoading(true);
      try {
        const since = jobsRangeToSince(range);
        const next = await fetchJobs({ limit, since: since ?? undefined });
        setJobs(Array.isArray(next) ? (next as Job[]) : []);
        setError(null);
        setLastUpdatedAt(new Date().toISOString());
      } catch (cause) {
        setError(toError(cause, 'Could not load jobs'));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [limit, range],
  );

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
