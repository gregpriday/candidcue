/**
 * What the glass says when the control window dies.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The watchdog froze the stage and nothing else happened. `frozen` stopped the
 * frame loop and set a `data-phase` attribute that no CSS rule and no copy
 * keyed on, the hold ladder had no input for control loss, and the voice pill
 * kept drawing whatever control had last said — which, mid-take, is a settled
 * solid dot meaning "and it is still fine".
 *
 * So the presenter saw a script that had stopped moving and an audio readout
 * reporting health: indistinguishable from an ordinary alignment hold, which is
 * precisely the three-faults-one-symptom ambiguity the ladder and the transcript
 * bar were built to resolve for every other failure. They keep performing to a
 * dead prompter.
 *
 * The waits here are REAL, like the hold-ladder file's, and for the same reason:
 * the thing under test is a deadline expiring because nothing arrived, which is
 * exactly the situation faking the clock would fake away.
 *
 * `isTauri` is forced true because the watchdog is deliberately disarmed outside
 * Tauri — the preview bus has no liveness contract — while the event bridge is
 * left as the real local-bus implementation, so events still travel normally.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/stage/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/events')>();
  return { ...actual, isTauri: true };
});

import StageApp from '../../src/stage/StageApp.svelte';
import { dispatchLocalStageEvent } from '../../src/stage/events';
import { STAGE_EVENT, STAGE_HEARTBEAT_GRACE_MS } from '../../src/shared/contracts';
import type {
  AlignmentSnapshot,
  AlignmentState,
  StageHeartbeatPayload,
  StageRenderDocument,
  StageSessionEnvelope,
  StageVoicePillPayload,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import {
  CONTROL_LOST_HINT,
  CONTROL_LOST_MESSAGE,
} from '../../src/stage/renderer/hold-status';

const STAGE_GENERATION = 11;

/** Comfortably past the deadline, plus a watchdog tick to notice it. */
const PAST_THE_DEADLINE = STAGE_HEARTBEAT_GRACE_MS + 1600;

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

let heartbeatRevision = 0;
function heartbeat(stageGeneration = STAGE_GENERATION): StageHeartbeatPayload {
  heartbeatRevision += 1;
  return { stageGeneration, revision: heartbeatRevision, sentAtMs: heartbeatRevision * 1000 };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chip = (c: HTMLElement) => c.querySelector<HTMLElement>('.hold-status');
const root = (c: HTMLElement) => c.querySelector<HTMLElement>('.stage-root');
const pill = (c: HTMLElement) => c.querySelector<HTMLElement>('.voice-pill');

/** A live stage that has heard from control at least once. */
async function mountBeatingStage(): Promise<HTMLElement> {
  const { container } = render(StageApp);
  await settle();
  dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope());
  await settle();
  // The reducer refuses alignment while the phase is still `handshake`.
  await wait(420);
  await settle();
  dispatchLocalStageEvent<StageHeartbeatPayload>(STAGE_EVENT.heartbeat, heartbeat());
  await settle();
  return container;
}

describe('control stops answering', () => {
  it('names the condition on the glass instead of just stopping', async () => {
    const container = await mountBeatingStage();

    // Before the deadline: nothing is owed, and nothing is said.
    expect(chip(container)?.getAttribute('data-visible')).toBe('false');

    await wait(PAST_THE_DEADLINE);
    await settle();

    expect(root(container)?.getAttribute('data-phase')).toBe('frozen');
    expect(chip(container)?.getAttribute('data-visible')).toBe('true');
    expect(chip(container)?.textContent).toContain(CONTROL_LOST_MESSAGE);
    // A fault, not a hold: this is the system unable to work, and nothing the
    // presenter says will change it.
    expect(chip(container)?.getAttribute('data-tone')).toBe('fault');
  }, 20_000);

  it('offers the one recovery that still works, and never the one that does not', async () => {
    const container = await mountBeatingStage();
    await wait(PAST_THE_DEADLINE);
    await settle();

    const text = chip(container)?.textContent ?? '';
    expect(text).toContain(CONTROL_LOST_HINT);
    /*
     * `HOLD_FAULT_HINT` names the A key, and A is `auto_scroll_toggle` — an
     * intent, sent to control, which is the component that has stopped
     * answering. Printing it here would be advice that cannot work, on the one
     * surface a presenter is taught to read mid-take.
     */
    expect(text).not.toContain('Press A');
  }, 20_000);

  it('stops the audio readout claiming the microphone is fine', async () => {
    const container = await mountBeatingStage();
    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'steady',
      levels: [0.4, 0.5, 0.6],
      label: 'Hearing you',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();
    expect(pill(container)?.getAttribute('data-reading')).toBe('steady');

    await wait(PAST_THE_DEADLINE);
    await settle();

    // The settled solid dot is the most reassuring mark this instrument has.
    // Left alone it asserts the opposite of the truth at the exact moment the
    // presenter is working out why the script stopped.
    expect(pill(container)?.getAttribute('data-reading')).toBe('fault');
    expect(pill(container)?.textContent).toContain('Control lost');
  }, 20_000);

  it('reports it even on a take where control died before its first pill frame', async () => {
    // Otherwise the dock shows its placeholder — an empty slot, indistinguishable
    // from a take that simply has not started reporting yet.
    const container = await mountBeatingStage();
    await wait(PAST_THE_DEADLINE);
    await settle();

    expect(pill(container)?.getAttribute('data-reading')).toBe('fault');
    expect(pill(container)?.textContent).toContain('Control lost');
  }, 20_000);

  it('outranks a hardware fault already on the glass', async () => {
    /*
     * Both skip the ladder, so which one is shown used to depend on the order
     * two `if`s were written in. Control loss wins because every other input to
     * the ladder is something control measured and sent: once it stops
     * answering, the microphone reading is a photograph, not a measurement.
     */
    const container = await mountBeatingStage();
    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'fault',
      levels: [0, 0, 0],
      label: 'No audio',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();
    expect(chip(container)?.textContent).toContain('No audio');

    await wait(PAST_THE_DEADLINE);
    await settle();

    expect(chip(container)?.textContent).toContain(CONTROL_LOST_MESSAGE);
  }, 20_000);

  it('takes the message back when control returns', async () => {
    const container = await mountBeatingStage();
    await wait(PAST_THE_DEADLINE);
    await settle();
    expect(chip(container)?.getAttribute('data-visible')).toBe('true');

    dispatchLocalStageEvent<StageHeartbeatPayload>(STAGE_EVENT.heartbeat, heartbeat());
    await settle();

    expect(root(container)?.getAttribute('data-phase')).not.toBe('frozen');
    expect(chip(container)?.getAttribute('data-visible')).toBe('false');
  }, 20_000);
});

describe('the liveness clock measures control, and only control', () => {
  it('is not held open by alignment snapshots, which never came from control', async () => {
    /*
     * THIS IS THE BUG THAT MADE THE WHOLE DISCLOSURE UNREACHABLE.
     *
     * The watchdog used to reset on ANY inbound event, including alignment.
     * Rust publishes alignment straight to this window with control out of the
     * motion path entirely — that is the design — so a control window that had
     * crashed went on being reported as alive for as long as the aligner kept
     * publishing. Mid-take with the recogniser running, that is indefinitely:
     * the watchdog could not fire in precisely the situation it exists for.
     */
    const container = await mountBeatingStage();

    // Keep the alignment feed running hard across the whole grace period,
    // exactly as a live Rust aligner would while control lies dead.
    const feed = setInterval(() => {
      dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot('following'));
    }, 200);
    try {
      await wait(PAST_THE_DEADLINE);
      await settle();
    } finally {
      clearInterval(feed);
    }

    expect(root(container)?.getAttribute('data-phase')).toBe('frozen');
    expect(chip(container)?.textContent).toContain(CONTROL_LOST_MESSAGE);
  }, 20_000);

  it('starts running at the envelope, so a control that never beats is still caught', async () => {
    /*
     * Control begins its heartbeat on a ~1 s `setInterval`, so the first beat is
     * a second away. While the watchdog armed only on a beat, a control window
     * that died inside that window could never set `heartbeatSeen` — and the
     * stage sat there with no deadline running at all, silent forever, at the
     * most likely moment for a start to go wrong.
     *
     * So this mounts a stage that receives an envelope and then NEVER a single
     * heartbeat, which is the shape of that failure.
     */
    const { container } = render(StageApp);
    await settle();
    dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope());
    await settle();
    await wait(420);
    await settle();

    await wait(PAST_THE_DEADLINE);
    await settle();

    expect(root(container)?.getAttribute('data-phase')).toBe('frozen');
    expect(chip(container)?.textContent).toContain(CONTROL_LOST_MESSAGE);
  }, 20_000);

  it('is not held open by a heartbeat belonging to another generation', async () => {
    // A superseded start attempt must not be able to keep a take alive that it
    // no longer owns.
    const container = await mountBeatingStage();

    const feed = setInterval(() => {
      dispatchLocalStageEvent<StageHeartbeatPayload>(
        STAGE_EVENT.heartbeat,
        heartbeat(STAGE_GENERATION + 7),
      );
    }, 500);
    try {
      await wait(PAST_THE_DEADLINE);
      await settle();
    } finally {
      clearInterval(feed);
    }

    expect(root(container)?.getAttribute('data-phase')).toBe('frozen');
  }, 20_000);
});
