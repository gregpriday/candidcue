/**
 * Cross-screen actions shared by the sidebar, welcome screen, library, and
 * keyboard shortcuts.
 */
import * as scriptsService from '../services/scripts';
import { markWelcomed } from '../stores/app-status';
import { loadLibrary } from '../stores/library';
import { navigate } from '../stores/router';
import { showToast } from '../stores/toasts';
import {
  NEW_SCRIPT_SOURCE,
  NEW_SCRIPT_TITLE,
  SAMPLE_SCRIPT_SOURCE,
  SAMPLE_SCRIPT_TITLE,
} from './sample-script';
import { isTauriRuntime } from '../services/ipc';
import type { ExportFormat } from '../services/scripts-types';

/** Create a script (blank example or sample) and open the editor. */
export async function createAndOpenScript(kind: 'new' | 'sample' = 'new'): Promise<void> {
  const doc = await scriptsService.createScript(
    kind === 'sample'
      ? { title: SAMPLE_SCRIPT_TITLE, source: SAMPLE_SCRIPT_SOURCE }
      : { title: NEW_SCRIPT_TITLE, source: NEW_SCRIPT_SOURCE },
  );
  markWelcomed();
  await loadLibrary();
  await navigate({ name: 'editor', scriptId: doc.id });
}

/**
 * Import a Markdown file; the file name becomes the initial title (§13.1).
 *
 * The picker no longer runs here. Rust shows it and imports the chosen file in
 * one operation, so no path ever crosses IPC — the control webview cannot name
 * a file to read (spec §50.7). A `null` result means the operator cancelled.
 */
export async function importMarkdown(): Promise<void> {
  try {
    const result = await scriptsService.importScript();
    if (result === null) return; // cancelled
    markWelcomed();
    await loadLibrary();
    for (const warning of result.warnings) showToast(warning, 'info');
    await navigate({ name: 'editor', scriptId: result.script.id });
  } catch (err) {
    showToast(`Import failed: ${String(err)}`, 'danger');
  }
}

/** Open a URL in the system browser (never inside the app webview). */
export async function openExternal(url: string): Promise<void> {
  if (isTauriRuntime()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      // fall through
    }
  }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
}

/**
 * Export a script (spec §21.6).
 *
 * Rust shows the save dialog and writes the file in the same operation, so no
 * destination crosses IPC. The old flow picked the destination here and passed
 * it back, which meant an arbitrary absolute path reached `File::create` and
 * truncated whatever was there (spec §50.7). `title` now only seeds the
 * dialog's default file name.
 */
export async function exportScriptToFile(
  scriptId: string,
  title: string,
  format: ExportFormat = 'markdown',
): Promise<void> {
  try {
    const result = await scriptsService.exportScript(scriptId, {
      format,
      includeAssets: format !== 'text',
      suggestedName: title,
    });
    if (result === null) return; // cancelled
    for (const warning of result.warnings) showToast(warning, 'info');
    showToast('Script exported', 'success');
  } catch (err) {
    showToast(`Export failed: ${String(err)}`, 'danger');
  }
}
