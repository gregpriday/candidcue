/**
 * Installing the speech model, as the control window sees it.
 *
 * The recogniser is no longer part of the app (#152). It is ~161 MB of ONNX
 * graphs fetched after installation, verified against a SHA-256 the binary
 * compiles in, and unpacked into app data. All of that happens in Rust — this
 * window's CSP allows `connect-src 'self' ipc: http://ipc.localhost` and
 * nothing else, so JavaScript here could not reach the archive host even if it
 * were the right place to do the work.
 *
 * What lives here is the thin half: ask for a status, ask for a download, and
 * listen for what Rust says about one in flight.
 *
 * WHY THE EVENT CARRIES THE WHOLE STATUS
 * --------------------------------------
 * `speech://model-progress` is not a delta. Every event is a complete
 * `SpeechModelStatus`, identical in shape to what the four commands return, so
 * a screen never has to merge "what the command said" with "what the event
 * said" — which is where a progress bar learns to disagree with the button
 * beside it. A listener assigns; it does not reconcile.
 */
import { invokeOrMock } from './ipc';

/** Where an install has got to. Mirrors Rust's `StatusPhase`. */
export type SpeechModelPhase =
  | 'notInstalled'
  | 'downloading'
  | 'verifyingArchive'
  | 'extracting'
  | 'verifyingFiles'
  | 'installing'
  | 'validating'
  | 'installed'
  | 'failed';

/** Where a usable copy came from. Mirrors Rust's `ModelSource`. */
export type SpeechModelSource = 'downloaded' | 'bundled' | 'override';

/** Mirrors Rust's `SpeechModelStatus`. */
export interface SpeechModelStatus {
  modelId: string;
  modelName: string;
  languages: string[];
  phase: SpeechModelPhase;
  source: SpeechModelSource | null;
  installed: boolean;
  /** Whether this build can load it at all, not whether it is present. */
  supported: boolean;
  downloadBytes: number;
  installedBytes: number;
  progressBytes: number;
  progressTotal: number;
  operationId: string | null;
  error: { code: string; message: string } | null;
}

export const SPEECH_MODEL_PROGRESS_EVENT = 'speech://model-progress';

/**
 * The phases during which something is actually happening.
 *
 * Named rather than inferred from `progressBytes`, because two of them
 * (`installing`, `validating`) legitimately report no bytes at all and a
 * byte-based test would call them idle.
 */
const BUSY_PHASES: readonly SpeechModelPhase[] = [
  'downloading',
  'verifyingArchive',
  'extracting',
  'verifyingFiles',
  'installing',
  'validating',
];

export function isBusy(status: SpeechModelStatus | null): boolean {
  return status != null && BUSY_PHASES.includes(status.phase);
}

/**
 * The phases whose numbers are a real byte count.
 *
 * `installing` and `validating` measure nothing — Rust emits `(0, 1)` and
 * `(1, 1)` for them as step markers, not progress — so the fraction has to be
 * decided by the PHASE rather than by whether a total happens to be positive.
 * Testing `progressTotal > 0` looked equivalent and was not: it turned those
 * markers into 0%, 0%, 100%, which is the bar snapping back to empty at the
 * very end that this function exists to prevent.
 */
const MEASURED_PHASES: readonly SpeechModelPhase[] = [
  'downloading',
  'verifyingArchive',
  'extracting',
  'verifyingFiles',
];

/**
 * How far through, 0–1, or null when the phase has no meaningful fraction.
 *
 * Null rather than 0 for the phases that do not measure themselves: a bar
 * snapping back to empty at the end reads as "it failed and restarted", which
 * is the opposite of what happened. Null renders as an indeterminate bar.
 */
export function progressFraction(status: SpeechModelStatus | null): number | null {
  if (!status || !MEASURED_PHASES.includes(status.phase)) return null;
  if (status.progressTotal <= 0) return null;
  return Math.min(1, status.progressBytes / status.progressTotal);
}

/**
 * Whether Remove should be offered.
 *
 * Only a model this machine downloaded is ours to delete. `bundled` is inside
 * the application bundle; `override` is a developer's `CANDIDCUE_MODELS_DIR`,
 * where Remove would delete an invisible app-data copy and leave the visible
 * model exactly where it was — a button that appears to do nothing.
 *
 * A damaged download (#258) is removable too. It is not installed — nothing
 * can run on it — but its files are on disk and were put there by this app,
 * which is the whole of what makes a model ours to delete. Rust reports its
 * `source` as `downloaded` for exactly this reason.
 *
 * A rule rather than an inline condition because Settings and its tests must
 * not be able to disagree about it.
 */
export function canRemove(status: SpeechModelStatus | null): boolean {
  return status != null && !isBusy(status) && status.source === 'downloaded';
}

/** Whether Download should be offered. */
export function canDownload(status: SpeechModelStatus | null): boolean {
  return status != null && status.supported && !status.installed && !isBusy(status);
}

/** A download on this machine whose files were damaged after install (#258). */
export const MODEL_DAMAGED_CODE = 'STT_MODEL_DAMAGED';

/**
 * Whether this model was downloaded here and has since been damaged.
 *
 * Rust reports it as `failed` — the screen already offers the download beside
 * an error's message, and the download is the repair — with `source:
 * 'downloaded'` and `installed: false`, a pairing it produces for this case and
 * no other. Read from the source rather than the error code, because the error
 * is not always this one: a repair that then FAILED (no network, no space)
 * reports its own failure, and the files on disk are no less damaged for it.
 */
export function isDamaged(status: SpeechModelStatus | null): boolean {
  return status != null && !status.installed && status.source === 'downloaded';
}

/** What the user is told is happening, per phase. */
export function phaseLabel(status: SpeechModelStatus): string {
  switch (status.phase) {
    case 'downloading':
      return 'Downloading';
    // Named separately from "Downloading" on purpose: the transfer hits 100%
    // and then hashing and decompressing ~161 MB take real time. A bar that
    // sat full and silent through that is the single most confusing thing
    // this process can do.
    case 'verifyingArchive':
      return 'Checking the download';
    case 'extracting':
      return 'Unpacking';
    case 'verifyingFiles':
      return 'Checking the files';
    case 'installing':
      return 'Installing';
    case 'validating':
      return 'Finishing up';
    case 'installed':
      return 'Installed';
    case 'failed':
      return 'Failed';
    case 'notInstalled':
      return 'Not installed';
  }
}

/** A byte count a person can read. Deliberately coarse — this is a size, not a measurement. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * The status the browser mock reports when there is no Rust to ask.
 *
 * `invokeOrMock` rather than `ipcInvoke`, because Settings has to render
 * something in plain-browser dev and "Checking…" forever is not it.
 */
export async function getSpeechModelStatus(modelId?: string): Promise<SpeechModelStatus> {
  const { mockSpeechModels } = await import('./mock-backend');
  return invokeOrMock<SpeechModelStatus>('get_speech_model_status', { modelId }, () =>
    mockSpeechModels.status(),
  );
}

/**
 * Start the download, or join the one already running.
 *
 * Idempotent in Rust: a second press returns the running job's status rather
 * than opening a second transfer into the same partial file.
 */
export async function startSpeechModelDownload(modelId?: string): Promise<SpeechModelStatus> {
  const { mockSpeechModels } = await import('./mock-backend');
  return invokeOrMock<SpeechModelStatus>('start_speech_model_download', { modelId }, () =>
    mockSpeechModels.start(),
  );
}

/** Stop a running download. What has transferred so far is kept for a resume. */
export async function cancelSpeechModelDownload(modelId?: string): Promise<SpeechModelStatus> {
  const { mockSpeechModels } = await import('./mock-backend');
  return invokeOrMock<SpeechModelStatus>('cancel_speech_model_download', { modelId }, () =>
    mockSpeechModels.cancel(),
  );
}

/** Remove the downloaded model, and any partial download of it. */
export async function deleteSpeechModel(modelId?: string): Promise<SpeechModelStatus> {
  const { mockSpeechModels } = await import('./mock-backend');
  return invokeOrMock<SpeechModelStatus>('delete_speech_model', { modelId }, () =>
    mockSpeechModels.remove(),
  );
}

/**
 * Listen for install progress. Returns an unsubscribe.
 *
 * Resolves to a no-op outside Tauri: browser dev has no event bus, and a
 * caller should not have to know that to be able to clean up.
 */
export async function onSpeechModelProgress(
  handler: (status: SpeechModelStatus) => void,
): Promise<() => void> {
  const { isTauriRuntime } = await import('./ipc');
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<SpeechModelStatus>(SPEECH_MODEL_PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
  return () => void unlisten();
}

/** Preload is not offered for a model that is not there — say so precisely. */
export const MODEL_NOT_INSTALLED_CODE = 'STT_MODEL_NOT_INSTALLED';

/* ------------------------------------------------------------ language choice
 *
 * §153: the user picks a LANGUAGE. Which model serves it is an implementation
 * detail of that choice, which is why everything above this line is addressed
 * by `modelId` and everything below it by a language tag.
 */

/** Refused because a take is open. The recogniser cannot change mid-session. */
export const LANGUAGE_CHANGE_BLOCKED_CODE = 'STT_LANGUAGE_CHANGE_BLOCKED';
/** Refused because this build cannot follow that language at all. */
export const LANGUAGE_UNAVAILABLE_CODE = 'STT_LANGUAGE_UNAVAILABLE';

/** Where a model's bytes come from. Mirrors Rust's `SpeechDownloadOrigin`. */
export interface SpeechDownloadOrigin {
  kind: 'mirror' | 'upstream';
  /** Host only — the digest path in a mirror URL means nothing to a reader. */
  host: string;
}

/**
 * The licence a model travels under.
 *
 * Shown, never gated on. §153 is explicit: this is an attribution obligation
 * the app carries, not a decision to put in front of the user, so there is no
 * accept step anywhere in this flow.
 */
export interface SpeechModelAttribution {
  title: string;
  author: string;
  sourceUrl: string;
  distributedVia: string | null;
  license: { id: string; name: string; url: string };
  licenseNote: string | null;
  modified: boolean;
}

/**
 * One language the user may choose. Mirrors Rust's `SpeechLanguageOption`.
 *
 * Only languages this build can actually follow are ever returned — Rust does
 * the three-way join (catalogue × recogniser × alignment engine) and a language
 * that fails any part of it is absent rather than disabled.
 */
export interface SpeechLanguageOption {
  /** The BCP-47 tag persisted if this is activated, e.g. `en-US`. */
  languageTag: string;
  /** Its primary subtag, e.g. `en`. */
  primarySubtag: string;
  /** The SHORT catalogue id — what every install command is addressed with. */
  modelId: string;
  /** The LONG recogniser id — what settings persists. Not interchangeable. */
  recognizerId: string;
  active: boolean;
  status: SpeechModelStatus;
  origins: SpeechDownloadOrigin[];
  attribution: SpeechModelAttribution;
}

/** The persisted choice. Mirrors Rust's `SpeechActiveLanguage`. */
export interface SpeechActiveLanguage {
  languageTag: string;
  primarySubtag: string;
  modelId: string | null;
  recognizerId: string;
}

/** Mirrors Rust's `SpeechLanguageOptions`. */
export interface SpeechLanguageOptions {
  active: SpeechActiveLanguage;
  /** Whether a take is open, so activation is refused right now. */
  changeBlocked: boolean;
  /** Followable languages ONLY. */
  languages: SpeechLanguageOption[];
  /** Models on disk backing no offered language — here so disk can be freed. */
  removable: SpeechModelStatus[];
}

/**
 * Everything the picker paints, in one call.
 *
 * One command rather than "list the languages, then ask about each model": a
 * row cannot be rendered without both halves, and splitting them would give the
 * sizes and the install state separate chances to go stale.
 */
export async function getSpeechLanguageOptions(): Promise<SpeechLanguageOptions> {
  const { mockSpeechModels } = await import('./mock-backend');
  return invokeOrMock<SpeechLanguageOptions>('get_speech_language_options', {}, () =>
    mockSpeechModels.languageOptions(),
  );
}

/**
 * Commit to a language.
 *
 * Writes the language and the recogniser together in Rust — they are one
 * choice, and persisting them separately is how a session ends up declaring one
 * language while the settings screen shows another.
 *
 * `ipcInvoke`, not `invokeOrMock`: a browser-dev mock that pretended a language
 * change had been saved would be lying about the one thing this command exists
 * to do.
 */
export async function selectSpeechLanguage(
  expectedRevision: number,
  languageTag: string,
): Promise<unknown> {
  const { ipcInvoke } = await import('./ipc');
  return ipcInvoke('select_speech_language', { input: { expectedRevision, languageTag } });
}

/**
 * Fold a snapshot into what is already known, per model.
 *
 * THE RULE, and why it is keyed rather than global. A status request and the
 * event stream race: a snapshot can be issued while an install is validating,
 * the install can finish and emit its terminal event, and the older reply can
 * then land on top and strand the panel on a phase that is over. #152 solved
 * that for one model with a single counter — "discard the snapshot if anything
 * arrived while it was pending".
 *
 * Carrying that counter over unchanged would be a NEW bug: with several models
 * installable at once, a progress event for model A would discard a perfectly
 * good snapshot for model B, which had not moved at all. So the comparison is
 * per model, and a snapshot row is accepted only if THAT model's count is
 * unchanged.
 *
 * Pure and exported so it can be pinned without a webview — the same reason
 * `isBusy`, `canRemove` and `progressFraction` live out here rather than inside
 * the component that renders them.
 */
export function reconcileModelStatuses(
  current: Record<string, SpeechModelStatus>,
  seen: Record<string, number>,
  now: Record<string, number>,
  incoming: SpeechModelStatus[],
): Record<string, SpeechModelStatus> {
  const merged = { ...current };
  for (const row of incoming) {
    if ((now[row.modelId] ?? 0) === (seen[row.modelId] ?? 0)) merged[row.modelId] = row;
  }
  return merged;
}

/**
 * The display name for a language tag, in the reader's own locale.
 *
 * `Intl.DisplayNames` rather than a table in this repository: the names are a
 * fact about human languages, not about CandidCue, and a hand-kept list would
 * be one more thing to translate. Falls back to the tag itself where the
 * runtime has no name for it — a bare `en` is a worse label than "English" and
 * a better one than nothing.
 */
export function languageDisplayName(tag: string): string {
  try {
    const names = new Intl.DisplayNames(undefined, { type: 'language' });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * Open a speech model's licence page.
 *
 * Rust checks the url against the licence urls the model catalogue itself
 * declares, which is why the control capability no longer grants
 * `opener:default`. §153 makes attribution an obligation the app carries
 * rather than a decision to put in front of the user, so this is not gated on
 * anything — it is the same link, opened safely.
 */
export async function openModelLicence(url: string): Promise<void> {
  await invokeOrMock<void>('open_model_licence', { url }, () => undefined);
}
