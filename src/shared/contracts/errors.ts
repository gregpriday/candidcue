/**
 * Application error contracts (spec §44.12 and Appendix C.7).
 *
 * All Rust errors exposed through IPC map to this stable shape. The UI maps
 * codes to localized copy and recovery actions — never branch on English
 * provider messages, and never surface a raw Rust debug string.
 */

// No 'auth'. The category described a rejected API key from the hosted speech
// provider; the recogniser is on-device and the app holds no credential, so
// nothing in Rust can produce it. See `ErrorCategory` in src-tauri/src/errors.rs.
export type AppErrorCategory =
  | 'validation'
  | 'permission'
  | 'network'
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
   * The other four mean something on this machine is broken. Rust raises all
   * four non-recoverable, which is a statement about the SESSION rather than
   * about the user: nothing retried in place will make the take work. Their
   * copy still names a repair — restart, download the model again — because a
   * repair between takes is a different thing from a recovery within one.
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
   * Window › CandidCue / Stage could not bring a window forward (§13.4).
   *
   * Raised rather than swallowed because the window IS there — the menu item is
   * only enabled when it is — so a focus that fails is a real fault the window
   * manager reported, and the menu item somebody just chose is the only place
   * they could learn that nothing happened.
   */
  'WINDOW_FOCUS_FAILED',
  /*
   * File › Close Window could not close the document window (#266) — raised
   * for the same reason as the one above: that menu item used to fail without
   * a word, and a quit that silently did not happen is the defect it fixed.
   */
  'WINDOW_CLOSE_FAILED',
  /*
   * `close_control_window` invoked from a window that is not control. No
   * screen does that — Settings closes itself with `close_preferences` — so
   * this is the shared command grant being used for something it must not do.
   */
  'WINDOW_CLOSE_REFUSED',
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
  /*
   * No `UPDATE_SIGNATURE_INVALID` / `UPDATE_INSTALL_FAILED`. CandidCue 1.0
   * updates manually (docs/updates.md); planned error codes for a feature that
   * does not exist are part of what made the half-updater look wired.
   */
  'INTERNAL_UNEXPECTED',
  // Structured codes minted by src-tauri/src/errors.rs constructors.
  'NOT_IMPLEMENTED',
  'NOT_FOUND',
  'VALIDATION_FAILED',

  /*
   * ---------------------------------------------------------------------
   * Codes Rust mints that this list used not to contain
   * ---------------------------------------------------------------------
   * The 1.0 readiness review found the two sides had drifted: Rust produced
   * structured codes for database, language-selection and model-manager
   * failures that appeared nowhere here, so the frontend's copy registry had
   * no entry for them and the user got the raw code or a generic fallback on
   * exactly the failures that most need an explanation.
   *
   * `tests/unit/control/error-code-parity.test.ts` now reads the Rust sources
   * and fails when a code crosses the boundary without an entry here AND
   * authored copy — so this list cannot fall behind again without something
   * saying so.
   */
  'DATABASE_CORRUPT',
  'INVALID_SCRIPT_ID',
  'DATABASE_BACKUP_REQUIRED',
  'DATABASE_UNAVAILABLE',
  'RESTORE_FAILED',
  // `STT_ENGINE_ERROR`, `STT_WORKER_FAILED`, `STT_MODEL_LOAD_FAILED`,
  // `STT_MODEL_MISSING` and `STT_MODEL_NOT_INSTALLED` are already declared
  // above with the rest of the recogniser codes; the drift was in the OTHER
  // direction for those.
  'STT_LANGUAGE_CHANGE_BLOCKED',
  'STT_LANGUAGE_UNAVAILABLE',
  'STT_MODEL_BUSY',
  'STT_MODEL_CANCELLED',
  'STT_MODEL_CORRUPT',
  'STT_MODEL_DOWNLOAD_FAILED',
  'STT_MODEL_INSTALL_FAILED',
  'STT_MODEL_INSUFFICIENT_SPACE',
  'STT_MODEL_UNKNOWN',
  'STT_MODEL_UNSUPPORTED',
  'STT_MODEL_URL_BLOCKED',
  'STT_MODEL_URL_INSECURE',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];
