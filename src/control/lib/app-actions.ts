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

/** Import a Markdown file; the file name becomes the initial title (§13.1). */
export async function importMarkdown(): Promise<void> {
  let sourcePath: string | undefined;
  if (isTauriRuntime()) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'candidcue'] }],
      });
      if (picked === null) return; // user cancelled
      sourcePath = Array.isArray(picked) ? picked[0] : picked;
    } catch {
      // Dialog plugin unavailable — fall through to the service default.
    }
  }
  if (sourcePath === undefined) {
    // Rust needs an absolute path from the picker; there is nothing to import
    // without one, and sending an empty payload only produces a Serde error.
    if (isTauriRuntime()) return;
    sourcePath = 'Imported script.md';
  }
  try {
    const result = await scriptsService.importScript({ path: sourcePath });
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
 * Export a script (spec §21.6). Rust requires an absolute destination and one
 * of its three format names, so the save dialog and the command have to be
 * driven together — an export with no destination cannot succeed.
 */
export async function exportScriptToFile(
  scriptId: string,
  title: string,
  format: ExportFormat = 'markdown',
): Promise<void> {
  const extension = format === 'bundle' ? 'candidcue' : format === 'text' ? 'txt' : 'md';
  const safeTitle = title.trim().replace(/[/\\:*?"<>|]/g, '-') || 'script';
  let destination: string | undefined;

  if (isTauriRuntime()) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const picked = await save({
        defaultPath: `${safeTitle}.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (picked === null) return; // user cancelled
      destination = picked;
    } catch (err) {
      showToast(`Export failed: ${String(err)}`, 'danger');
      return;
    }
  }
  if (destination === undefined) destination = `${safeTitle}.${extension}`;

  try {
    const result = await scriptsService.exportScript(scriptId, {
      destination,
      format,
      includeAssets: format !== 'text',
    });
    for (const warning of result.warnings) showToast(warning, 'info');
    showToast('Script exported', 'success');
  } catch (err) {
    showToast(`Export failed: ${String(err)}`, 'danger');
  }
}
