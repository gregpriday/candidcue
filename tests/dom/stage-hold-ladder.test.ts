/**
 * Progressive hold disclosure, wired end to end.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING PINNED
 * ---------------------------------------------------------------------------
 * `resolveHoldStatus` is pure and exhaustively unit-tested, and until this file
 * existed nothing called it. The ladder only means anything if a clock is
 * running, if the rung it resolves reaches BOTH the chip and the reading cue,
 * and if the two agree — which is why this drives the mounted `StageApp` with
 * the alignment snapshots Rust actually sends rather than calling the resolver.
 *
 * The timings are the real ones (1.5 s to hollow, 3.5 s to words) and the waits
 * are real waits. Faking the clock here would fake the one thing under test: a
 * threshold is only crossed because time passed with no new snapshot arriving,
 * which is exactly the situation a presenter is in when the script stops.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import StageApp from '../../src/stage/StageApp.svelte';
import { dispatchLocalStageEvent } from '../../src/stage/events';
import { STAGE_EVENT } from '../../src/shared/contracts';
import type {
  AlignmentSnapshot,
  AlignmentState,
  StageRenderDocument,
  StageSessionEnvelope,
  StageVoicePillPayload,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import { HOLD_FAULT_HINT } from '../../src/stage/renderer/hold-status';

const STAGE_GENERATION = 11;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
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
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve(), load: async () => [] },
    });
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

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
    renderDocument: {
      schemaVersion: 1,
      title: 'Take one',
      blocks: [
        {
          id: 'b1',
          kind: 'paragraph',
          renderNodes: [{ type: 'text', text: 'Hello there friend', tokenIndexes: [0, 1, 2] }],
          startTokenIndex: 0,
          endTokenIndex: 2,
          source: { utf16Start: 0, utf16End: 18 },
          spoken: true,
        },
      ],
      tokenToNode: [0, 1, 2].map((tokenIndex) => ({ tokenIndex, blockId: 'b1', nodeKey: '' })),
      assets: {},
      sentences: [],
    } as unknown as StageRenderDocument,
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

let seq = 0;
function snapshot(state: AlignmentState): AlignmentSnapshot {
  seq += 1;
  return {
    sessionGeneration: 1,
    seq,
    state,
    decision: 'localConfirmed',
    confirmedToken: 1,
    observedToken: 1,
    rateTokensPerSecond: 2.6,
    evidenceAudioMs: 1000,
    atAudioMs: 1000,
    maxPredictionMs: 900,
    pauseOnsetMs: 1800,
    leadFloorMs: 550,
    maxLeadTokens: 2.5,
    leadMarginTokens: 1.2,
    leadEaseMs: 450,
    leadHoldMs: 0,
    leadDecayMs: 1200,
    displayLimitToken: 3,
    confidence: 0.9,
    suggestionToken: null,
    scriptLenTokens: 3,
    observedAtom: 1,
    confirmedAtom: 1,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountLiveStage(): Promise<HTMLElement> {
  const { container } = render(StageApp);
  await settle();
  dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope());
  await settle();
  // The reducer refuses alignment while the phase is still `handshake`.
  await wait(420);
  await settle();
  return container;
}

const chip = (c: HTMLElement) => c.querySelector<HTMLElement>('.hold-status');
const cue = (c: HTMLElement) => c.querySelector<HTMLElement>('.cue');

describe('a hold shorter than the gap between transcript finals', () => {
  it('says nothing at all', async () => {
    /*
     * Finals land 1.2-1.7 s apart, so a hold shorter than that is usually just
     * the gap between one transcript event and the next. A stage that reported
     * every one of them would light up several times a minute during a take
     * that is going perfectly, and the presenter would learn to ignore the one
     * that finally means something.
     */
    const container = await mountLiveStage();
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot('holding'));
    await settle();

    expect(cue(container)?.getAttribute('data-hollow')).toBe('false');
    expect(chip(container)?.getAttribute('data-visible')).toBe('false');

    await wait(600);
    expect(cue(container)?.getAttribute('data-hollow')).toBe('false');
    expect(chip(container)?.getAttribute('data-visible')).toBe('false');
  });
});

describe('a hold that outlasts the ladder', () => {
  it('takes the cue hollow first, then finds words for it', async () => {
    const container = await mountLiveStage();
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot('holding'));
    await settle();

    // Rung one, at 1.5 s: solid becomes outline. No words, no motion, no colour.
    await wait(1900);
    expect(cue(container)?.getAttribute('data-hollow')).toBe('true');
    expect(chip(container)?.getAttribute('data-visible')).toBe('false');

    // Rung two, at 3.5 s: by now the presenter's question has changed from "is
    // it about to catch up" to "what is it doing", and a sentence is owed.
    await wait(2200);
    expect(chip(container)?.getAttribute('data-visible')).toBe('true');
    expect(chip(container)?.textContent?.trim()).toBe('Holding here');
    expect(chip(container)?.getAttribute('data-tone')).toBe('neutral');
    // …and the cue stays hollow underneath it: the rungs accumulate.
    expect(cue(container)?.getAttribute('data-hollow')).toBe('true');
  }, 12_000);

  it('clears the moment the text starts moving again, with no announcement', async () => {
    // The absence of a problem is the normal state of the world. No tick, no
    // green, no "back on track" — the script moving IS the announcement.
    const container = await mountLiveStage();
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot('searching'));
    await settle();
    await wait(4100);
    expect(chip(container)?.getAttribute('data-visible')).toBe('true');

    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot('following'));
    await settle();
    expect(chip(container)?.getAttribute('data-visible')).toBe('false');
    expect(cue(container)?.getAttribute('data-hollow')).toBe('false');
  }, 12_000);
});

describe('a named fault', () => {
  it('skips the ladder entirely and says so at once', async () => {
    /*
     * The ladder's patience is bought by the fact that a hold usually resolves
     * itself. A microphone does not come back on its own, and every second
     * spent waiting to mention it is a second of a take recorded against a rig
     * that is not listening.
     */
    const container = await mountLiveStage();
    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'fault',
      levels: [0, 0, 0],
      label: 'No audio from the microphone',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();

    expect(chip(container)?.getAttribute('data-visible')).toBe('true');
    // The condition, drawn as its own line above the recovery hint.
    expect(chip(container)?.firstChild?.textContent?.trim()).toBe('No audio from the microphone');
    // Not an escalation of a hold: a different claim, in a different voice.
    expect(chip(container)?.getAttribute('data-tone')).toBe('fault');
  });

  it('names the recovery, because this is the one hold that will not clear itself', async () => {
    /*
     * Naming the condition and stopping there leaves somebody standing at a
     * camera correctly informed and with nothing to do about it. The transport
     * is the thing to do, and it is one key.
     */
    const container = await mountLiveStage();
    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'fault',
      levels: [0, 0, 0],
      label: 'No audio from the microphone',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();

    expect(chip(container)?.querySelector('.hint')?.textContent?.trim()).toBe(HOLD_FAULT_HINT);
  });

  it('is reported on a stage that has never received a single snapshot', async () => {
    // The take that transcribes nothing never leaves `ready`, which is exactly
    // the take whose presenter most needs to be told why.
    const { container } = render(StageApp);
    await settle();
    dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope());
    await settle();
    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'fault',
      levels: [],
      label: 'No audio from the microphone',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();

    expect(container.querySelector('.stage-root')?.getAttribute('data-phase')).not.toBe('live');
    expect(chip(container)?.getAttribute('data-visible')).toBe('true');
  });
});
