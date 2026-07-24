/**
 * System diagnostics and support bundle (spec §44.11, §46.8).
 *
 * `get_system_diagnostics` and `export_support_bundle` were both implemented
 * in Rust with no TypeScript caller, so the one screen a user is asked to
 * consult when something is wrong did not exist.
 *
 * As with the revision service, there is deliberately no mock fallback: an
 * invented diagnostics report is worse than none, because its whole purpose is
 * to be believed. Outside Tauri the caller gets `BackendUnavailableError` and
 * the panel says so.
 */
import { ipcInvoke } from './ipc';
import type { SystemDiagnostics } from '../lib/diagnostics-format';

export type { SystemDiagnostics };

export async function getSystemDiagnostics(): Promise<SystemDiagnostics> {
  return ipcInvoke<SystemDiagnostics>('get_system_diagnostics');
}

/**
 * Write a support bundle to a folder the operator chooses.
 *
 * Rust runs the folder picker itself and returns `null` when the operator
 * cancels — the same shape as `export_all_data`, and for the same reason: the
 * dialog plugin is not granted to JavaScript, so a `destination` argument
 * could never have been supplied by this side (C5). There is no path in the
 * payload; there is no payload at all.
 */
export async function exportSupportBundle(): Promise<{ path?: string; cancelled: boolean }> {
  const result = await ipcInvoke<{ path: string } | null>('export_support_bundle');
  if (result === null) return { cancelled: true };
  return { path: result.path, cancelled: false };
}
