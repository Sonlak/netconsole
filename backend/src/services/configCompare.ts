/**
 * Config snapshot comparison service.
 *
 * Snapshots come from GET_CONFIG SUCCESS jobs — one snapshot per collect.
 * No separate snapshot table is needed; the job result IS the snapshot.
 */

import { JobStatus, JobType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type ConfigSnapshot = {
  jobId: string;
  collectedAt: string;
  collectMs: number;
  username: string | null;
  lineCount: number;
};

export async function getDeviceSnapshots(deviceId: string): Promise<ConfigSnapshot[]> {
  const jobs = await prisma.job.findMany({
    where: {
      deviceId,
      type: JobType.GET_CONFIG,
      status: JobStatus.SUCCESS,
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      updatedAt: true,
      result: true,
      createdBy: { select: { username: true } },
    },
  });

  const snapshots: ConfigSnapshot[] = [];
  for (const job of jobs) {
    const result = (job.result ?? {}) as Record<string, unknown>;
    const config = typeof result.config === 'string' ? result.config : '';
    if (!config) continue;
    snapshots.push({
      jobId: job.id,
      collectedAt: job.updatedAt.toISOString(),
      collectMs: typeof result.collectMs === 'number' ? (result.collectMs as number) : 0,
      username: job.createdBy?.username ?? null,
      lineCount: config.split('\n').length,
    });
  }
  return snapshots;
}

export async function getSnapshotConfig(jobId: string): Promise<string | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      type: true,
      status: true,
      result: true,
    },
  });
  if (!job || job.type !== JobType.GET_CONFIG || job.status !== JobStatus.SUCCESS) return null;
  const result = (job.result ?? {}) as Record<string, unknown>;
  return typeof result.config === 'string' ? result.config : null;
}

export type DiffLineType = 'added' | 'removed' | 'unchanged';

export type DiffLine = {
  type: DiffLineType;
  content: string;
};

export type DiffResult = {
  lines: DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
};

function splitLines(text: string): string[] {
  return text.split('\n');
}

export function diffConfigs(left: string, right: string): DiffResult {
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);

  // Simple LCS-based diff
  const m = leftLines.length;
  const n = rightLines.length;

  // Build LCS table (space-optimised: only keep two rows)
  let prev: number[] = Array(n + 1).fill(0);
  let curr: number[] = Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    const temp = prev;
    prev = curr;
    curr = temp;
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      if (leftLines[i - 1] === rightLines[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(curr[j - 1], prev[j]);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && leftLines[i - 1] === rightLines[j - 1]) {
      result.unshift({ type: 'unchanged', content: leftLines[i - 1] });
      unchanged++;
      i--;
      j--;
    } else if (j > 0 && (i === 0 || curr[j] === curr[j - 1])) {
      result.unshift({ type: 'added', content: rightLines[j - 1] });
      added++;
      j--;
    } else {
      result.unshift({ type: 'removed', content: leftLines[i - 1] });
      removed++;
      i--;
    }
  }

  // If right has extra lines at the end
  while (j > 0) {
    result.unshift({ type: 'added', content: rightLines[j - 1] });
    added++;
    j--;
  }

  return { lines: result, added, removed, unchanged };
}
