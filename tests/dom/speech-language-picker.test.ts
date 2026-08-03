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
import { fireEvent, render, waitFor } from '@testing-library/svelte';
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

/**
 * Only what these assertions actually touch.
 *
 * `ReturnType<typeof render>` names the GENERIC render overload, not the
 * specialized result this component's props produce, so assigning one to the
 * other is a type error — and because `tsconfig.json` includes `tests/**`, that
 * error fails `pnpm check` rather than merely this file.
 */
interface MountedView {
  container: HTMLElement;
}

interface MountResult {
  view: MountedView;
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
  const view: MountedView = render(SpeechLanguagePicker, { props: { revision: 1, ...props } });
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
function text(view: MountedView): string {
  return (view.container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function buttonLabelled(view: MountedView, label: string): HTMLButtonElement | null {
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
    // "once installed", not "on disk": the model is not on this machine, and
    // claiming it occupies disk it does not occupy is simply false.
    expect(shown).toContain('162 MB once installed');
    expect(shown).not.toContain('162 MB on disk');
    expect(shown).toContain('github.com');
  });

  it('says "on disk" only once the model really is', async () => {
    const { view } = await mount(optionsFixture());
    expect(text(view)).toContain('162 MB on disk');
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

/**
 * §181 — the third surface `STT_MODEL_NOT_INSTALLED` reaches.
 *
 * The two above it are routes out of `ensure_loaded`; this one is a separate
 * raise site. `select_speech_language` refuses a language whose weights are not
 * resolvable, `activate()` turns the rejection into `describeError(err)`, and
 * that string is rendered here as an alert — so error copy written for a take
 * that failed to start is also read next to a language row by someone who is
 * not in a take at all.
 *
 * The row's own `notInstalled` rendering (above) does NOT prove this: that path
 * reads a status snapshot and never touches `describeError`. What is modelled
 * here is the race the snapshot cannot cover — the panel painted while the
 * model was usable, and it stopped being usable before the click.
 */
describe('a language that cannot be activated says so in authored copy', () => {
  it('renders the app’s own sentence rather than the backend’s', async () => {
    const german = optionFixture({
      languageTag: 'de-DE',
      primarySubtag: 'de',
      modelId: 'kroko-de',
      active: false,
      status: statusFixture({ modelId: 'kroko-de', installed: true }),
    });
    const options = optionsFixture({
      languages: [optionFixture({ active: false }), german],
    });
    const { view } = await mount(options);

    /*
     * Verbatim from `speech_cmds.rs`. It is readable prose, which is the whole
     * hazard: `describeError` prefers a `userMessage` that does not look like a
     * code, so before this issue it reached the alert unedited and nothing in
     * `errors.ts` had a say in what the picker said.
     */
    const backendMessage = 'Download this language before switching to it.';
    setInvokeForTesting(async (command) => {
      if (command === 'select_speech_language') {
        throw {
          code: 'STT_MODEL_NOT_INSTALLED',
          category: 'validation',
          userMessage: backendMessage,
          recoverable: true,
          correlationId: 'corr-1',
        };
      }
      if (command === 'get_speech_language_options') return options as never;
      return statusFixture() as never;
    });

    const select = view.container.querySelector('select')!;
    select.value = 'de-DE';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(buttonLabelled(view, 'Use ')?.disabled).toBe(false));
    await fireEvent.click(buttonLabelled(view, 'Use ')!);

    await waitFor(() => {
      const alerts = Array.from(view.container.querySelectorAll('[role="alert"]'))
        .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim());
      expect(alerts.some((a) => a.includes('Settings → Speech'))).toBe(true);
    });
    const shown = text(view);
    expect(shown).toContain('The speech model for the selected language is not installed.');
    expect(shown).not.toContain(backendMessage);
    // The rule the whole of `errors.ts` exists for, asserted on this screen too.
    expect(shown).not.toContain('STT_MODEL_NOT_INSTALLED');
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

describe('which language is in use', () => {
  it('names the active language even while another row is being inspected', async () => {
    const german = optionFixture({
      languageTag: 'de-DE',
      primarySubtag: 'de',
      modelId: 'kroko-de',
      active: false,
      status: statusFixture({ modelId: 'kroko-de', installed: false, phase: 'notInstalled' }),
    });
    const { view } = await mount(optionsFixture({ languages: [optionFixture(), german] }));

    expect(text(view)).toContain('Currently using');

    const select = view.container.querySelector('select')!;
    select.value = 'de-DE';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(text(view)).toContain('Download'));

    // §153 asks for "a clear indication of which language is active". Looking
    // at German must not make English's active-ness vanish from the screen.
    expect(text(view)).toContain('Currently using');
    expect(text(view).toLowerCase()).toContain('english');
    // …and the menu marks it too.
    const active = Array.from(view.container.querySelectorAll('option')).find((o) =>
      o.textContent?.includes('in use'),
    );
    expect(active?.value).toBe('en-US');
  });

  it('says plainly when no offered language is selected', async () => {
    // A downgrade can leave the persisted language outside the offer list.
    const { view } = await mount(
      optionsFixture({ languages: [optionFixture({ active: false })] }),
    );
    expect(text(view)).toContain('No language this version can follow is selected');
  });
});

describe('removing the language on screen', () => {
  it('offers Remove for a downloaded model, behind a confirm', async () => {
    // The regression this pins: removal used to exist ONLY for orphaned models,
    // so a machine with the single default language could never reclaim its
    // download at all — a control #152 had and this replaced with nothing.
    const { view } = await mount(optionsFixture());
    const remove = buttonLabelled(view, 'Remove download');
    expect(remove).not.toBeNull();

    remove!.click();
    await waitFor(() => expect(buttonLabelled(view, 'Remove it')).not.toBeNull());
    expect(buttonLabelled(view, 'Keep it')).not.toBeNull();
    // Focus goes to the SAFE choice, so a waiting Return does not delete.
    // Awaited: the move happens after a `tick()`, one flush later than the
    // buttons appear.
    await waitFor(() => {
      expect(document.activeElement).toBe(buttonLabelled(view, 'Keep it'));
    });
  });

  it('does not offer Remove for a model that is not ours to delete', async () => {
    for (const source of ['bundled', 'override'] as const) {
      const { view } = await mount(
        optionsFixture({ languages: [optionFixture({ status: statusFixture({ source }) })] }),
      );
      // Removing a bundled or overridden model would delete an app-data copy
      // and leave the visible one exactly where it was.
      expect(buttonLabelled(view, 'Remove download')).toBeNull();
      setInvokeForTesting(null);
      document.body.innerHTML = '';
    }
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

    expect(text(view)).toContain('Other language data on this computer');
    const remove = buttonLabelled(view, 'Remove');
    expect(remove).not.toBeNull();

    remove!.click();
    await waitFor(() => expect(buttonLabelled(view, 'Remove it')).not.toBeNull());
    // Destructive and several hundred megabytes: never a single click.
    expect(buttonLabelled(view, 'Keep it')).not.toBeNull();
  });

  it('hides the inventory in the compact first-run form', async () => {
    const orphan = statusFixture({
      modelId: 'kroko-es',
      languages: ['es'],
      installed: true,
      installedBytes: 155_832_407,
    });
    const { view } = await mount(optionsFixture({ removable: [orphan] }), { compact: true });
    // Reclaiming disk is not a first-run concern. The heading going is not
    // enough — the ROW and its action must be absent too, or the section would
    // merely be unlabelled rather than hidden.
    const shown = text(view);
    expect(shown).not.toContain('Other language data on this computer');
    expect(shown).not.toContain('Spanish');
    expect(shown).not.toContain('149 MB');
  });
});
