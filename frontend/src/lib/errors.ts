export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Thrown when a device is locked by another in-flight job.
 * Includes the blocking job details so the UI can show which user is using the device.
 */
export class DeviceBusyError extends Error {
  status: 409;
  lockedBy: {
    jobId: string;
    jobType: string;
    jobStatus: string;
    jobCreatedAt: string;
    userId: string | null;
    username: string | null;
  };

  constructor(lockedBy: DeviceBusyError['lockedBy']) {
    super('Device busy');
    this.name = 'DeviceBusyError';
    this.status = 409;
    this.lockedBy = lockedBy;
  }
}

export function toError(cause: unknown, fallback = 'Request failed'): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

export function errorMessage(error: Error | null, fallback = 'Request failed'): string {
  return error?.message?.trim() || fallback;
}

export function isNotFound(error: Error | null | undefined): boolean {
  return error instanceof HttpError && error.status === 404;
}
