/**
 * The voice pill on the REAL stage, driven through the real event bridge.
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
 * with the events control and Rust actually send.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import StageApp from '../../src/stage/StageApp.svelte';
import { dispatchLocalStageEvent } from '../../src/stage/events';
import { STAGE_EVENT, STAGE_VOICE_PILL_TRACE_SAMPLES } from '../../src/shared/contracts';
import type {
  StageRenderDocument,
  StageSessionEnvelope,
  StageStatePayload,
  StageVoicePillPayload,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';

const STAGE_GENERATION = 4;

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

async function mountStage(): Promise<{ container: HTMLElement }> {
  const { container } = render(StageApp);
  await settle();
  dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope());
  await settle();
  return { container };
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
     * The regression check. No `stage://alignment-snapshot` is sent here, so
     * the stage never reaches `live` — which is precisely the state a take has
     * while transcription is producing nothing, and precisely when the
     * presenter needs to be told.
     */
    const { container } = await mountStage();
    expect(pill(container), 'nothing to draw until control says something').toBeNull();

    dispatchLocalStageEvent(STAGE_EVENT.voicePill, pillPayload());
    await settle();

    const drawn = pill(container);
    expect(drawn, 'the pill must not wait for transcription to succeed').not.toBeNull();
    expect(drawn?.getAttribute('aria-label')).toBe('Listening');
    expect(drawn?.dataset.visible).toBe('true');
    expect(container.querySelectorAll('.bar')).toHaveLength(STAGE_VOICE_PILL_TRACE_SAMPLES);
  });

  it('shows a fault, in words, on a stage that has never gone live', async () => {
    const { container } = await mountStage();
    dispatchLocalStageEvent(
      STAGE_EVENT.voicePill,
      pillPayload({ reading: 'fault', label: 'No audio' }),
    );
    await settle();
    expect(pill(container)?.dataset.reading).toBe('fault');
    expect(container.querySelector('.voice-pill .label')?.textContent).toBe('No audio');
  });

  it('fades rather than unmounts when it has proved itself', async () => {
    const { container } = await mountStage();
    dispatchLocalStageEvent(STAGE_EVENT.voicePill, pillPayload({ reading: 'confirmed' }));
    await settle();
    expect(pill(container)?.dataset.visible).toBe('true');

    dispatchLocalStageEvent(
      STAGE_EVENT.voicePill,
      pillPayload({ reading: 'confirmed', visible: false }),
    );
    await settle();
    // Still mounted: a pill that was removed would pop back at full opacity in
    // the corner of a script somebody is reading.
    expect(pill(container), 'the pill fades, it is not removed').not.toBeNull();
    expect(pill(container)?.dataset.visible).toBe('false');
  });

  it('ignores a payload that arrives before this stage knows which take it is', async () => {
    /*
     * The window between a stage subscribing and its envelope arriving is
     * exactly when the PREVIOUS generation's last payloads are still in
     * flight. Treating "generation unknown" as "accept" — which is what every
     * other directive does — left the outgoing take's cross sitting on the new
     * stage the moment its envelope loaded.
     */
    const { container } = render(StageApp);
    await settle();
    dispatchLocalStageEvent(
      STAGE_EVENT.voicePill,
      pillPayload({ stageGeneration: STAGE_GENERATION - 1, reading: 'fault', label: 'No audio' }),
    );
    await settle();
    dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope());
    await settle();
    expect(pill(container), 'the dead take must not be drawn on the new one').toBeNull();
  });

  it('ignores a payload from a superseded stage generation', async () => {
    const { container } = await mountStage();
    dispatchLocalStageEvent(
      STAGE_EVENT.voicePill,
      pillPayload({ stageGeneration: STAGE_GENERATION - 1, reading: 'fault', label: 'No audio' }),
    );
    await settle();
    expect(pill(container), 'a dead take must not put a cross on a live one').toBeNull();
  });

  it('disappears while the stage is blanked', async () => {
    // §16.6 is a deliberate "show nothing"; it is not a moment to report on
    // the microphone.
    const { container } = await mountStage();
    dispatchLocalStageEvent(STAGE_EVENT.voicePill, pillPayload());
    await settle();
    expect(pill(container)).not.toBeNull();

    dispatchLocalStageEvent<StageStatePayload>(STAGE_EVENT.applyCommand, {
      stageGeneration: STAGE_GENERATION,
      revision: 1,
      directive: { kind: 'blank', blanked: true },
      sentAtMs: 2000,
    } as unknown as StageStatePayload);
    await settle();
    expect(pill(container)).toBeNull();
  });
});
