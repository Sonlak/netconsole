export type JobType =
  | 'CONNECT_TEST'
  | 'GET_CONFIG'
  | 'GET_ARP'
  | 'GET_MAC'
  | 'GET_INTERFACES'
  | 'INTERFACE_ACTION'
  | 'MANAGED_CHECK'
  | 'DISCOVERY_PROBE'
  | 'APPLY_CONFIG'
  | 'ROLLBACK_CONFIG';
export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export type Job = {
  id: string;
  deviceId: string | null;
  type: JobType;
  status: JobStatus;
  payload?: unknown;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  device?: {
    id: string;
    name: string;
    ip: string;
    site: string;
    vendor?: string;
    model?: string;
  };
};

export type OperationResponse = {
  source: 'job' | 'stub';
  jobId?: string;
  collectedAt: string | null;
  data: Record<string, unknown>;
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  CONNECT_TEST: 'Connect test',
  GET_CONFIG: 'Get config',
  GET_ARP: 'Get ARP table',
  GET_MAC: 'Get MAC table',
  GET_INTERFACES: 'Get interfaces',
  INTERFACE_ACTION: 'Interface action',
  MANAGED_CHECK: 'Managed check',
  DISCOVERY_PROBE: 'Discovery probe',
  APPLY_CONFIG: 'Commit config',
  ROLLBACK_CONFIG: 'Rollback config',
};
