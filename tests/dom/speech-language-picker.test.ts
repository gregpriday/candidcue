/**
 * SpeechLanguagePicker — the screen §153 describes, asserted as a screen.
 *
 * The rules being pinned are the ones that are easy to break while the
 * component still "works":
 *
 *   * The sizes and the origin are visible BEFORE the download button, because
 *     that is the whole reason the issue asks for them.
 *   * The licence is shown and is NOT a gate — no checkbox, no accept step.
 *   * Choosing a row in the dropdown downloads nothing and saves nothing.
 *   * Activation is refused while a take is open.
 *   * A selected-but-missing model is reported HERE, where it can be fixed,
 *     rather than at the top of a take.
 *
 * Driven through `setInvokeForTesting`, so the component takes its production
 * path — the same `ipcInvoke` funnel a real window uses — rather than being
 * handed props a real backend never produces.
 */
import { render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import SpeechLanguagePicker from '../../src/control/components/SpeechLanguagePicker.svelte';
import { setInvokeForTesting } from '../../src/control/services/ipc';
import type {
  SpeechLanguageOption,
  SpeechLanguageOptions,
  SpeechModelStatus,
} from '../../src/control/services/speech-models';

const RECOGNIZER_ID = 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05';

function statusFixture(overrides: Partial<SpeechModelStatus> = {}): SpeechModelStatus {
  return {
    modelId: 'x-asr-480ms',
    modelName: RECOGNIZER_ID,
    languages: ['en', 'zh'],
    phase: 'installed',
    source: 'downloaded',
    installed: true,
    supported: true,
    downloadBytes: 133_895_136,
    installedBytes: 169_347_218,
    progressBytes: 0,
    progressTotal: 0,
    operationId: null,
    error: null,
    ...overrides,
  };
}

function optionFixture(overrides: Partial<SpeechLanguageOption> = {}): SpeechLanguageOption {
  return {
    languageTag: 'en-US',
    primarySubtag: 'en',
    modelId: 'x-asr-480ms',
    recognizerId: RECOGNIZER_ID,
    active: true,
    status: statusFixture(),
    origins: [{ kind: 'upstream', host: 'github.com' }],
    attribution: {
      title: 'X-ASR streaming Zipformer transducer',
      author: 'Jun Guo, with the X-LANCE Lab',
      sourceUrl: 'https://github.com/Gilgamesh-J/X-ASR',
      distributedVia: 'https://github.com/k2-fsa/sherpa-onnx',
      license: {
        id: 'Apache-2.0',
        name: 'Apache License 2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
      },
      licenseNote: null,
      modified: false,
    },
    ...overrides,
  };
}

function optionsFixture(overrides: Partial<SpeechLanguageOptions> = {}): SpeechLanguageOptions {
  return {
    active: {
      languageTag: 'en-US',
      primarySubtag: 'en',
      modelId: 'x-asr-480ms',
      recognizerId: RECOGNIZER_ID,
    },
    changeBlocked: false,
    languages: [optionFixture()],
    removable: [],
    ...overrides,
  };
}

interface MountResult {
  view: ReturnType<typeof render>;
  calls: Array<{ command: string; args: unknown }>;
}

async function mount(
  options: SpeechLanguageOptions,
  props: { compact?: boolean } = {},
): Promise<MountResult> {
  const calls: Array<{ command: string; args: unknown }> = [];
  setInvokeForTesting(async (command, args) => {
    calls.push({ command, args });
    if (command === 'get_speech_language_options') return options as never;
    return statusFixture() as never;
  });
  const view = render(SpeechLanguagePicker, { props: { revision: 1, ...props } });
  // The panel paints "Checking…" until the first snapshot lands.
  await waitFor(() => {
    expect(view.container.textContent ?? '').not.toContain('Checking which languages');
  });
  return { view, calls };
}

/**
 * Rendered text with runs of whitespace collapsed.
 *
 * `textContent` preserves the newlines and indentation the template was written
 * with, so a sentence that happens to wrap in the source reads as
 * `"162 MB on\n        disk"` here. Asserting against that would pin the
 * component's INDENTATION, and the next person to reflow a line would get a
 * failing test telling them nothing.
 */
function text(view: ReturnType<typeof render>): string {
  return (view.container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function buttonLabelled(view: ReturnType<typeof render>, label: string): HTMLButtonElement | null {
  return (
    Array.from(view.container.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes(label),
    ) ?? null
  );
}

afterEach(() => setInvokeForTesting(null));

describe('what is shown before anything downloads', () => {
  it('states the transfer size, the disk footprint and the origin', async () => {
    const { view } = await mount(
      optionsFixture({
        languages: [
          optionFixture({ status: statusFixture({ installed: false, phase: 'notInstalled' }) }),
        ],
      }),
    );
    const shown = text(view);
    // 133_895_136 B → "128 MB"; 169_347_218 B → "162 MB".
    expect(shown).toContain('128 MB to download');
    expect(shown).toContain('162 MB on disk');
    expect(shown).toContain('github.com');
  });

  it('shows the licence without making it a gate', async () => {
    const { view } = await mount(
      optionsFixture({
        languages: [
          optionFixture({ status: statusFixture({ installed: false, phase: 'notInstalled' }) }),
        ],
      }),
    );
    expect(text(view)).toContain('Apache License 2.0');
    // §153: attribution is an obligation the app carries, never a decision put
    // in front of the user. Nothing here may gate the download.
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(text(view).toLowerCase()).not.toContain('i agree');
    expect(text(view).toLowerCase()).not.toContain('accept the licence');
    // …and the download is reachable regardless.
    expect(buttonLabelled(view, 'Download')).not.toBeNull();
  });

  it('names the download size on the button itself', async () => {
    const { view } = await mount(
      optionsFixture({
        languages: [
          optionFixture({ status: statusFixture({ installed: false, phase: 'notInstalled' }) }),
        ],
      }),
    );
    expect(buttonLabelled(view, 'Download')?.textContent).toContain('128 MB');
  });
});

describe('only followable languages are offered', () => {
  it('renders exactly the options Rust returned', async () => {
    const { view } = await mount(optionsFixture());
    const values = Array.from(view.container.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['en-US']);
  });

  it('says so plainly when there are none, rather than showing an empty menu', async () => {
    const { view } = await mount(optionsFixture({ languages: [] }));
    expect(text(view)).toContain('no speech languages available');
    expect(view.container.querySelector('select')).toBeNull();
  });
});

describe('choosing is deliberate', () => {
  it('does not download or save when the dropdown changes', async () => {
    const french = optionFixture({
      languageTag: 'fr-FR',
      primarySubtag: 'fr',
      modelId: 'kroko-fr',
      active: false,
      status: statusFixture({ modelId: 'kroko-fr', installed: false, phase: 'notInstalled' }),
    });
    const { view, calls } = await mount(
      optionsFixture({ languages: [optionFixture(), french] }),
    );
    calls.length = 0;

    const select = view.container.querySelector('select');
    expect(select).not.toBeNull();
    select!.value = 'fr-FR';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(text(view)).toContain('Download'));

    // Looking is not choosing (§153): no download started, no setting written.
    expect(calls.map((c) => c.command)).not.toContain('start_speech_model_download');
    expect(calls.map((c) => c.command)).not.toContain('select_speech_language');
  });

  it('offers an explicit activation for an installed, inactive language', async () => {
    const german = optionFixture({
      languageTag: 'de-DE',
      primarySubtag: 'de',
      modelId: 'kroko-de',
      active: false,
      status: statusFixture({ modelId: 'kroko-de', installed: true }),
    });
    const { view } = await mount(
      optionsFixture({ languages: [optionFixture({ active: false }), german] }),
    );

    const select = view.container.querySelector('select')!;
    select.value = 'de-DE';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => expect(buttonLabelled(view, 'Use ')).not.toBeNull());
    expect(buttonLabelled(view, 'Use ')?.disabled).toBe(false);
  });
});

describe('a take blocks the change', () => {
  it('disables activation and says why', async () => {
    const german = optionFixture({
      languageTag: 'de-DE',
      primarySubtag: 'de',
      modelId: 'kroko-de',
      active: false,
      status: statusFixture({ modelId: 'kroko-de', installed: true }),
    });
    const { view } = await mount(
      optionsFixture({ changeBlocked: true, languages: [optionFixture({ active: false }), german] }),
    );

    const select = view.container.querySelector('select')!;
    select.value = 'de-DE';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => expect(buttonLabelled(view, 'Use ')).not.toBeNull());
    expect(buttonLabelled(view, 'Use ')?.disabled).toBe(true);
    expect(text(view)).toContain('End the take to change the speech language.');
  });
});

describe('a missing model is fixable here', () => {
  it('reports the active language having no data on this machine', async () => {
    const { view } = await mount(
      optionsFixture({
        languages: [
          optionFixture({
            active: true,
            status: statusFixture({ installed: false, phase: 'notInstalled' }),
          }),
        ],
      }),
    );
    // §153: this is the screen where STT_MODEL_MISSING should be visible and
    // fixable, rather than the top of a take.
    expect(text(view)).toContain('speech data is not on this machine');
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(buttonLabelled(view, 'Download')).not.toBeNull();
  });

  it('surfaces a failed install and offers a retry', async () => {
    const { view } = await mount(
      optionsFixture({
        languages: [
          optionFixture({
            status: statusFixture({
              installed: false,
              phase: 'failed',
              error: { code: 'STT_MODEL_DOWNLOAD_FAILED', message: 'The download was interrupted.' },
            }),
          }),
        ],
      }),
    );
    expect(text(view)).toContain('The download was interrupted.');
    // Named "Try again" rather than "Download": the user already pressed
    // Download once and it did not work.
    expect(buttonLabelled(view, 'Try again')).not.toBeNull();
  });
});

describe('an install in flight', () => {
  it('shows the phase, the bytes and a way to stop', async () => {
    const { view } = await mount(
      optionsFixture({
        languages: [
          optionFixture({
            status: statusFixture({
              installed: false,
              phase: 'downloading',
              progressBytes: 66_947_568,
              progressTotal: 133_895_136,
            }),
          }),
        ],
      }),
    );
    expect(text(view)).toContain('Downloading');
    expect(text(view)).toContain('of 128 MB');
    expect(buttonLabelled(view, 'Stop')).not.toBeNull();
    const bar = view.container.querySelector('progress');
    expect(bar?.getAttribute('value')).toBe('0.5');
  });

  it('leaves the bar indeterminate for a phase that measures nothing', async () => {
    const { view } = await mount(
      optionsFixture({
        languages: [
          optionFixture({
            status: statusFixture({ installed: false, phase: 'validating', progressTotal: 1 }),
          }),
        ],
      }),
    );
    // A bar snapping back to empty here reads as a restart, so it must carry no
    // value at all rather than a zero.
    expect(view.container.querySelector('progress')?.hasAttribute('value')).toBe(false);
  });
});

describe('reclaiming disk', () => {
  it('lists a model backing no offered language, with a confirm step', async () => {
    const orphan = statusFixture({
      modelId: 'kroko-es',
      languages: ['es'],
      installed: true,
      installedBytes: 155_832_407,
    });
    const { view } = await mount(optionsFixture({ removable: [orphan] }));

    expect(text(view)).toContain('Other language data on this Mac');
    const remove = buttonLabelled(view, 'Remove');
    expect(remove).not.toBeNull();

    remove!.click();
    await waitFor(() => expect(buttonLabelled(view, 'Remove it')).not.toBeNull());
    // Destructive and several hundred megabytes: never a single click.
    expect(buttonLabelled(view, 'Keep it')).not.toBeNull();
  });

  it('hides the inventory in the compact first-run form', async () => {
    const orphan = statusFixture({ modelId: 'kroko-es', languages: ['es'], installed: true });
    const { view } = await mount(optionsFixture({ removable: [orphan] }), { compact: true });
    // Reclaiming disk is not a first-run concern.
    expect(text(view)).not.toContain('Other language data on this Mac');
  });
});
