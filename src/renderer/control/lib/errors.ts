import type { PublicAppError } from '@shared/errors/app-error';

/**
 * Pull a human-readable message out of anything that crossed the IPC boundary.
 * Rejections from the preload bridge surface as Errors; structured app errors
 * carry a `publicMessage`.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (isPublicAppError(error)) {
    return error.publicMessage;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'Something went wrong.';
}

export function isPublicAppError(value: unknown): value is PublicAppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'publicMessage' in value &&
    typeof (value as { publicMessage: unknown }).publicMessage === 'string'
  );
}
