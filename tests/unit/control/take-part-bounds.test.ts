/**
 * A take that is recording one part of a script (§parts).
 *
 * The feature's whole claim is that the bound is ADVISORY: it tells the app
 * what is being recorded without taking any control away from the presenter.
 * These tests pin both halves of that — that reaching the end of a part is
 * noticed and reported, and that nothing about reaching it stops, pauses or
 * otherwise touches the take.
 *
 * The latch is the subtle one. The aligner steps backwards routinely — an
 * accepted retake, a re-read, a correction after a lookalike hold — so a
 * completion flag computed fresh from the current position would appear and
 * disappear as the estimate moved around the boundary, at exactly the moment
 * somebody is standing at a camera deciding whether to stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { AlignmentSnapshot, CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
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
 * The store hands `handleSnapshot` to the driver it builds. Capturing it is how
 * these tests deliver alignment positions without a recogniser: it is the same
 * function a real take's snapshots arrive through.
 */
let deliverSnapshot: ((snapshot: AlignmentSnapshot) => void) | null = null;
const driverCalls: string[] = [];
vi.mock('../../../src/control/services/session', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/session')>();
  return {
    ...actual,
    createTrackingDriver: (options: { onSnapshot: (s: AlignmentSnapshot) => void }) => {
      deliverSnapshot = options.onSnapshot;
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

const { clearSession, session, startLiveSession, stopSession } =
  await import('../../../src/control/stores/session');

type TakePart = NonNullable<import('../../../src/control/stores/session').SessionState['part']>;

function compiledStub(): CompiledScript {
  /*
   * 200 tokens, and the arrays say so. An earlier version of this fixture
   * claimed `spokenWordCount: 200` over empty arrays, which is not a document
   * the compiler can produce and would have hidden any consumer that read the
   * tokens rather than the count.
   */
  const spokenTokens = Array.from({ length: 200 }, (_, index) => ({
    index,
    blockId: 'b-1',
    sentenceId: 's-1',
    surface: `w${index}`,
    normalized: `w${index}`,
    source: { utf16Start: index, utf16End: index + 1 },
  }));
  return {
    sourceHash: 'hash-abc',
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 199, normalizedText: 'words' },
    ],
    navigationTargets: [],
    spokenTokens,
    literalCommandRanges: [],
    blocks: [],
    outline: [],
    diagnostics: [],
    spokenWordCount: 200,
  } as unknown as CompiledScript;
}

const PART_TWO: TakePart = {
  id: 'p2',
  label: 'Pricing',
  ordinal: 2,
  totalParts: 3,
  startTokenIndex: 50,
  endTokenIndex: 99,
};

const PART_THREE: TakePart = {
  id: 'p3',
  label: 'Close',
  ordinal: 3,
  totalParts: 3,
  startTokenIndex: 100,
  endTokenIndex: 199,
};

function present(part: TakePart | null, nextPart: TakePart | null = null): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    startTokenIndex: part?.startTokenIndex ?? 0,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    sessionGeneration: 7,
    transcriptRetained: false,
    part,
    nextPart,
  });
}

let seq = 0;
/** One alignment snapshot placing the presenter at `confirmedToken`. */
function at(confirmedToken: number, decision: AlignmentSnapshot['decision'] = 'localConfirmed'): void {
  seq += 1;
  deliverSnapshot?.({
    sessionGeneration: 7,
    seq,
    state: 'following',
    decision,
    confirmedToken,
    observedToken: confirmedToken,
    rateTokensPerSecond: 2.5,
    evidenceAudioMs: 1_000 * seq,
    atAudioMs: 1_000 * seq,
    maxPredictionMs: 900,
    pauseOnsetMs: 1800,
    leadFloorMs: 550,
    maxLeadTokens: 2.5,
    leadMarginTokens: 1.2,
    leadEaseMs: 450,
    leadHoldMs: 0,
    leadDecayMs: 1200,
    displayLimitToken: 200,
    confidence: 0.9,
    suggestionToken: null,
    scriptLenTokens: 200,
    observedAtom: confirmedToken,
    confirmedAtom: confirmedToken,
  } satisfies AlignmentSnapshot);
}

beforeEach(() => {
  vi.useFakeTimers();
  driverCalls.length = 0;
  deliverSnapshot = null;
  seq = 0;
});

afterEach(() => {
  clearSession();
  vi.useRealTimers();
});

describe('a take bounded to a part', () => {
  it('carries the part, and starts not yet complete', () => {
    present(PART_TWO, PART_THREE);
    const s = get(session);
    expect(s.part).toEqual(PART_TWO);
    expect(s.nextPart).toEqual(PART_THREE);
    expect(s.partComplete).toBe(false);
  });

  it('is not complete part way through', () => {
    present(PART_TWO, PART_THREE);
    at(75);
    expect(get(session).partComplete).toBe(false);
  });

  it('completes when the confirmed position reaches the part end', () => {
    present(PART_TWO, PART_THREE);
    at(99);
    expect(get(session).partComplete).toBe(true);
  });

  it('completes when the presenter reads straight past the boundary', () => {
    present(PART_TWO, PART_THREE);
    at(140);
    expect(get(session).partComplete).toBe(true);
  });

  it('stays complete when the aligner steps back over the boundary', () => {
    present(PART_TWO, PART_THREE);
    at(99);
    // A retake, a re-read, or a correction after a lookalike hold. None of them
    // means the part was un-finished.
    at(70);
    expect(get(session).partComplete).toBe(true);
  });

  it('does nothing to the take when the part ends', () => {
    present(PART_TWO, PART_THREE);
    const before = driverCalls.length;
    at(99);
    const s = get(session);
    // Asserted so the "no commands" observation below is known to follow a real
    // boundary crossing rather than a snapshot that did nothing at all.
    expect(s.partComplete, 'the snapshot did not complete the part').toBe(true);
    expect(driverCalls.slice(before), 'the take was steered by reaching a part end').toEqual([]);
    expect(s.active).toBe(true);
    expect(s.prompting).toBe(true);
    expect(s.paused).toBe('none');
  });

  it('does not complete a part from the manual anchor it opens with', () => {
    /*
     * Every bounded take opens by anchoring the engine at the part's first
     * token, and Rust publishes that position as a snapshot. A part short
     * enough that its start IS its end was therefore reported read to the end
     * before a word was said.
     */
    const oneToken: TakePart = { ...PART_TWO, startTokenIndex: 50, endTokenIndex: 50 };
    present(oneToken, PART_THREE);
    at(50, 'manualAnchor');
    expect(get(session).partComplete).toBe(false);
  });

  it('does not complete a part from a manual jump past its end', () => {
    // Stepping forward through the script is how somebody SKIPS a passage.
    present(PART_TWO, PART_THREE);
    at(150, 'manualAnchor');
    expect(get(session).partComplete).toBe(false);
  });

  it('still completes on spoken evidence after a manual jump', () => {
    present(PART_TWO, PART_THREE);
    at(150, 'manualAnchor');
    expect(get(session).partComplete).toBe(false);
    at(99);
    expect(get(session).partComplete).toBe(true);
  });

  it('reports the part, its completion and the next one on the summary', () => {
    present(PART_TWO, PART_THREE);
    at(99);
    const summary = stopSession();
    expect(summary.part).toEqual(PART_TWO);
    expect(summary.partComplete).toBe(true);
    expect(summary.nextPart).toEqual(PART_THREE);
  });

  it('reports a part that was not finished as unfinished', () => {
    present(PART_TWO, PART_THREE);
    at(60);
    const summary = stopSession();
    expect(summary.part).toEqual(PART_TWO);
    expect(summary.partComplete).toBe(false);
  });

  it('offers no next part for the last one', () => {
    present(PART_THREE, null);
    at(199);
    const summary = stopSession();
    expect(summary.partComplete).toBe(true);
    expect(summary.nextPart).toBeNull();
  });
});

describe('an unbounded take', () => {
  it('has no part and never completes one', () => {
    present(null);
    at(199);
    const s = get(session);
    expect(s.part).toBeNull();
    expect(s.partComplete).toBe(false);
  });

  it('reports no part on the summary', () => {
    present(null);
    at(199);
    const summary = stopSession();
    expect(summary.part).toBeNull();
    expect(summary.nextPart).toBeNull();
    expect(summary.partComplete).toBe(false);
  });
});
