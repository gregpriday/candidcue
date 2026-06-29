export type ErrorCode =
  | 'OPENAI_AUTH'
  | 'OPENAI_RATE_LIMIT'
  | 'OPENAI_TIMEOUT'
  | 'OPENAI_SCHEMA'
  | 'INWORLD_AUTH'
  | 'STT_DISCONNECTED'
  | 'STT_FINALIZE_FAILED'
  | 'TTS_FAILED'
  | 'MIC_PERMISSION_DENIED'
  | 'MIC_DEVICE_LOST'
  | 'OUTPUT_DEVICE_LOST'
  | 'DISPLAY_LOST'
  | 'MEDIA_MANIFEST_INVALID'
  | 'MEDIA_DECODE_FAILED'
  | 'DATABASE_FAILED'
  | 'SESSION_STATE_CONFLICT'
  | 'EXPORT_FAILED'
  | 'VALIDATION_FAILED'
  | 'SOURCE_TOO_LARGE'
  | 'UNKNOWN';

export interface PublicAppError {
  code: ErrorCode;
  publicMessage: string;
  recoverable: boolean;
  retryAction: string | null;
  sessionId: string | null;
  turnId: string | null;
}

export interface AppErrorOptions {
  message?: string;
  publicMessage?: string;
  recoverable?: boolean;
  retryAction?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  cause?: unknown;
}

/** Structured application error. `message` is internal; `publicMessage` is UI-safe. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly publicMessage: string;
  readonly recoverable: boolean;
  readonly retryAction: string | null;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly causeName: string | null;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? options.publicMessage ?? code);
    this.name = 'AppError';
    this.code = code;
    this.publicMessage = options.publicMessage ?? DEFAULT_PUBLIC_MESSAGES[code];
    this.recoverable = options.recoverable ?? DEFAULT_RECOVERABLE[code] ?? false;
    this.retryAction = options.retryAction ?? null;
    this.sessionId = options.sessionId ?? null;
    this.turnId = options.turnId ?? null;
    this.causeName =
      options.cause instanceof Error ? options.cause.name : options.cause ? String(options.cause) : null;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  toPublic(): PublicAppError {
    return {
      code: this.code,
      publicMessage: this.publicMessage,
      recoverable: this.recoverable,
      retryAction: this.retryAction,
      sessionId: this.sessionId,
      turnId: this.turnId,
    };
  }
}

const DEFAULT_PUBLIC_MESSAGES: Record<ErrorCode, string> = {
  OPENAI_AUTH: 'OpenAI credentials are invalid. Please check them in Settings.',
  OPENAI_RATE_LIMIT: 'OpenAI is rate limiting requests. Retrying shortly.',
  OPENAI_TIMEOUT: 'The interview model took too long to respond.',
  OPENAI_SCHEMA: 'The interview model returned an unexpected response.',
  INWORLD_AUTH: 'Inworld credentials are invalid. Please check them in Settings.',
  STT_DISCONNECTED: 'The speech service disconnected. Reconnecting.',
  STT_FINALIZE_FAILED: 'We could not finalize the transcript for this answer.',
  TTS_FAILED: 'We could not generate the interviewer voice.',
  MIC_PERMISSION_DENIED: 'Microphone access was denied. Grant access to continue.',
  MIC_DEVICE_LOST: 'The selected microphone is no longer available.',
  OUTPUT_DEVICE_LOST: 'The selected audio output is no longer available.',
  DISPLAY_LOST: 'The teleprompter display was disconnected.',
  MEDIA_MANIFEST_INVALID: 'The interviewer media library is invalid.',
  MEDIA_DECODE_FAILED: 'An interviewer video clip could not be played.',
  DATABASE_FAILED: 'We could not save session data.',
  SESSION_STATE_CONFLICT: 'That action is not available in the current session state.',
  EXPORT_FAILED: 'The export could not be completed.',
  VALIDATION_FAILED: 'The request was invalid.',
  SOURCE_TOO_LARGE:
    "Your project's source material is too large to prepare. Shorten or split the sources, then try again.",
  UNKNOWN: 'Something went wrong.',
};

const DEFAULT_RECOVERABLE: Partial<Record<ErrorCode, boolean>> = {
  OPENAI_RATE_LIMIT: true,
  OPENAI_TIMEOUT: true,
  STT_DISCONNECTED: true,
  STT_FINALIZE_FAILED: true,
  TTS_FAILED: true,
  MIC_DEVICE_LOST: true,
  OUTPUT_DEVICE_LOST: true,
  DISPLAY_LOST: true,
  MEDIA_DECODE_FAILED: true,
  SESSION_STATE_CONFLICT: true,
};

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
