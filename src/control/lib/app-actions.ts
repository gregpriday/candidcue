/**
 * Cross-screen actions shared by the sidebar, welcome screen, library, and
 * keyboard shortcuts.
 */
import { describeError } from '../services/errors';
import * as scriptsService from '../services/scripts';
import { markWelcomed } from '../stores/app-status';
import { loadLibrary } from '../stores/library';
import { navigate } from '../stores/router';
import { showToast } from '../stores/toasts';
import { flushEditorEdits } from '../stores/editor';
import { NEW_SCRIPT_TITLE, SAMPLE_SCRIPT_SOURCE, SAMPLE_SCRIPT_TITLE } from './sample-script';
import type { ExportFormat } from '../services/scripts-types';

/**
 * Create a script (blank or the read-aloud sample) and open the editor.
 *
 * This is the welcome screen's primary call to action, so a failure here is the
 * first thing a new operator can hit. It used to reject out of the click
 * handler as an unhandled rejection — no toast, no navigation, nothing to read.
 * The failure is reported here rather than rethrown because no caller inspects
 * the result; every one of them fires this and forgets it.
 *
 * The blank arm sends an empty body on purpose. The editor's placeholder is the
 * guidance now, so there is nothing to select and delete before writing.
 */
export async function createAndOpenScript(kind: 'new' | 'sample' = 'new'): Promise<void> {
  try {
    const doc = await scriptsService.createScript(
      kind === 'sample'
        ? { title: SAMPLE_SCRIPT_TITLE, source: SAMPLE_SCRIPT_SOURCE }
        : { title: NEW_SCRIPT_TITLE, source: '' },
    );
    markWelcomed();
    await loadLibrary();
    await navigate({ name: 'editor', scriptId: doc.id });
  } catch (err) {
    showToast(`Could not create that script. ${describeError(err)}`, 'danger');
  }
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
    showToast(`Could not import that file. ${describeError(err)}`, 'danger');
  }
}

/*
 * No `openExternal`.
 *
 * There used to be one here: a helper that took a URL, tried
 * `@tauri-apps/plugin-opener`, and fell back to `window.open`. It had exactly
 * one importer, App.svelte, which never called it — and it could not have
 * worked anyway, because the 1.0 readiness pass removed the `opener:default`
 * grant from the control capability, so the plugin call would have thrown and
 * the fallback would have tried to navigate a webview whose CSP forbids remote
 * origins.
 *
 * What replaced it is `openWebDestination` in `services/desktop-shell.ts`: the
 * frontend names a DESTINATION and `src-tauri/src/web.rs` owns the URL. Nothing
 * in this window should grow a function that takes a URL again.
 */

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
    await flushEditorEdits(scriptId);
    const result = await scriptsService.exportScript(scriptId, {
      format,
      includeAssets: format !== 'text',
      suggestedName: title,
    });
    if (result === null) return; // cancelled
    for (const warning of result.warnings) showToast(warning, 'info');
    showToast('Script exported', 'success');
  } catch (err) {
    showToast(`Could not export that script. ${describeError(err)}`, 'danger');
  }
}
