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
 * that Settings → Data, privacy & updates → Diagnostics reads, which is the surface a support request is
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
  /* -- the bundled recogniser --------------------------------------------- */
  //
  // A broken installation, not a broken account. There is no key, no quota and
  // no provider to be down, so nothing here asks the presenter to go and fix
  // something on a website.
  //
  // Each one also names the fallback that EXISTS. These used to end "Manual and
  // fixed-speed modes still work", which they no longer do: Settings shows both
  // as unavailable in this release, so that sentence sent a presenter whose
  // recogniser had just died hunting for a greyed-out menu item. Auto-scroll is
  // the real answer.
  //
  // The rescue is scoped — "In a take, …" — because these four strings have TWO
  // surfaces, and only one of them has a transport to press. In a take they
  // reach the failure toast, where `A` really does work. But `voice-live.ts`
  // hands the same `describeError` output to `events.onError` on both the
  // `startTranscription()` rejection and every `failed` frame, `MicTestSession`
  // stores it as `snapshot.error`, and Settings → Audio renders it verbatim as
  // `micError`. `startTranscription()` → `ensure_loaded()` is exactly where
  // `STT_MODEL_MISSING` and `STT_MODEL_LOAD_FAILED` are raised, and the failed
  // frames carry `STT_WORKER_FAILED` / `STT_ENGINE_ERROR`, so all four land on
  // that screen. There is no take there: `toggleAutoScroll()` returns early
  // while `state.active` is false, and the shortcut layer only binds `A` inside
  // a session, so a bare "Press A" is the old defect in new words. A conditional
  // is true on both surfaces; an imperative is true on neither more than one.
  //
  // For the same reason nothing here says "after the take" any more: the reader
  // in Settings has no take to be after. Every repair clause is phrased so it
  // holds with or without one, and any clause that cannot be is folded into the
  // "In a take" sentence (`STT_ENGINE_ERROR`'s stop-and-start).
  //
  // The rescue comes BEFORE the repair in all four. Reinstalling and restarting
  // both mean leaving CandidCue, which is not a thing anyone does mid-take; the
  // keystroke that keeps the script moving is what the presenter needs in the
  // second they are reading this, and the repair keeps until they are off
  // camera.
  //
  // All four say "start or stop", because `A` is a TOGGLE and none of these
  // can promise which way it will move.
  //
  // `STT_ENGINE_ERROR` is the obvious case: it fires arbitrarily deep into a
  // take, and auto-scroll pauses following without pausing transcription, so
  // the recogniser can die with the transport already running. The other three
  // look like cold-start failures where `startLiveSession` has just set
  // `running: false` — but `resume()` re-enters `start()` after a hard pause
  // released the capture, and `autoScroll.running` deliberately survives a
  // pause. A → hard pause → resume is enough to reach any of them with the
  // transport armed, and telling that presenter to "start" auto-scroll would
  // stop their script. "Start or stop" is also the wording Settings and Live
  // already use for this key.
  STT_MODEL_MISSING:
    'The speech model is missing from this installation. In a take, press A to start or stop auto-scroll. Reinstall CandidCue to restore voice following.',
  STT_MODEL_LOAD_FAILED:
    'The speech model could not be loaded. In a take, press A to start or stop auto-scroll. Restart CandidCue, and reinstall it if this keeps happening.',
  STT_WORKER_FAILED:
    'The speech recogniser is unavailable. In a take, press A to start or stop auto-scroll. Restart CandidCue to bring it back.',
  STT_ENGINE_ERROR:
    'The speech recogniser failed unexpectedly. In a take, press A to start or stop auto-scroll, then stop and start the take to retry voice following.',

  /* -- network ------------------------------------------------------------ */
  //
  // Transcription is local now, so nothing here is about speech: what is left
  // reaches the network only to check for updates.
  NETWORK_OFFLINE:
    'CandidCue cannot reach the network. Check your internet connection, then try again.',
  NETWORK_TIMEOUT:
    'The server did not respond in time. Check your internet connection, then try again.',

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
  /*
   * Not an IPC code — the voice pipeline throws it when a stop lands while a
   * start is still in flight. It has copy because it reached a presenter once,
   * as "Something went wrong and CandidCue has no specific advice for it",
   * which is the worst sentence in the app: alarming, useless, and about
   * nothing the presenter did. The store now swallows it when the session is
   * genuinely gone; this is the backstop for every path that does not.
   */
  SESSION_STOPPED:
    'The session ended before voice following could start. Start it again when you are ready.',

  /* -- transcription transport -------------------------------------------- */
  REALTIME_CONNECT_FAILED:
    'CandidCue could not open the transcription connection. Try again; if it keeps failing, check whether a firewall or VPN is blocking it.',
  REALTIME_NEGOTIATION_FAILED:
    'CandidCue could not open the transcription connection. Try again; if it keeps failing, check whether a firewall or VPN is blocking it.',
  REALTIME_CONNECTION_LOST:
    'The transcription connection dropped. Check your internet connection, then start voice following again.',
  REALTIME_PROVIDER_ERROR:
    'The speech recogniser reported an error and transcription stopped. Start the take again; if it keeps happening, restart CandidCue.',
  REALTIME_CONFIG_REJECTED:
    'The speech recogniser could not be configured for this take, so retrying would fail the same way. Restart CandidCue, and reinstall it if this keeps happening.',
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
    'CandidCue could not read this script. The notes under the outline say what needs attention.',
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
    'CandidCue could not upgrade its database. Export a support bundle from Settings → Data, privacy & updates → Diagnostics before making further changes.',
  DATABASE_INTEGRITY_FAILED:
    'The CandidCue database did not pass its integrity check. Export a support bundle from Settings → Data, privacy & updates → Diagnostics before making further changes.',

  /* -- stage window ------------------------------------------------------- */
  STAGE_DISPLAY_MISSING:
    'The selected display is no longer connected. Reconnect it, or choose another display.',
  STAGE_OPEN_FAILED:
    'CandidCue could not open the stage window on that display. Choose another display, then try again.',
  // Single-window presentation: no second window, no display picker, so the
  // copy above would send the operator somewhere that cannot help them.
  PRESENTATION_FAILED:
    'CandidCue could not turn this window into the teleprompter. The window has been left as it was — try Present again.',
  STAGE_SESSION_MISMATCH:
    'That stage window belongs to a different session, so the change was not applied.',
  STAGE_LAYOUT_FAILED:
    'The stage could not lay out this script. Stop and start the take to rebuild it.',
  // Not in APP_ERROR_CODES: raised by the window layer and by Preflight's own
  // post-show check (§52.7).
  STAGE_DISPLAY_MISMATCH:
    'The stage opened on a different display than the one selected. Use “Identify displays” to see which panel is which.',


  /* -- updates ------------------------------------------------------------ */
  UPDATE_SIGNATURE_INVALID:
    'That update could not be verified, so it was not installed. Download CandidCue again from the official site.',
  UPDATE_INSTALL_FAILED:
    'The update could not be installed. Try again, or download CandidCue again from the official site.',

  /* -- generic backend ---------------------------------------------------- */
  INTERNAL_UNEXPECTED:
    'Something went wrong inside CandidCue. Try again; if it keeps happening, export a support bundle from Settings → Data, privacy & updates → Diagnostics.',
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
  'Something went wrong and CandidCue has no specific advice for it. The details are in Settings → Data, privacy & updates → Diagnostics.';

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
 * Recent failures, newest first, for Settings → Data, privacy & updates → Diagnostics.
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
