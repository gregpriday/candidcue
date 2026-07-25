/**
 * IPC and transport error presentation (spec §44.12, Appendix E.7): every
 * failure that reaches a person is authored copy that says what happened and
 * what to do about it.
 *
 * The rule this file enforces is narrow and absolute: **no stable error code
 * is ever shown to the user**. Codes are an internal contract — they cross the
 * IPC boundary inside `AppError`, they are thrown as `RealtimeTransportError`,
 * and several of them are carried as bare strings through the realtime
 * session hooks (`onSessionFailure(code, fatal)`), which is how
 * `QUOTA_EXHAUSTED` used to end up rendered verbatim in a toast.
 *
 * `describeError` therefore resolves a code from every shape a failure can
 * arrive in, and any string that still looks like a code is replaced rather
 * than shown. The raw code is not lost: it is recorded in a small ring buffer
 * that Settings → Diagnostics reads, which is the surface a support request is
 * actually built from.
 */
import { APP_ERROR_CODES, type AppError } from '../../shared/contracts';

/**
 * A SCREAMING_SNAKE_CASE token: two or more upper-case segments joined by
 * underscores. This is the shape of every code in `APP_ERROR_CODES`, and it is
 * also what a not-yet-mapped code looks like — which is the point. A code that
 * nobody wrote copy for must still not reach a toast.
 */
const CODE_TOKEN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const CODE_TOKEN_ANYWHERE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

/**
 * Human copy for every code that can reach a person.
 *
 * Each entry answers two questions in order: what happened, and what the
 * person can do next. A quota exhaustion, an auth failure and a network drop
 * are three different sentences with three different remedies — collapsing
 * them into one apologetic line is the same defect as showing the code.
 *
 * Where CandidCue genuinely cannot suggest an action, the copy says so in
 * plain English rather than implying one that does not exist.
 */
const ERROR_COPY: Record<string, string> = {
  /* -- auth / billing ----------------------------------------------------- */
  AUTH_KEY_INVALID:
    'Inworld rejected the API key. Open Settings → Speech and enter a key that is active for your account.',
  AUTH_MODEL_UNAVAILABLE:
    'This Inworld account does not have access to the transcription model CandidCue asked for. Check the account, or present in manual mode.',
  AUTH_REALTIME_UNAVAILABLE:
    'This Inworld account cannot open a streaming transcription session. Manual and fixed-speed modes still work.',
  QUOTA_EXHAUSTED:
    'The Inworld account has no quota left, so transcription cannot continue. Add credit in the Inworld dashboard, or present in manual mode.',
  RATE_LIMITED:
    'Inworld is rate-limiting this account. Wait a moment before trying again, or present in manual mode.',

  /* -- network / provider ------------------------------------------------- */
  NETWORK_OFFLINE:
    'CandidCue cannot reach the network. Check your internet connection, then try again.',
  NETWORK_TIMEOUT:
    'Inworld did not respond in time. Check your internet connection, then try again.',
  PROVIDER_UNAVAILABLE:
    'Inworld is not responding. This is usually temporary — try again in a minute, or present in manual mode.',

  /* -- microphone --------------------------------------------------------- */
  MIC_PERMISSION_DENIED:
    'CandidCue is not allowed to use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.',
  MIC_DEVICE_MISSING:
    'No microphone was found. Connect an input device, then try again.',
  MIC_DEVICE_LOST:
    'The microphone is no longer available. Reconnect it, or choose another input.',
  MIC_NO_SIGNAL:
    'No sound is reaching the microphone. Check that it is not muted and that the right input is selected.',
  MIC_CLIPPING:
    'The microphone is clipping. Lower its input gain, or move back from it a little.',

  /* -- transcription transport -------------------------------------------- */
  REALTIME_CONNECT_FAILED:
    'CandidCue could not open the transcription connection. Try again; if it keeps failing, check whether a firewall or VPN is blocking it.',
  REALTIME_NEGOTIATION_FAILED:
    'CandidCue could not open the transcription connection. Try again; if it keeps failing, check whether a firewall or VPN is blocking it.',
  REALTIME_CONNECTION_LOST:
    'The transcription connection dropped. Check your internet connection, then start voice following again.',
  REALTIME_PROVIDER_ERROR:
    'Inworld returned an error and transcription stopped. Start the take again; if it keeps happening, check the key in Settings → Speech.',
  REALTIME_CONFIG_REJECTED:
    'Inworld refused the transcription settings for this take, so retrying would fail the same way. Open Settings → Speech and check the model and language.',
  REALTIME_NO_TRANSCRIPTS:
    'Audio is being sent but no transcript is coming back, so following is on hold. Stop and start the take to open a fresh connection.',

  /* -- scripts ------------------------------------------------------------ */
  SCRIPT_CONFLICT:
    'This script’s file changed outside CandidCue since it was opened. Reload it before saving, or the newer version will be overwritten.',
  SCRIPT_SAVE_FAILED:
    'CandidCue could not save the script. Check that the disk is not full or read-only, then try again.',
  SCRIPT_FILE_MISSING:
    'The file behind this script is missing. It may have been moved or deleted outside CandidCue.',
  SCRIPT_COMPILE_FAILED:
    'CandidCue could not compile this script. The Script readiness list says what needs attention.',
  IMPORT_INVALID_FORMAT: 'That file is not in a format CandidCue can import.',
  IMPORT_UNSAFE_PATH:
    'That file sits outside the folders CandidCue is allowed to read, so it was not imported.',

  /* -- assets ------------------------------------------------------------- */
  ASSET_UNSUPPORTED: 'That file type is not supported as a script image.',
  ASSET_TOO_LARGE: 'That file is too large to add to a script. Use a smaller image.',
  ASSET_URL_INSECURE:
    'That link is not https, so CandidCue will not download it. Use an https address, or add the image from a file.',
  ASSET_URL_BLOCKED:
    'That link does not point at a publicly reachable address, so CandidCue will not download it. Add the image from a file instead.',
  ASSET_DOWNLOAD_FAILED:
    'CandidCue could not download that image. Check the link and your connection, then try again.',

  /* -- database ----------------------------------------------------------- */
  DATABASE_MIGRATION_FAILED:
    'CandidCue could not upgrade its database. Export a support bundle from Settings → Diagnostics before making further changes.',
  DATABASE_INTEGRITY_FAILED:
    'The CandidCue database did not pass its integrity check. Export a support bundle from Settings → Diagnostics before making further changes.',

  /* -- stage window ------------------------------------------------------- */
  STAGE_DISPLAY_MISSING:
    'The selected display is no longer connected. Reconnect it, or choose another display.',
  STAGE_OPEN_FAILED:
    'CandidCue could not open the stage window on that display. Choose another display, then try again.',
  STAGE_SESSION_MISMATCH:
    'That stage window belongs to a different session, so the change was not applied.',
  STAGE_LAYOUT_FAILED:
    'The stage could not lay out this script. Stop and start the take to rebuild it.',
  // Not in APP_ERROR_CODES: raised by the window layer and by Preflight's own
  // post-show check (§52.7).
  STAGE_DISPLAY_MISMATCH:
    'The stage opened on a different display than the one selected. Use “Identify displays” to see which panel is which.',

  /* -- listener packs ----------------------------------------------------- */
  LISTENER_NOT_INSTALLED: 'That Listener pack is not installed.',
  LISTENER_MANIFEST_INVALID:
    'That Listener pack could not be read. Reinstall it, or present without a Listener.',
  LISTENER_CHECKSUM_INVALID:
    'That Listener pack’s files do not match what shipped with CandidCue, so it was not loaded.',
  LISTENER_UNVERIFIED:
    'That Listener pack did not ship with CandidCue, so it was not loaded.',
  LISTENER_DECODE_FAILED:
    'The Listener video could not be played. Use the still image, or present without a Listener.',

  /* -- updates ------------------------------------------------------------ */
  UPDATE_SIGNATURE_INVALID:
    'That update could not be verified, so it was not installed. Download CandidCue again from the official site.',
  UPDATE_INSTALL_FAILED:
    'The update could not be installed. Try again, or download CandidCue again from the official site.',

  /* -- generic backend ---------------------------------------------------- */
  INTERNAL_UNEXPECTED:
    'Something went wrong inside CandidCue. Try again; if it keeps happening, export a support bundle from Settings → Diagnostics.',
  NOT_IMPLEMENTED: 'This feature is not available in this version of CandidCue.',
  NOT_FOUND: 'CandidCue could not find what that action needed.',
  VALIDATION_FAILED: 'That request was not valid, so nothing was changed.',
};

/**
 * Copy for a code nobody has written copy for yet. Honest plain English beats
 * `SCREAMING_SNAKE_CASE`: it says what is known (something failed, the code is
 * recorded) and points at the one place the raw code can be read.
 */
const UNMAPPED_CODE_COPY =
  'Something went wrong and CandidCue has no specific advice for it. The details are in Settings → Diagnostics.';

const FALLBACK_COPY = 'Something unexpected went wrong.';

export function isAppErrorPayload(err: unknown): err is AppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'userMessage' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

/**
 * Recent failures, newest first, for Settings → Diagnostics.
 *
 * The toast is where the user is told what to do; this is where the raw code
 * lives so a support request can name it. Bounded and in-memory only — it is a
 * debugging aid, not a log file, and it never contains transcript text.
 */
export interface ErrorDiagnosticEntry {
  atMs: number;
  /** The stable code, when one could be resolved. */
  code: string | null;
  /** The copy the user was actually shown. */
  shown: string;
}

const DIAGNOSTIC_LIMIT = 20;
let diagnosticLog: ErrorDiagnosticEntry[] = [];

/** Newest first. A copy, so callers cannot mutate the log. */
export function recentErrorDiagnostics(): ErrorDiagnosticEntry[] {
  return diagnosticLog.map((entry) => ({ ...entry }));
}

export function clearErrorDiagnostics(): void {
  diagnosticLog = [];
}

function record(code: string | null, shown: string): void {
  diagnosticLog = [{ atMs: Date.now(), code, shown }, ...diagnosticLog].slice(0, DIAGNOSTIC_LIMIT);
}

/**
 * Resolve the stable code from any failure shape.
 *
 * Four shapes exist in this codebase and all four have reached a user:
 *  1. `AppError` from IPC — `{ code, userMessage, … }`;
 *  2. `RealtimeTransportError` — an `Error` carrying `.code`;
 *  3. a bare code string, from the realtime session hooks;
 *  4. `new Error(result.code)` — audio acquisition throws the code AS the
 *     message (`voice-session.ts`, `voice-live.ts`), so `err.message` is a
 *     code, not prose.
 */
export function errorCode(err: unknown): string | null {
  if (isAppErrorPayload(err)) return err.code;
  if (typeof err === 'string') return CODE_TOKEN.test(err.trim()) ? err.trim() : null;
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && CODE_TOKEN.test(code.trim())) return code.trim();
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && CODE_TOKEN.test(message.trim())) return message.trim();
  }
  return null;
}

/** Is `code` one this build knows how to talk about? */
export function hasErrorCopy(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ERROR_COPY, code);
}

/** Authored copy for a stable code. Never returns the code itself. */
export function copyForErrorCode(code: string): string {
  return ERROR_COPY[code] ?? UNMAPPED_CODE_COPY;
}

/**
 * Human copy for any caught IPC / transport / audio failure.
 *
 * Guarantees, in order of precedence:
 *  - a resolvable code always yields authored copy (or the honest unmapped
 *    sentence), never the code;
 *  - a backend `userMessage` is used only when no copy override exists — Rust
 *    writes those for a human, unlike a code;
 *  - anything still carrying a `SCREAMING_SNAKE_CASE` token is discarded in
 *    favour of the fallback, so a code added tomorrow cannot leak through a
 *    path nobody remembered to update.
 */
export function describeError(err: unknown): string {
  const code = errorCode(err);
  if (code !== null) {
    const shown =
      ERROR_COPY[code] ??
      (isAppErrorPayload(err) && typeof err.userMessage === 'string' && !looksLikeCode(err.userMessage)
        ? err.userMessage
        : UNMAPPED_CODE_COPY);
    record(code, shown);
    return shown;
  }

  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : isAppErrorPayload(err)
          ? err.userMessage
          : '';
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '' || looksLikeCode(trimmed)) {
    record(null, FALLBACK_COPY);
    return FALLBACK_COPY;
  }
  record(null, trimmed);
  return trimmed;
}

/** True when a string still carries a machine token no user should read. */
export function looksLikeCode(text: string): boolean {
  return CODE_TOKEN_ANYWHERE.test(text);
}

/**
 * Every code this build can be asked about — the union of the IPC contract and
 * the extra transport-only codes written above. Exported so a test can assert
 * that every one of them renders as copy rather than as itself.
 */
export const KNOWN_ERROR_CODES: readonly string[] = Array.from(
  new Set<string>([...APP_ERROR_CODES, ...Object.keys(ERROR_COPY)]),
);
