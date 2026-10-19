/**
 * Opening Settings, from anywhere in the control window (§14.1).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `navigate({ name: 'settings' })` ANY MORE
 * ---------------------------------------------------------------------------
 * Settings is a WINDOW now, and the control window no longer renders that
 * route. The two places that still navigated to it — Live's "the follower has
 * degraded, adjust it" notice and Welcome's privacy link — did not fail
 * loudly: `App.svelte` falls through to the Library for a route it cannot
 * render, so choosing either quietly dumped the user in the script list.
 *
 * The section reaches the other window two ways, and both are needed:
 *
 *   - written to the workspace store and FLUSHED, because that store is
 *     `localStorage` — shared between webviews of one origin — and the Settings
 *     window reads it on mount. The flush matters: writes are debounced by
 *     250 ms and the window mounts faster than that, so without it "Settings ›
 *     Privacy" opened on whichever section was last visited;
 *   - broadcast, because a window that is ALREADY open does not mount again,
 *     and Rust's single-instance rule means asking for it merely brings it
 *     forward.
 */
import { emitSettingsSection } from '../services/settings-sync';
import { openPreferences } from '../services/desktop-shell';
import { describeError } from '../services/errors';
import { openMicrophoneSettings } from '../services/microphone-permission';
import { osCopy } from './os-copy';
import type { SettingsSection } from '../stores/router';
import { showToast } from '../stores/toasts';
import { flushWorkspace, updateWorkspace } from '../stores/workspace';

export async function openSettingsWindow(section?: SettingsSection): Promise<void> {
  if (section) {
    updateWorkspace({ settingsSection: section });
    flushWorkspace();
    void emitSettingsSection(section);
  }
  try {
    await openPreferences();
  } catch (err) {
    showToast(`Settings could not be opened. ${describeError(err)}`, 'danger');
  }
}

/**
 * The OS microphone privacy pane — the one place a refused microphone can be
 * allowed again (#303). Every surface that reports a refusal offers this.
 *
 * Failure is said, not swallowed: a button that silently does nothing is the
 * dead end this exists to remove, and the copy still names the path by hand.
 */
export async function openMicrophonePrivacySettings(): Promise<void> {
  try {
    await openMicrophoneSettings();
  } catch (err) {
    showToast(`${osCopy().openMicrophoneSettingsFailed} ${describeError(err)}`, 'danger');
  }
}
