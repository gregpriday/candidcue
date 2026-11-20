/**
 * The voice pill on the REAL stage, driven through the take's bridge prop.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * The pill first shipped rendered behind `phase === 'live'`, copied from the
 * transcript bar directly above it. That gate is reached only when an ALIGNMENT
 * SNAPSHOT arrives; alignment snapshots are built by Rust from transcript
 * frames; so the stage stays in `ready` for exactly as long as nothing is being
 * transcribed. The indicator whose entire purpose is to say "nothing is coming
 * back" could not be drawn until something had.
 *
 * Every unit test passed: the reducer was right, the payloads were right, the
 * component rendered fine in isolation. The bug lived in one boolean in a
 * template, which is why this file mounts the actual `StageApp` and drives it
 * the way a take does: embedded in the control window, with the pill arriving
 * as the `voicePill` prop Live feeds from `SessionState.voicePill`. Nothing
 * sends the pill to the separate stage window any more (#212, #235).
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import StageApp from '../../src/stage/StageApp.svelte';
import { STAGE_VOICE_PILL_TRACE_SAMPLES } from '../../src/shared/contracts';
import type {
  StageRenderDocument,
  StageSessionEnvelope,
  StageVoicePillPayload,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';

/** A take renders the stage inside the control window, at stage generation 0. */
const STAGE_GENERATION = 0;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  // jsdom implements neither of these, and the stage reads both on mount.
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  }
  // jsdom has no font loading; the stage waits on it before measuring.
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve(), load: async () => [] },
    });
  }
});

function renderDocument(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Hello there', tokenIndexes: [0, 1] }],
        startTokenIndex: 0,
        endTokenIndex: 1,
        source: { utf16Start: 0, utf16End: 11 },
        spoken: true,
      },
    ],
    tokenToNode: [{ tokenIndex: 0, blockId: 'b1', nodeKey: '' }],
    assets: {},
    sentences: [],
  } as unknown as StageRenderDocument;
}

function envelope(): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    sessionGeneration: 1,
    stageGeneration: STAGE_GENERATION,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'hash-abc',
    compileRevision: 1,
    stageSettings: buildStageSettings({}),
    renderDocument: renderDocument(),
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

function pillPayload(overrides: Partial<StageVoicePillPayload> = {}): StageVoicePillPayload {
  return {
    stageGeneration: STAGE_GENERATION,
    reading: 'listening',
    levels: [0.2, 0.6, 0.4],
    label: 'Listening',
    visible: true,
    sentAtMs: 1000,
    ...overrides,
  };
}

/** Let the stage's async subscriptions register and its effects settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function pill(container: Element): HTMLElement | null {
  const el = container.querySelector('.voice-pill');
  return el instanceof HTMLElement ? el : null;
}

function bridge(voicePill: StageVoicePillPayload | null, blanked = false) {
  return {
    embedded: {
      envelope: ENVELOPE,
      alignment: null,
      transcript: '',
      voicePill,
      blanked,
      onexit: vi.fn(),
      onintent: vi.fn(),
    },
  };
}

/** One envelope for the whole mount: a new object would read as a new document. */
const ENVELOPE = envelope();

async function mountStage(voicePill: StageVoicePillPayload | null = null) {
  const mounted = render(StageApp, { props: bridge(voicePill) as never });
  await settle();
  return mounted;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the voice pill on the stage', () => {
  it('draws without a single alignment snapshot ever arriving', async () => {
    /*
     * The regression check. No alignment snapshot is handed over here, so the
     * stage never reaches `live` — which is precisely the state a take has
     * while transcription is producing nothing, and precisely when the
     * presenter needs to be told.
     */
    const { container, rerender } = await mountStage();
    expect(pill(container), 'nothing to draw until control says something').toBeNull();

    await rerender(bridge(pillPayload()));
    await settle();

    const drawn = pill(container);
    expect(drawn, 'the pill must not wait for transcription to succeed').not.toBeNull();
    expect(drawn?.getAttribute('aria-label')).toBe('Listening');
    expect(drawn?.dataset.visible).toBe('true');
    expect(container.querySelectorAll('.bar')).toHaveLength(STAGE_VOICE_PILL_TRACE_SAMPLES);
  });

  it('shows a fault, in words, on a stage that has never gone live', async () => {
    const { container } = await mountStage(pillPayload({ reading: 'fault', label: 'No audio' }));
    expect(pill(container)?.dataset.reading).toBe('fault');
    expect(container.querySelector('.voice-pill .label')?.textContent).toBe('No audio');
  });

  it('follows the prop from one reading to the next', async () => {
    const { container, rerender } = await mountStage(pillPayload());
    expect(pill(container)?.getAttribute('aria-label')).toBe('Listening');

    await rerender(bridge(pillPayload({ reading: 'fault', label: 'Not hearing you' })));
    await settle();
    expect(pill(container)?.dataset.reading).toBe('fault');
    expect(container.querySelector('.voice-pill .label')?.textContent).toBe('Not hearing you');
  });

  it('fades rather than unmounts when control clears `visible`', async () => {
    /*
     * The title used to say "when it has proved itself", which is no longer
     * what clears the flag: a proven pill stays up for the whole take now, and
     * a PAUSE is what sets `visible: false`. What this pins is unchanged and is
     * about the renderer either way — the flag fades the pill, it never
     * unmounts it.
     */
    const { container, rerender } = await mountStage(pillPayload({ reading: 'confirmed' }));
    const before = pill(container);
    expect(before?.dataset.visible).toBe('true');

    await rerender(bridge(pillPayload({ reading: 'confirmed', visible: false })));
    await settle();
    // Still mounted, and the SAME node: a pill that was removed or remounted
    // would pop back at full opacity in the corner of a script somebody is
    // reading.
    expect(pill(container), 'the pill fades, it is not removed').toBe(before);
    expect(pill(container)?.dataset.visible).toBe('false');
  });

  it('disappears while the stage is blanked', async () => {
    // §16.6 is a deliberate "show nothing"; it is not a moment to report on
    // the microphone.
    const { container, rerender } = await mountStage(pillPayload());
    expect(pill(container)).not.toBeNull();

    await rerender(bridge(pillPayload(), true));
    await settle();
    expect(pill(container)).toBeNull();

    // And it comes back when the glass does.
    await rerender(bridge(pillPayload(), false));
    await settle();
    expect(pill(container)).not.toBeNull();
  });
});
