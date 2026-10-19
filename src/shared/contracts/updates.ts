/**
 * The update contract between Rust (`src-tauri/src/updater.rs`) and the control
 * window (docs/updates.md).
 *
 * Two commands and one event, and that is the whole surface:
 *
 *   `check_for_update { automatic }`  → `UpdateCheckResult`
 *   `install_update`                  → nothing; the app restarts on success
 *   `update://progress`               ← `UpdateProgress`, while installing
 *
 * Neither command takes a URL, a version or a signature. The endpoint and the
 * public key are compiled into the binary, and an install installs exactly what
 * Rust's own last check found. Rust also refuses an install during a take
 * (`UPDATE_BLOCKED_BY_TAKE`), whatever the UI believed.
 *
 * `updater.rs` `include_str!`s this file and fails if the event name below is
 * spelled differently there; keep it a plain literal.
 */

/** Rust → control: an install's download, install and restart. */
export const UPDATE_PROGRESS_EVENT = 'update://progress';

/**
 * What a check found.
 *
 * `available: false` is both "this is the newest version" and "nothing has been
 * published on this build's channel yet"; neither is an error.
 */
export type UpdateCheckResult =
  | { available: false; currentVersion: string }
  | {
      available: true;
      currentVersion: string;
      version: string;
      /** The release notes the manifest carries, if any. */
      notes?: string;
      /** The manifest's `pub_date` (RFC 3339), if any. */
      date?: string;
      /**
       * False when this copy cannot replace itself — a Linux package install,
       * a development build, an app macOS is running from a quarantined
       * download. The UI offers the download page instead of installing.
       */
      canInstall: boolean;
    };

/** One step of an install, as the control window draws it. */
export type UpdateProgress =
  | {
      phase: 'downloading';
      downloaded: number;
      /** Absent when the server sent no length. */
      total: number | null;
    }
  | { phase: 'installing' }
  | { phase: 'restarting' };

/**
 * Read an `UpdateCheckResult` off the wire defensively. A shape this build does
 * not recognise is reported as "nothing available" rather than trusted: the
 * worst outcome of that is a missed notice, where trusting it could put a
 * notice for `undefined` in front of somebody.
 */
export function parseUpdateCheckResult(value: unknown): UpdateCheckResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['currentVersion'] !== 'string') return null;
  const currentVersion = candidate['currentVersion'];
  if (candidate['available'] !== true) return { available: false, currentVersion };
  const version = candidate['version'];
  if (typeof version !== 'string' || version.trim() === '') return null;
  const notes = candidate['notes'];
  const date = candidate['date'];
  return {
    available: true,
    currentVersion,
    version,
    ...(typeof notes === 'string' && notes.trim() !== '' ? { notes } : {}),
    ...(typeof date === 'string' && date !== '' ? { date } : {}),
    canInstall: candidate['canInstall'] === true,
  };
}

/** Read an `UpdateProgress` payload, or `null` for one this build does not know. */
export function parseUpdateProgress(value: unknown): UpdateProgress | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  switch (candidate['phase']) {
    case 'downloading': {
      const downloaded = candidate['downloaded'];
      const total = candidate['total'];
      if (typeof downloaded !== 'number' || !Number.isFinite(downloaded)) return null;
      return {
        phase: 'downloading',
        downloaded,
        total: typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null,
      };
    }
    case 'installing':
      return { phase: 'installing' };
    case 'restarting':
      return { phase: 'restarting' };
    default:
      return null;
  }
}
