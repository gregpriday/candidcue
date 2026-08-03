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
  /*
   * The on-device recogniser.
   *
   * `STT_MODEL_NOT_INSTALLED` is the odd one out and deliberately so: since
   * §152 the stock installer ships no weights, so "the model is not here" is an
   * ORDINARY state a first run reaches rather than a damaged installation, and
   * it is the only one of the five the user can clear themselves — Settings →
   * Speech has the download. Rust raises it recoverable for that reason.
   *
   * The other four mean something on this machine is broken, which is why none
   * of them are recoverable by anything the user can type.
   */
  'STT_MODEL_NOT_INSTALLED',
  'STT_MODEL_MISSING',
  'STT_MODEL_LOAD_FAILED',
  'STT_WORKER_FAILED',
  'STT_ENGINE_ERROR',
  'NETWORK_OFFLINE',
  'NETWORK_TIMEOUT',
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
  // Remote image import (spec §24.2, §50.7). The URL codes are distinct so the
  // UI can say WHY a link was refused: not https, versus not publicly routable.
  'ASSET_URL_INSECURE',
  'ASSET_URL_BLOCKED',
  'ASSET_DOWNLOAD_FAILED',
  'DATABASE_MIGRATION_FAILED',
  'DATABASE_INTEGRITY_FAILED',
  'STAGE_DISPLAY_MISSING',
  'STAGE_OPEN_FAILED',
  // A close/publish naming a session that is no longer the one on stage (M1).
  'STAGE_SESSION_MISMATCH',
  'STAGE_LAYOUT_FAILED',
  /*
   * Single-window presentation could not reshape THIS window (§52.7).
   *
   * Distinct from `STAGE_OPEN_FAILED` because they are different failures with
   * different remedies, and sharing a code meant sharing copy: a take that
   * could not go borderless told the operator CandidCue "could not open the
   * stage window on that display" and to "choose another display" — naming a
   * window this path never opens and a picker it never consults.
   */
  'PRESENTATION_FAILED',
  'UPDATE_SIGNATURE_INVALID',
  'UPDATE_INSTALL_FAILED',
  'INTERNAL_UNEXPECTED',
  // Structured codes minted by src-tauri/src/errors.rs constructors.
  'NOT_IMPLEMENTED',
  'NOT_FOUND',
  'VALIDATION_FAILED',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];
