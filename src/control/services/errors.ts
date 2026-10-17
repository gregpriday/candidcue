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
  /* -- the on-device recogniser -------------------------------------------- */
  //
  // A broken machine, not a broken account. There is no key, no quota and no
  // provider to be down, so nothing here asks the presenter to go and fix
  // something on a website.
  //
  // Nor does anything here ask them to reinstall CandidCue any more, which is
  // what `STT_MODEL_MISSING` and `STT_MODEL_LOAD_FAILED` used to say. The
  // weights were in the bundle when that copy was written; since §152 the stock
  // installer ships none and the model is downloaded into the app-data
  // directory instead. A reinstall leaves those bytes exactly as they were, so
  // it was an instruction that could not work — the same defect as naming a
  // greyed-out menu item, one step further along. The model is a DOWNLOAD, and
  // the download lives in Settings → Speech.
  //
  // `STT_MODEL_NOT_INSTALLED` is the newest of the five and the most likely to
  // be read: a first run that skips Welcome and starts a take reaches it. It is
  // not a fault at all — it is the ordinary state of a machine that has not
  // downloaded a model yet — which is why Rust raises it recoverable and why
  // its copy is the only one whose remedy is something the user was always
  // going to have to do. Note it does NOT mean "never downloaded": a deleted,
  // unsealed, stale or half-extracted download all fail `model_store`'s
  // usability check and arrive here too, so the copy says the model is not
  // installed rather than guessing at a history it cannot see.
  //
  // Each one also names the fallback that EXISTS. These used to end "Manual and
  // fixed-speed modes still work", which they no longer do: Settings shows both
  // as unavailable in this release, so that sentence sent a presenter whose
  // recogniser had just died hunting for a greyed-out menu item. Auto-scroll is
  // the real answer.
  //
  // The rescue is scoped — "In a take, …" — because these five strings have
  // THREE surfaces, and only one of them has a transport to press. In a take
  // they reach the failure toast, where `A` really does work. But
  // `voice-live.ts` hands the same `describeError` output to `events.onError`
  // on both the `startTranscription()` rejection and every `failed` frame,
  // `MicTestSession` stores it as `snapshot.error`, and Settings → Audio
  // renders it verbatim as `micError`. `startTranscription()` →
  // `ensure_loaded()` is exactly where `STT_MODEL_NOT_INSTALLED`,
  // `STT_MODEL_MISSING` and `STT_MODEL_LOAD_FAILED` are raised, and the failed
  // frames carry `STT_WORKER_FAILED` / `STT_ENGINE_ERROR`, so all five land on
  // that screen. There is no take there: `toggleAutoScroll()` returns early
  // while `state.active` is false, and the shortcut layer only binds `A` inside
  // a session, so a bare "Press A" is the old defect in new words. A conditional
  // is true on both surfaces; an imperative is true on neither more than one.
  //
  // The third surface belongs to `STT_MODEL_NOT_INSTALLED` alone, and it is a
  // SECOND raise site rather than another route out of `ensure_loaded`:
  // `select_speech_language` (`speech_cmds.rs`) refuses a language whose
  // weights are not on the machine, `SpeechLanguagePicker.activate()` turns the
  // rejection into `selectError = describeError(err)`, and the picker renders
  // it in a `role="alert"`. That screen has no take either, and the picker is
  // hosted by both Welcome and Settings — so the copy has to read as sense next
  // to a language row, not only under a take that failed to start.
  //
  // For the same reason nothing here says "after the take" any more: the reader
  // in Settings has no take to be after. Every repair clause is phrased so it
  // holds with or without one, and any clause that cannot be is folded into the
  // "In a take" sentence (`STT_ENGINE_ERROR`'s stop-and-start).
  //
  // The rescue comes BEFORE the repair in all five. Downloading and restarting
  // both mean putting the script down, which is not a thing anyone does
  // mid-take; the keystroke that keeps the script moving is what the presenter
  // needs in the second they are reading this, and the repair keeps until they
  // are off camera.
  //
  // All five say "start or stop", because `A` is a TOGGLE and none of these
  // can promise which way it will move.
  //
  // `STT_ENGINE_ERROR` is the obvious case: it fires arbitrarily deep into a
  // take, and auto-scroll pauses following without pausing transcription, so
  // the recogniser can die with the transport already running. The other four
  // look like cold-start failures where `startLiveSession` has just set
  // `running: false` — but `resume()` re-enters `start()` after a hard pause
  // released the capture, and `autoScroll.running` deliberately survives a
  // pause. A → hard pause → resume is enough to reach any of them with the
  // transport armed, and telling that presenter to "start" auto-scroll would
  // stop their script. "Start or stop" is also the wording Settings and Live
  // already use for this key.
  //
  // "the requested language", not "the selected language". The picker raises
  // this BEFORE `update_settings`, and `activate()` says so in its own comment:
  // the write failed, so nothing changed and the old language is still the
  // selected one — whose model is installed, or the screen could not have been
  // reached. "Selected" would have put the alert in contradiction with the
  // "currently using" line directly above it. A language can be requested and
  // refused; that is exactly what happened on all three surfaces.
  STT_MODEL_NOT_INSTALLED:
    'The speech model for the requested language is not installed. In a take, press A to start or stop auto-scroll. Download it in Settings → Speech to follow your voice.',
  STT_MODEL_MISSING:
    'The speech model files could not be found. In a take, press A to start or stop auto-scroll. Download the model again in Settings → Speech.',
  // Not "remove the model, then download it again": Settings offers Remove only
  // for a model this machine DOWNLOADED, and a load failure can also come from
  // a bundled or `CANDIDCUE_MODELS_DIR` copy that has no Remove button to press.
  // Download is offered whenever a model is not usable, so it is the half of
  // that pair which is always there to follow.
  STT_MODEL_LOAD_FAILED:
    'The speech model could not be loaded. In a take, press A to start or stop auto-scroll. Restart CandidCue; if this keeps happening, download the model again in Settings → Speech.',
  // Found BEFORE the load, which is the point (#258): a damaged graph handed to
  // the recogniser used to abort the app at the top of every take. No restart
  // clause, unlike `STT_MODEL_LOAD_FAILED` — the files are what is wrong, and a
  // restart reads the same files.
  STT_MODEL_DAMAGED:
    'The speech model files on this computer are damaged. In a take, press A to start or stop auto-scroll. Download the model again in Settings → Speech.',
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

  /* -- transcription transport -------------------------------------------- */
  //
  // `REALTIME_CONNECT_FAILED`, `REALTIME_PROVIDER_ERROR` and
  // `REALTIME_CONFIG_REJECTED` used to be here. They described a hosted
  // recogniser reached over a websocket — a firewall to check, a provider to
  // be down, a session to configure. Transcription is on-device: there is no
  // connection to open and no provider to report anything, so copy telling a
  // presenter to check their VPN describes a failure that cannot occur.
  //
  // The three that remain keep their codes — the session store still raises
  // them — but their copy now describes the recogniser that actually exists.
  // A presenter told to check their internet connection about an ONNX graph
  // failing to start goes and looks at their router.
  REALTIME_NEGOTIATION_FAILED:
    'CandidCue could not start the speech recogniser for this take. Try starting the take again; if it keeps failing, reinstall the language in Settings › Speech.',
  REALTIME_CONNECTION_LOST:
    'The speech recogniser stopped during the take. Start voice following again; if it keeps stopping, restart CandidCue.',
  REALTIME_NO_TRANSCRIPTS:
    'Your microphone is being read but no words are coming back, so following is on hold. Check that the right input is selected in Settings › Audio, then start the take again.',

  /* -- scripts ------------------------------------------------------------ */
  //
  // Not a user error in any ordinary sense: a script id is minted by Rust and
  // only ever handed back, so a malformed one means the frontend built a
  // request wrongly. Named rather than hidden — a silent generic failure on
  // this is how a broken link in the library looks like a broken script.
  INVALID_SCRIPT_ID:
    'CandidCue could not identify that script. Go back to the library and open it again.',
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
  // Window › CandidCue / Stage. Names what to do instead, because the window is
  // still there — it simply would not come forward.
  WINDOW_FOCUS_FAILED:
    'That window could not be brought forward. Switch to it from the Dock or the taskbar.',
  // File › Close Window. The window is still open and nothing was lost, so the
  // copy names the other way out rather than an error to investigate.
  WINDOW_CLOSE_FAILED: 'The window could not be closed. Quit CandidCue instead.',
  WINDOW_CLOSE_REFUSED: 'Only the main window can close itself this way.',
  // Not in APP_ERROR_CODES: raised by the window layer and by Preflight's own
  // post-show check (§52.7).


  /* -- updates ------------------------------------------------------------ */

  /* -- the database ------------------------------------------------------- */
  //
  // These reach the recovery screen rather than a toast, because the
  // application does not open when they fire. Each one names what is safe:
  // scripts are Markdown files and a database failure does not touch them,
  // which is the single most useful thing to say here.
  DATABASE_CORRUPT:
    'CandidCue’s database failed its integrity check and was not changed. Your scripts are separate Markdown files and are unaffected.',
  DATABASE_BACKUP_REQUIRED:
    'CandidCue needs to upgrade its database but could not first save a backup of it, so it made no changes. This is usually a full disk or a permissions problem in its data folder.',
  DATABASE_UNAVAILABLE:
    'CandidCue is in recovery mode because its database did not open, so this action is unavailable. Recover the database and reopen CandidCue.',
  RESTORE_FAILED:
    'The restore did not finish, and CandidCue put your previous data back. A copy of it was also kept.',

  /* -- installing a language ---------------------------------------------- */
  //
  // A download and install has more ways to fail than most things in this app,
  // and the remedies genuinely differ — which is why these are separate codes
  // rather than one "install failed".
  STT_MODEL_INSUFFICIENT_SPACE:
    'There is not enough free space to install this language. Nothing was downloaded — free some space and try again.',
  STT_MODEL_DOWNLOAD_FAILED:
    'The language could not be downloaded. Check your connection and try again; anything already transferred is kept and will resume.',
  STT_MODEL_CORRUPT:
    'The downloaded language files did not match their published checksums, so they were discarded rather than installed. Try again.',
  STT_MODEL_INSTALL_FAILED:
    'The language downloaded but could not be installed. Any version already on this machine was left in place.',
  STT_MODEL_CANCELLED:
    'The language download was cancelled. What was transferred is kept, so starting again resumes rather than restarts.',
  STT_MODEL_BUSY:
    'CandidCue is already installing or removing a language. Wait for that to finish and try again.',
  STT_MODEL_UNKNOWN:
    'CandidCue does not recognise that language. Reinstall CandidCue if this keeps happening.',
  STT_MODEL_UNSUPPORTED:
    'That language is not available in this version of CandidCue.',
  STT_MODEL_URL_INSECURE:
    'The download address for that language is not secure, so CandidCue refused it. This is a problem with the release rather than with your machine.',
  // Not the release's fault: the url is compiled in, and the fake-IP and NAT64
  // answers ordinary networks give it are accepted (#261). Mostly what is left
  // is a network pointing the name somewhere private, but a broken redirect
  // chain lands here too, so the copy names no single cause.
  STT_MODEL_URL_BLOCKED:
    'CandidCue could not safely follow the download address for that language, so it stopped. A Wi-Fi sign-in page, DNS filter or VPN can cause this: check your network settings, or try another network.',

  /* -- choosing a language ------------------------------------------------ */
  STT_LANGUAGE_CHANGE_BLOCKED:
    'The speech language cannot be changed during a take. End the take first.',
  STT_LANGUAGE_UNAVAILABLE:
    'That language is not installed on this machine. Install it in Settings › Speech first.',

  /* -- testing transcription ---------------------------------------------- */
  // Refused, not failed: the take is using the recogniser, and a test would
  // take it away from the take for good (#264).
  STT_TEST_BLOCKED_BY_TAKE:
    'Transcription cannot be tested during a take: the take is using the recogniser, and a test would stop it following you. End the take, then test again.',

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
