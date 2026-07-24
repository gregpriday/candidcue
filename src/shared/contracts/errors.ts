/**
 * Application error contracts (spec §44.12 and Appendix C.7).
 *
 * All Rust errors exposed through IPC map to this stable shape. The UI maps
 * codes to localized copy and recovery actions — never branch on English
 * provider messages, and never surface a raw Rust debug string.
 */

export type AppErrorCategory =
  | 'validation'
  | 'permission'
  | 'network'
  | 'auth'
  | 'quota'
  | 'storage'
  | 'database'
  | 'media'
  | 'window'
  | 'provider'
  | 'internal';

export type AppErrorAction =
  | 'retry'
  | 'open_settings'
  | 'choose_device'
  | 'reconnect'
  | 'reveal_folder'
  | 'use_manual_mode'
  | 'contact_support';

export interface AppError {
  code: string;
  category: AppErrorCategory;
  userMessage: string;
  recoverable: boolean;
  action?: AppErrorAction;
  correlationId: string;
  details?: Record<string, string | number | boolean>;
}

/** Stable application error codes (spec Appendix C.7). */
export const APP_ERROR_CODES = [
  'AUTH_KEY_INVALID',
  'AUTH_MODEL_UNAVAILABLE',
  'AUTH_REALTIME_UNAVAILABLE',
  'QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  'NETWORK_OFFLINE',
  'NETWORK_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'MIC_PERMISSION_DENIED',
  'MIC_DEVICE_MISSING',
  'MIC_DEVICE_LOST',
  'MIC_NO_SIGNAL',
  'MIC_CLIPPING',
  'REALTIME_NEGOTIATION_FAILED',
  'REALTIME_CONNECTION_LOST',
  'REALTIME_NO_TRANSCRIPTS',
  'SCRIPT_CONFLICT',
  'SCRIPT_SAVE_FAILED',
  'SCRIPT_FILE_MISSING',
  'SCRIPT_COMPILE_FAILED',
  'IMPORT_INVALID_FORMAT',
  'IMPORT_UNSAFE_PATH',
  'ASSET_UNSUPPORTED',
  'ASSET_TOO_LARGE',
  'DATABASE_MIGRATION_FAILED',
  'DATABASE_INTEGRITY_FAILED',
  'STAGE_DISPLAY_MISSING',
  'STAGE_OPEN_FAILED',
  'STAGE_LAYOUT_FAILED',
  'LISTENER_NOT_INSTALLED',
  'LISTENER_MANIFEST_INVALID',
  'LISTENER_SIGNATURE_INVALID',
  'LISTENER_DECODE_FAILED',
  'UPDATE_SIGNATURE_INVALID',
  'UPDATE_INSTALL_FAILED',
  'INTERNAL_UNEXPECTED',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];
