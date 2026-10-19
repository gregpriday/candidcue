/**
 * The update commands, through the IPC funnel (docs/updates.md).
 *
 * Thin by design. Everything that decides whether a check or an install may
 * happen — the endpoint, the channel, the signature, no install during a take,
 * no automatic check when the user turned them off — is decided in Rust
 * (`src-tauri/src/updater.rs`). This file only asks, and reads the answer
 * defensively.
 */
import {
  UPDATE_PROGRESS_EVENT,
  parseUpdateCheckResult,
  parseUpdateProgress,
  type UpdateCheckResult,
  type UpdateProgress,
} from '../../shared/contracts/updates';
import { DEV_APP_VERSION } from '../../shared/version';
import { invokeOrMock, ipcInvoke, isTauriRuntime } from './ipc';

/**
 * Ask Rust whether a newer CandidCue is available.
 *
 * `automatic` marks the scheduled check. Rust refuses one of those outright
 * when "Check for updates automatically" is off (`UPDATE_CHECK_DISABLED`); a
 * manual check always runs.
 */
export async function checkForUpdate(options: { automatic: boolean }): Promise<UpdateCheckResult> {
  const raw = await invokeOrMock<unknown>(
    'check_for_update',
    { automatic: options.automatic },
    async () => (await import('./mock-backend')).mockUpdates.check(DEV_APP_VERSION),
  );
  const parsed = parseUpdateCheckResult(raw);
  if (parsed === null) {
    throw new Error('The update server’s answer could not be read.');
  }
  return parsed;
}

/**
 * Download, verify and install what the last check found, then restart.
 *
 * Resolves only if the app is about to restart — on Windows the installer
 * closes the app before it can resolve at all. Rejects with Rust's own refusal
 * during a take, on a copy that cannot replace itself, or when the download or
 * its signature check fails.
 */
export async function installUpdate(): Promise<void> {
  await ipcInvoke('install_update');
}

/**
 * Follow an install's progress. Returns a teardown; outside Tauri there is
 * nothing to follow.
 */
export function listenForUpdateProgress(onProgress: (progress: UpdateProgress) => void): () => void {
  if (!isTauriRuntime()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const stop = await listen<unknown>(UPDATE_PROGRESS_EVENT, (event) => {
        const progress = parseUpdateProgress(event.payload);
        if (progress !== null) onProgress(progress);
      });
      if (disposed) stop();
      else unlisten = stop;
    } catch (err) {
      console.debug('update progress is not connected', err);
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
  };
}
