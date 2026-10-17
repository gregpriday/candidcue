/**
 * Every way of starting a take goes through one readiness check (#301).
 *
 * The check used to exist only on the editor's own Present button. File ›
 * Present, Present As, Practise, Session › Start Take, the Library and the
 * summary's Present again called `startTake` directly, so the same missing
 * model was warned about or not depending on which control was used — and the
 * editor's own answer was read once, when the script opened.
 *
 * What must NOT change is pinned alongside: a healthy setup still launches at
 * once with no sheet, and a missing model is a warning with Start anyway, never
 * a block.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, type Writable } from 'svelte/store';

const h = vi.hoisted(() => ({ startTake: vi.fn(async () => true) }));

vi.mock('../../../src/control/lib/start-take', async () => {
  const { readable } = await import('svelte/store');
  return { startTake: h.startTake, takeStarting: readable(false) };
});

/** The live model answer, set directly — its own suite covers how it is kept. */
vi.mock('../../../src/control/stores/speech-model-readiness', async () => {
  const { writable } = await import('svelte/store');
  return {
    speechModelReadiness: writable({
      known: true,
      installed: true,
      supported: true,
      damaged: false,
      installing: false,
    }),
  };
});

/** The settings document, swapped for one a test can write. */
vi.mock('../../../src/control/stores/settings', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/stores/settings')>();
  const { writable } = await import('svelte/store');
  const { defaultAppSettings } = await import('../../../src/control/services/settings-types');
  return { ...actual, settings: writable(defaultAppSettings()) };
});

import {
  checkThenStart,
  checkThenStartTake,
  dismissTakeReadiness,
  startAnyway,
  takeReadinessPrompt,
} from '../../../src/control/lib/check-then-start';
import { speechModelReadiness } from '../../../src/control/stores/speech-model-readiness';
import type { SpeechModelReadiness } from '../../../src/control/stores/speech-model-readiness';
import { settings } from '../../../src/control/stores/settings';
import {
  defaultAppSettings,
  type AppSettings,
} from '../../../src/control/services/settings-types';

const model = speechModelReadiness as unknown as Writable<SpeechModelReadiness>;
const settingsDoc = settings as unknown as Writable<AppSettings>;

const INSTALLED: SpeechModelReadiness = {
  known: true,
  installed: true,
  supported: true,
  damaged: false,
  installing: false,
};
const MISSING: SpeechModelReadiness = { ...INSTALLED, installed: false };

function findingIds(): string[] {
  return get(takeReadinessPrompt)?.verdict.findings.map((f) => f.id) ?? [];
}

beforeEach(() => {
  h.startTake.mockClear();
  dismissTakeReadiness();
  model.set(INSTALLED);
  settingsDoc.set(defaultAppSettings());
});

describe('checkThenStartTake', () => {
  it('launches a healthy setup at once, with no sheet', async () => {
    await checkThenStartTake('script-1', { presentationMode: 'reader' });
    expect(h.startTake).toHaveBeenCalledWith('script-1', { presentationMode: 'reader' });
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('warns about a missing model instead of launching past it', async () => {
    model.set(MISSING);
    await checkThenStartTake('script-1');
    expect(h.startTake).not.toHaveBeenCalled();
    const held = get(takeReadinessPrompt);
    expect(held?.verdict.show).toBe(true);
    // A warning, never a block: Start anyway stays on offer.
    expect(held?.verdict.blocked).toBe(false);
    expect(findingIds()).toEqual(['model_missing']);
  });

  it('resumes exactly the take that was asked for on Start anyway', async () => {
    model.set(MISSING);
    const options = {
      presentationMode: 'prompter' as const,
      startTokenIndex: 42,
      part: { id: 'part-3', whole: true },
    };
    await checkThenStartTake('script-1', options);
    await startAnyway();
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(h.startTake).toHaveBeenCalledWith('script-1', options);
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('launches nothing when the sheet is dismissed', async () => {
    model.set(MISSING);
    await checkThenStartTake('script-1');
    dismissTakeReadiness();
    await startAnyway();
    expect(h.startTake).not.toHaveBeenCalled();
  });

  it('reads the model as it is NOW — an install that finished is installed', async () => {
    // The issue's repro at the launch: the answer was taken when the script
    // opened, mid-download, and kept after the download finished.
    model.set({ ...MISSING, installing: true });
    await checkThenStartTake('script-1');
    expect(findingIds()).toEqual(['model_installing']);
    dismissTakeReadiness();

    model.set(INSTALLED);
    await checkThenStartTake('script-1');
    expect(get(takeReadinessPrompt)).toBeNull();
    expect(h.startTake).toHaveBeenCalledTimes(1);
  });

  it('and a model removed since is missing', async () => {
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);

    model.set(MISSING);
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(findingIds()).toEqual(['model_missing']);
  });

  it('names a damaged download and an unloadable model as what they are', async () => {
    model.set({ ...MISSING, damaged: true });
    await checkThenStartTake('script-1');
    expect(findingIds()).toEqual(['model_damaged']);
    dismissTakeReadiness();

    model.set({ ...INSTALLED, supported: false });
    await checkThenStartTake('script-1');
    expect(findingIds()).toEqual(['model_unsupported']);
  });

  it('never warns a manual take about the model', async () => {
    settingsDoc.set({
      ...defaultAppSettings(),
      general: { ...defaultAppSettings().general, defaultSessionMode: 'manual' },
    });
    model.set(MISSING);
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('checks a practice like a take, and resumes it as a practice', async () => {
    model.set(MISSING);
    await checkThenStartTake('script-1', { practice: true });
    expect(findingIds()).toEqual(['model_missing']);
    await startAnyway();
    expect(h.startTake).toHaveBeenCalledWith('script-1', { practice: true });
  });

  it('does not judge a script by a compile of a different one', async () => {
    // Nothing is open in the editor: the script facts are unknown, which is
    // optimistic — `startTake` compiles the saved source itself.
    await checkThenStartTake('a-script-the-editor-does-not-hold');
    expect(h.startTake).toHaveBeenCalledTimes(1);
  });
});

describe('checkThenStart', () => {
  it('shows the sheet on request even for a healthy setup, and Start anyway launches', async () => {
    const launch = vi.fn(async () => {});
    await checkThenStart('script-1', { requested: true }, launch);
    expect(launch).not.toHaveBeenCalled();
    expect(get(takeReadinessPrompt)?.verdict.findings).toEqual([]);
    await startAnyway();
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
