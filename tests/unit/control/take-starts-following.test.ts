/**
 * Pressing `Present` must leave the aligner able to follow.
 *
 * The defect this exists to prevent is the most expensive one this project has
 * had, and it was invisible to 1,474 passing tests:
 *
 *   The driver holds position the instant it is built — §9.1, "hold position
 *   until the user explicitly starts prompting" — and a held driver drops
 *   every snapshot before it reaches the UI. Nothing on the take path ever
 *   released that hold; only the `Start` button in the Live transport bar did.
 *
 * So a real take connected, recorded, transcribed and counted — "Words heard:
 * 26" — and followed none of it. "0 of 26 words (0%)", four takes running. The
 * store's own tests never saw it because every one of them calls
 * `startPrompting()` by hand before asserting anything, which is precisely the
 * call a presenter never makes.
 *
 * These tests therefore assert on the DRIVER's lifecycle calls, and they never
 * call `startPrompting()`. That is the whole point: if following depends on a
 * call the test has to make itself, the test is describing the developer's
 * knowledge of the app rather than the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  /* §64: the heartbeat compares what control sent against what the stage
     applied. `exists: false` means "no stage to compare with", which is the
     right answer for a mock that is not modelling a stage window. */
  getStageStatus: vi.fn(async () => ({ exists: false })),
  publishStageDirective: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  appendSessionTranscript: vi.fn(async () => 0),
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
  recordSessionTake: vi.fn(async () => null),
  listSessionTakes: vi.fn(async () => []),
}));

/** A real transport cannot be stood up in node; nothing here needs one. */
const pipeline = vi.hoisted(() => ({
  FakePipeline: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
/**
 * Spy on the DRIVER rather than on anything below it. The defect lives in
 * whether the take path calls `start()` at all, which is a fact about this
 * seam and nothing deeper.
 */
const driverCalls: string[] = [];
vi.mock('../../../src/control/services/session', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/session')>();
  return {
    ...actual,
    createTrackingDriver: () => {
      driverCalls.push('created');
      return {
        start: () => driverCalls.push('start'),
        pause: () => driverCalls.push('pause'),
        resume: () => driverCalls.push('resume'),
        moveSentences: () => {},
        restartParagraph: () => {},
        moveToToken: () => {},
        dispose: () => driverCalls.push('dispose'),
      };
    },
  };
});
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: pipeline.FakePipeline,
  COMMAND_TICK_INTERVAL_MS: 250,
}));
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../../src/control/services/stage-acks', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/stage-acks')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const { clearSession, session, setStageEmitterForTesting, startLiveSession, pauseListening } =
  await import('../../../src/control/stores/session');

function compiledStub(): CompiledScript {
  return {
    sourceHash: 'hash-abc',
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
    ],
    navigationTargets: [],
    spokenTokens: [],
    literalCommandRanges: [],
    blocks: [],
    outline: [],
    diagnostics: [],
    spokenWordCount: 3,
  } as unknown as CompiledScript;
}

/** Exactly what pressing `Present` does, and nothing more. */
function present(mode: 'voice' | 'manual' = 'voice'): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode,
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    stageGeneration: 4,
    sessionGeneration: 7,
    transcriptRetained: false,
  });
}

/** The lifecycle calls the driver received, in order. */
function holdCommands(): string[] {
  return driverCalls.filter((c) => c === 'start' || c === 'pause' || c === 'resume');
}

beforeEach(() => {
  vi.useFakeTimers();
  driverCalls.length = 0;
  setStageEmitterForTesting(async () => {});
});

afterEach(() => {
  clearSession();
  setStageEmitterForTesting(null);
  vi.useRealTimers();
});

describe('pressing Present starts following', () => {
  it('leaves following enabled, with no second button to press', () => {
    present();

    /*
     * The driver holds until told otherwise — a real guard against following a
     * stage that has not been told to start. What is not allowed is for the
     * hold to be the LAST word.
     */
    expect(holdCommands().at(-1), 'the take began with following held').toBe('start');
  });

  it('starts following after the driver exists, so the call can land', () => {
    present();

    expect(driverCalls[0], 'no driver was created for the take').toBe('created');
    expect(holdCommands()).toContain('start');
  });

  it('reports itself as prompting, so the Live bar offers Pause and not Start', () => {
    present();

    // The `Start` button renders on `!prompting`. A presenter who is already
    // talking must be offered the control that stops it, not the one that
    // appears to begin something that has plainly begun.
    expect(get(session).prompting).toBe(true);
    expect(get(session).paused).toBe('none');
  });

  it('starts a manual-mode take following too', () => {
    // Manual mode has no transcription, but the same driver and the same
    // construction-time hold — and a scroll-driven take that ignores the
    // scroll is the same defect wearing a different hat.
    present('manual');
    expect(holdCommands().at(-1)).toBe('start');
  });
});

describe('the deliberate pause still works', () => {
  it('pauses when the presenter asks, after the automatic start', () => {
    present();
    driverCalls.length = 0;

    pauseListening();

    expect(holdCommands()).toEqual(['pause']);
    expect(get(session).paused).toBe('listening');
  });
});
