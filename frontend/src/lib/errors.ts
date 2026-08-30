export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
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
