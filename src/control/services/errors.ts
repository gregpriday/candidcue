/**
 * IPC error presentation (spec §44.12): every Rust rejection crosses the
 * boundary as the stable AppError payload. The UI maps codes to copy here —
 * never branch on English provider messages, never show a raw Rust string.
 */
import type { AppError } from '../../shared/contracts';

/** Copy overrides for codes whose backend userMessage needs UI framing. */
const ERROR_COPY: Partial<Record<string, string>> = {
  NOT_IMPLEMENTED: 'This feature is not available in this version of CandidCue.',
  NOT_FOUND: 'CandidCue could not find what that action needed.',
  VALIDATION_FAILED: 'That request was not valid. Nothing was changed.',
  STAGE_DISPLAY_MISSING: 'The selected display is no longer connected.',
  STAGE_OPEN_FAILED: 'CandidCue could not open the stage window.',
  AUTH_KEY_INVALID: 'There is a problem with the stored OpenAI API key.',
  NETWORK_OFFLINE: 'CandidCue could not reach the network.',
  QUOTA_EXHAUSTED: 'The OpenAI project has no available quota or billing access.',
};

export function isAppErrorPayload(err: unknown): err is AppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'userMessage' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

/** Human copy for any caught IPC/backend failure. */
export function describeError(err: unknown): string {
  if (isAppErrorPayload(err)) {
    return ERROR_COPY[err.code] ?? err.userMessage ?? 'Something unexpected went wrong.';
  }
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Something unexpected went wrong.';
}

/** Stable code accessor for branching (retry affordances etc.). */
export function errorCode(err: unknown): string | null {
  return isAppErrorPayload(err) ? err.code : null;
}
