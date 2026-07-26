/**
 * Pressing `Present` must leave the aligner able to follow.
 *
 * The defect this exists to prevent is the most expensive one this project has
 * had, and it was invisible to 1,474 passing tests:
 *
 *   `createWorkerTrackingDriver` posts `pause` to the tracking worker the
 *   instant it is built — §9.1, "hold position until the user explicitly
 *   starts prompting". A paused engine returns from `handleTranscriptEvent`
 *   before it looks at a single token. Nothing on the take path ever posted
 *   `resume`; only the `Start` button in the Live transport bar did.
 *
 * So a real take connected, recorded, transcribed and counted — "Words heard:
 * 26" — and followed none of it. "0 of 26 words (0%)", four takes running. The
 * store's own tests never saw it because every one of them calls
 * `startPrompting()` by hand before asserting anything, which is precisely the
 * call a presenter never makes.
 *
 * These tests therefore assert on the messages the WORKER receives, and they
 * never call `startPrompting()`. That is the whole point: if following depends
 * on a call the test has to make itself, the test is describing the developer's
 * knowledge of the app rather than the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
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
vi.mock('../../../src/control/services/smooth-follow-adapter', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/smooth-follow-adapter')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const { setTrackingWorkerFactoryForTesting } = await import(
  '../../../src/control/services/session'
);
const { clearSession, session, setStageEmitterForTesting, startLiveSession, pauseListening } =
  await import('../../../src/control/stores/session');

/** Every message the tracking worker was given, in order. */
const sent: Array<{ type: string }> = [];

function fakeWorker() {
  return {
    postMessage(message: unknown) {
      sent.push(message as { type: string });
    },
    addEventListener() {},
    terminate() {},
  };
}

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

/** The pause/resume commands only, which is the sequence under test. */
function holdCommands(): string[] {
  return sent.map((m) => m.type).filter((type) => type === 'pause' || type === 'resume');
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  setTrackingWorkerFactoryForTesting(fakeWorker);
  setStageEmitterForTesting(async () => {});
});

afterEach(() => {
  clearSession();
  setTrackingWorkerFactoryForTesting(null);
  setStageEmitterForTesting(null);
  vi.useRealTimers();
});

describe('pressing Present starts following', () => {
  it('leaves the aligner resumed, with no second button to press', () => {
    present();

    /*
     * The driver's construction-time `pause` is allowed to stay — it is a real
     * guard against following a stage that has not been told to start. What is
     * not allowed is for it to be the LAST word.
     */
    expect(holdCommands().at(-1), 'the take began with the aligner paused').toBe('resume');
  });

  it('posts the resume after the initialize, so the worker can act on it', () => {
    present();

    const types = sent.map((m) => m.type);
    const initialize = types.indexOf('initialize');
    const resume = types.indexOf('resume');
    expect(initialize, 'the worker was never initialized').toBeGreaterThanOrEqual(0);
    // The worker replies `not_initialized` and DROPS any message that arrives
    // first, so a resume posted ahead of the document is silently no resume.
    expect(resume).toBeGreaterThan(initialize);
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
    // construction-time pause — and a scroll-driven take that ignores the
    // scroll is the same defect wearing a different hat.
    present('manual');
    expect(holdCommands().at(-1)).toBe('resume');
  });
});

describe('the deliberate pause still works', () => {
  it('pauses when the presenter asks, after the automatic start', () => {
    present();
    sent.length = 0;

    pauseListening();

    expect(holdCommands()).toEqual(['pause']);
    expect(get(session).paused).toBe('listening');
  });
});
