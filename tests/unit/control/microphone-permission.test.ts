/**
 * The OS's answer about the microphone, and the way to change it (#303).
 *
 * The read feeds the readiness check before every take, so the property that
 * matters most is that it can never fail the check: a permission that cannot
 * be READ is unknown, not refused, and not an error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import {
  isMicrophoneRefused,
  openMicrophoneSettings,
  readMicrophonePermission,
} from '../../../src/control/services/microphone-permission';

afterEach(() => {
  setInvokeForTesting(null);
});

describe('readMicrophonePermission', () => {
  it('asks Rust, with no arguments', async () => {
    const invoke = vi.fn(async () => 'denied');
    setInvokeForTesting(invoke as never);
    await expect(readMicrophonePermission()).resolves.toBe('denied');
    expect(invoke).toHaveBeenCalledWith('get_microphone_permission', undefined);
  });

  it('is unknown, never a failure, when the read fails', async () => {
    setInvokeForTesting((async () => {
      throw { code: 'INTERNAL', message: 'boom' };
    }) as never);
    await expect(readMicrophonePermission()).resolves.toBe('unsupported');
  });

  it('is unknown outside the desktop app', async () => {
    // No Tauri runtime in node: the mock answer, which says nothing.
    await expect(readMicrophonePermission()).resolves.toBe('unsupported');
  });
});

describe('openMicrophoneSettings', () => {
  it('names no destination — the pane is Rust’s constant', async () => {
    const invoke = vi.fn(async () => undefined);
    setInvokeForTesting(invoke as never);
    await openMicrophoneSettings();
    expect(invoke).toHaveBeenCalledWith('open_microphone_settings', undefined);
  });

  it('rejects rather than pretending it opened', async () => {
    setInvokeForTesting((async () => {
      throw { code: 'NOT_IMPLEMENTED', message: 'no pane' };
    }) as never);
    await expect(openMicrophoneSettings()).rejects.toBeTruthy();
  });
});

describe('isMicrophoneRefused', () => {
  it('is a refusal by the user or by policy, and nothing else', () => {
    expect(isMicrophoneRefused('denied')).toBe(true);
    expect(isMicrophoneRefused('restricted')).toBe(true);
    expect(isMicrophoneRefused('prompt')).toBe(false);
    expect(isMicrophoneRefused('granted')).toBe(false);
    expect(isMicrophoneRefused('unsupported')).toBe(false);
  });
});
