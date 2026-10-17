/**
 * The readiness sheet's microphone rows carry their own way out (#303).
 *
 * A refused microphone used to be found only after Present had turned the
 * window into the prompter. The sheet now says so first — and a row that
 * names System Settings without opening it, or a refusal fixed there with no
 * way to say "check again", would be the dead end moved one screen earlier.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({
  privacy: vi.fn(async () => {}),
  settings: vi.fn(async () => {}),
}));

vi.mock('../../src/control/lib/open-settings', () => ({
  openMicrophonePrivacySettings: opened.privacy,
  openSettingsWindow: opened.settings,
}));

import TakeReadinessSheet from '../../src/control/components/TakeReadinessSheet.svelte';
import { resolveReadiness, type ReadinessInput } from '../../src/control/lib/take-readiness';

function verdict(micPermission: ReadinessInput['micPermission']) {
  return resolveReadiness({
    voiceTake: true,
    modelInstalled: true,
    modelSupported: true,
    pinnedMicLabel: null,
    pinnedMicAvailable: true,
    spokenWordCount: 800,
    blockingDiagnostics: 0,
    destinationMismatch: null,
    requested: false,
    micPermission,
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
}

describe('the readiness sheet for a refused microphone', () => {
  it('opens the privacy pane, and asks again beside it', async () => {
    const onallowmicrophone = vi.fn(async () => {});
    render(TakeReadinessSheet, {
      props: {
        verdict: verdict('denied'),
        onstart: () => {},
        onallowmicrophone,
        onclose: () => {},
      },
    });

    await fireEvent.click(button('Open System Settings')!);
    expect(opened.privacy).toHaveBeenCalledTimes(1);
    // Not the app's own Settings window: that has no switch for this.
    expect(opened.settings).not.toHaveBeenCalled();

    // A real request, not a re-read: only that can tell an allowed switch from
    // an app that is still refused until it is reopened.
    await fireEvent.click(button('Try again')!);
    expect(onallowmicrophone).toHaveBeenCalledTimes(1);
    // A warning, so going past it stays possible.
    expect(button('Start anyway')).toBeDefined();
  });
});

describe('the readiness sheet for a microphone never asked for', () => {
  it('asks from the sheet, once at a time', async () => {
    let answer!: () => void;
    const onallowmicrophone = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    render(TakeReadinessSheet, {
      props: {
        verdict: verdict('prompt'),
        onstart: () => {},
        onallowmicrophone,
        onclose: () => {},
      },
    });

    const allow = button('Allow microphone')!;
    await fireEvent.click(allow);
    expect(onallowmicrophone).toHaveBeenCalledTimes(1);
    // The OS prompt can stay up as long as the user takes; a second click
    // must not queue a second request behind it.
    expect(allow.disabled).toBe(true);
    await fireEvent.click(allow);
    expect(onallowmicrophone).toHaveBeenCalledTimes(1);

    answer();
    await vi.waitFor(() => expect(allow.disabled).toBe(false));
  });
});
