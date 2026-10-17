/**
 * The operating system's answer about the microphone, and the way to change it
 * (#303).
 *
 * macOS asks once per application. After a refusal `getUserMedia` fails at once
 * with no prompt, and the only remedy is the Microphone list in System Settings
 * › Privacy & Security. The webview cannot see that answer — WKWebView does not
 * implement `navigator.permissions.query({ name: 'microphone' })` — so Rust
 * reads it (`get_microphone_permission`) and opens the pane
 * (`open_microphone_settings`). See `src-tauri/src/commands/microphone_cmds.rs`.
 */
import type { MicrophonePermission } from '../../shared/contracts';
import { invokeOrMock, ipcInvoke } from './ipc';

/**
 * Read the microphone permission. Never prompts, and never throws.
 *
 * Safe at launch and before every take (§28.1): the read is passive. Any
 * failure — browser dev, an older backend, a platform that cannot say — is
 * `unsupported`, which callers treat as unknown. A readiness check that failed
 * because the permission could not be READ would turn a question into a gate.
 */
export async function readMicrophonePermission(): Promise<MicrophonePermission> {
  try {
    return await invokeOrMock<MicrophonePermission>(
      'get_microphone_permission',
      undefined,
      () => 'unsupported',
    );
  } catch {
    return 'unsupported';
  }
}

/**
 * Open the OS microphone privacy pane.
 *
 * Rejects outside the desktop app and on platforms with no such pane; callers
 * report that rather than pretend System Settings opened.
 */
export async function openMicrophoneSettings(): Promise<void> {
  await ipcInvoke('open_microphone_settings');
}

/** The OS has said no — by the user, or by policy. */
export function isMicrophoneRefused(permission: MicrophonePermission): boolean {
  return permission === 'denied' || permission === 'restricted';
}
