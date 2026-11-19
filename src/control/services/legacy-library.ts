/**
 * The CandidCue library this launch could not bring across.
 *
 * The app was CandidCue until October 2026, and Rust copies the old data
 * folder into place before anything else runs (`legacy_data.rs`). When that
 * copy fails or has been given up, the user sees an empty library while their
 * scripts are still on disk, and the log was the only place that said so.
 * Worse, the obvious next step (trying the sample on Welcome) puts a script in
 * the new library, which is what ends the automatic retry for good.
 *
 * So Rust holds what happened (`get_legacy_library_notice`) and the window
 * says it. Nothing here touches either folder: the only action is to show the
 * old one, and Rust picks the path for that.
 */
import { ipcInvoke, isTauriRuntime } from './ipc';

export interface LegacyLibraryNotice {
  /**
   * `failed`: this launch could not copy it, and the next tries again while
   * the new library holds no script. `abandoned`: an earlier copy failed, work
   * started here since, and no launch will copy it again.
   */
  kind: 'failed' | 'abandoned';
  /** Where the CandidCue library still is. For display only. */
  oldFolder: string;
  /** Why the copy failed (`failed` only). */
  reason?: string;
}

/**
 * Read Rust's answer, refusing anything that is not one.
 *
 * Fails quiet rather than closed: this is a notice, not a gate, and an answer
 * nobody can read is no reason to say something that may not be true.
 */
export function parseLegacyLibraryNotice(answer: unknown): LegacyLibraryNotice | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const { kind, oldFolder, reason } = answer as Record<string, unknown>;
  if (kind !== 'failed' && kind !== 'abandoned') return null;
  if (typeof oldFolder !== 'string' || oldFolder === '') return null;
  return typeof reason === 'string' && reason !== ''
    ? { kind, oldFolder, reason }
    : { kind, oldFolder };
}

/** `null` for a clean install, a successful copy, and a browser dev session. */
export async function getLegacyLibraryNotice(): Promise<LegacyLibraryNotice | null> {
  if (!isTauriRuntime()) return null;
  return parseLegacyLibraryNotice(await ipcInvoke<unknown>('get_legacy_library_notice'));
}

/** Show the old library in the file manager. Rust supplies the path. */
export async function revealLegacyLibrary(): Promise<void> {
  await ipcInvoke<void>('reveal_legacy_library');
}
