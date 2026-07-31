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
 * A rule rather than an inline condition because Settings and its tests must
 * not be able to disagree about it.
 */
export function canRemove(status: SpeechModelStatus | null): boolean {
  return status != null && status.installed && !isBusy(status) && status.source === 'downloaded';
}

/** Whether Download should be offered. */
export function canDownload(status: SpeechModelStatus | null): boolean {
  return status != null && status.supported && !status.installed && !isBusy(status);
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
