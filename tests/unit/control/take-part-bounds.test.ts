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
import type {
  AlignmentSnapshot,
  CompiledScript,
  OutlineNode,
  SentenceUnit,
} from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
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

const {
  anchorManualScroll,
  autoScrollReachedEnd,
  clearSession,
  moveSentences,
  restartParagraph,
  session,
  startLiveSession,
  stopSession,
  toggleAutoScroll,
} = await import('../../../src/control/stores/session');
const { summaryActions } = await import('../../../src/control/lib/summary-actions');

type TakePart = NonNullable<import('../../../src/control/stores/session').SessionState['part']>;

function compiledStub(tokenCount = 200): CompiledScript {
  /*
   * 200 tokens, and the arrays say so. An earlier version of this fixture
   * claimed `spokenWordCount: 200` over empty arrays, which is not a document
   * the compiler can produce and would have hidden any consumer that read the
   * tokens rather than the count.
   */
  const spokenTokens = Array.from({ length: tokenCount }, (_, index) => ({
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
      {
        id: 's-1',
        blockId: 'b-1',
        startTokenIndex: 0,
        endTokenIndex: Math.max(0, tokenCount - 1),
        normalizedText: 'words',
      },
    ],
    navigationTargets: [],
    spokenTokens,
    literalCommandRanges: [],
    blocks: [],
    outline: [],
    diagnostics: [],
    spokenWordCount: tokenCount,
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

function present(
  part: TakePart | null,
  nextPart: TakePart | null = null,
  shape: {
    outline?: OutlineNode[];
    sentences?: SentenceUnit[];
    compiled?: CompiledScript | null;
    totalTokens?: number;
    /** Where the take opens, when that is not the part's own start. */
    startTokenIndex?: number;
  } = {},
): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: shape.outline ?? [],
    sentences: shape.sentences ?? [],
    totalTokens: shape.totalTokens ?? 200,
    startTokenIndex: shape.startTokenIndex ?? part?.startTokenIndex ?? 0,
    sessionId: 'session-uuid-1',
    compiled: shape.compiled === undefined ? compiledStub() : shape.compiled,
    sessionGeneration: 7,
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
  records.endSessionRecord.mockClear();
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

/*
 * #276. Auto-scroll pauses following, so the aligner publishes nothing while
 * the transport rolls, and the take's ending used to be read off the last
 * snapshot — wherever the roll BEGAN. These pin the one fact the stage does
 * report, that the document ran off its end, as the place the take ended.
 */
describe('a take the auto-scroll transport carried to the end', () => {
  /** Press A, and let the stage run the document off its end. */
  function rollToEnd(): void {
    toggleAutoScroll();
    autoScrollReachedEnd('document_end');
  }

  function heading(id: string, title: string, start: number, end: number): OutlineNode {
    return {
      id,
      level: 1,
      title,
      normalizedTitle: title.toLowerCase(),
      blockId: 'b-1',
      startTokenIndex: start,
      endTokenIndex: end,
      children: [],
    };
  }

  function sentence(id: string, start: number, end: number): SentenceUnit {
    return {
      id,
      blockId: 'b-1',
      startTokenIndex: start,
      endTokenIndex: end,
      normalizedText: 'words',
      source: { utf16Start: start, utf16End: end },
    };
  }

  it('ends where the transport left the script, not where the roll began', () => {
    // The issue's own reproduction: part three, auto-scroll on, rolled to the
    // end, take ended.
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    const summary = stopSession();
    expect(summary.mode).toBe('voice');
    expect(summary.endTokenIndex).toBe(199);
    expect(summary.partComplete).toBe(true);
    expect(summary.partRolledToEnd).toBe(true);
  });

  it('records the same ending on the session row, which is what "From last ending" reads', () => {
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    stopSession();
    expect(records.endSessionRecord).toHaveBeenCalledTimes(1);
    expect(records.endSessionRecord).toHaveBeenCalledWith(
      'session-uuid-1',
      expect.objectContaining({ endTokenIndex: 199 }),
    );
  });

  it('ends at the end of the SCRIPT, past the part, and offers the next part', () => {
    // The stage renders the whole document; a part only sets where the take
    // opens. Running off the end therefore carried the take through part two
    // and the whole of part three.
    present(PART_TWO, PART_THREE);
    at(50, 'manualAnchor');
    rollToEnd();
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(199);
    expect(summary.partComplete).toBe(true);
    const actions = summaryActions({
      retrySectionTokenIndex: summary.sectionStartTokenIndex,
      part: summary.part,
      partComplete: summary.partComplete,
      nextPart: summary.nextPart,
    });
    expect(actions.find((a) => a.primary)?.id).toBe('record-next-part');
  });

  it('does not call a part the presenter had already read "carried"', () => {
    present(PART_TWO, PART_THREE);
    at(99);
    rollToEnd();
    const summary = stopSession();
    expect(summary.partComplete).toBe(true);
    expect(summary.partRolledToEnd).toBe(false);
  });

  it('credits nothing when the transport had nowhere to go', () => {
    // A script that fits on the glass reports its end on the first frame,
    // having moved nothing at all.
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    toggleAutoScroll();
    autoScrollReachedEnd('nowhere_to_go');
    const s = get(session);
    expect(s.autoScroll.running, 'the transport was not stood down').toBe(false);
    expect(s.voiceFollow, 'the pause the transport took was not given back').toBe(true);
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(100);
    expect(summary.partComplete).toBe(false);
    expect(summary.partRolledToEnd).toBe(false);
  });

  it('is not pulled back by a voice snapshot from where the roll began', () => {
    /*
     * Following is handed back when the transport stands down, and nothing ever
     * told the aligner the document moved — so the next snapshot it publishes
     * describes the stale place the roll started from.
     */
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    at(104);
    expect(get(session).snapshot?.confirmedToken, 'the stale snapshot was never delivered').toBe(104);
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(199);
  });

  it('is not erased by a late answer to a move made before the roll ended', () => {
    /*
     * Every move waits on the engine being installed, and a part-bounded take
     * issues its opening anchor before that has happened. On a short last part
     * the roll can reach the end first — and Rust's answer to the opening
     * anchor then arrives as a `manualAnchor` the operator did not make after
     * the roll.
     */
    present(PART_THREE, null);
    rollToEnd();
    at(100, 'manualAnchor');
    expect(stopSession().endTokenIndex).toBe(199);
  });

  it('gives the ending back to the operator when they scroll the take by hand', () => {
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    anchorManualScroll(140);
    at(140, 'manualAnchor');
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(140);
    // The part was still carried to its end; moving back does not un-carry it,
    // on the same latch voice completion uses.
    expect(summary.partComplete).toBe(true);
    expect(summary.partRolledToEnd).toBe(true);
  });

  it('gives the ending back to the operator when they step a sentence', () => {
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    moveSentences(-1);
    at(150, 'manualAnchor');
    expect(stopSession().endTokenIndex).toBe(150);
  });

  it('forgets the roll on a retake, which opens a new pass', () => {
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    restartParagraph();
    expect(stopSession().endTokenIndex).toBe(100);
  });

  it('forgets the roll when the transport is started again', () => {
    // A roll stopped part way has no position anywhere (the stage reports only
    // the end), so the ending falls back to the last snapshot — but it must
    // not keep claiming an end the document has since been taken away from.
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    toggleAutoScroll();
    toggleAutoScroll();
    expect(stopSession().endTokenIndex).toBe(100);
  });

  it('does not count the roll as words followed, jumps or sections reached', () => {
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    const summary = stopSession();
    expect(summary.wordsFollowed).toBe(0);
    expect(summary.manualJumps).toBe(0);
    expect(summary.sectionsReached).toBe(1);
  });

  it('names the ending from the outline even with no snapshot at all', () => {
    present(PART_THREE, null, {
      outline: [heading('h-1', 'Opening', 0, 99), heading('h-2', 'Close', 100, 199)],
    });
    rollToEnd();
    const summary = stopSession();
    expect(summary.endingLocation).toBe('Close');
    expect(summary.sectionStartTokenIndex).toBe(100);
  });

  it('names the last sentence in a script with no headings', () => {
    present(PART_THREE, null, {
      sentences: [sentence('s-1', 0, 99), sentence('s-2', 100, 149), sentence('s-3', 150, 199)],
    });
    rollToEnd();
    expect(stopSession().endingLocation).toBe('Sentence 3 of 3');
  });

  it('still says "Beginning" for a take that went nowhere and heard nothing', () => {
    present(null);
    expect(stopSession().endingLocation).toBe('Beginning');
  });

  it('ends an unbounded take at the end of the script without claiming a part', () => {
    present(null);
    rollToEnd();
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(199);
    expect(summary.partComplete).toBe(false);
    expect(summary.partRolledToEnd).toBe(false);
  });

  it('ignores an end reported for a transport that is not running', () => {
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    autoScrollReachedEnd('document_end');
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(100);
    expect(summary.partComplete).toBe(false);
  });

  it('ignores an end that arrives after the take has stopped', () => {
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    toggleAutoScroll();
    const summary = stopSession();
    const after = get(session);
    autoScrollReachedEnd('document_end');
    // Not one write: no stand-down, no follow-timeline entry, nothing to the
    // summary the presenter is already looking at.
    expect(get(session)).toBe(after);
    expect(summary.endTokenIndex).toBe(100);
    expect(summary.partComplete).toBe(false);
  });

  it('credits no position to an empty script, whatever the padded count says', () => {
    // `startTake` hands over at least one token so the aligner has an array to
    // anchor in; an empty compile still has nothing to have rolled through.
    const onlyToken: TakePart = { ...PART_THREE, startTokenIndex: 0, endTokenIndex: 0 };
    present(onlyToken, null, { compiled: compiledStub(0), totalTokens: 1 });
    rollToEnd();
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(0);
    expect(summary.partComplete).toBe(false);
    expect(summary.partRolledToEnd).toBe(false);
  });

  it('ends at the last token of the count when there is no compile to read', () => {
    present(PART_THREE, null, { compiled: null });
    rollToEnd();
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(199);
    expect(summary.partRolledToEnd).toBe(true);
  });

  it('does not carry a roll into the next take', () => {
    present(PART_THREE, null);
    at(100, 'manualAnchor');
    rollToEnd();
    stopSession();
    present(PART_TWO, PART_THREE);
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(50);
    expect(summary.partComplete).toBe(false);
    expect(summary.partRolledToEnd).toBe(false);
  });
});

/*
 * #285 — "Script followed" is measured against what the take was given.
 *
 * It was a fraction of the whole script every time: a 50-word part read to its
 * last word reported 49 of 200 words (25%), and a "From here" take near the end
 * of a script could never look complete.
 */
describe('script followed, out of what the take was given', () => {
  function coverage() {
    const { wordsFollowed, coverageWords, coverageScope } = stopSession();
    return { wordsFollowed, coverageWords, coverageScope };
  }

  it('measures a whole-part take against the part', () => {
    present(PART_TWO, PART_THREE);
    at(50, 'manualAnchor');
    at(99);
    // Still a distance, as it always was: first word to last is N-1 of N.
    expect(coverage()).toEqual({ wordsFollowed: 49, coverageWords: 50, coverageScope: 'part' });
  });

  it('does not credit reading on past the end of the part', () => {
    present(PART_TWO, PART_THREE);
    at(140);
    expect(coverage()).toEqual({ wordsFollowed: 49, coverageWords: 50, coverageScope: 'part' });
  });

  it('measures a take begun part way into a part against the rest of it', () => {
    present(PART_TWO, PART_THREE, { startTokenIndex: 75 });
    at(99);
    expect(coverage()).toEqual({
      wordsFollowed: 24,
      coverageWords: 25,
      coverageScope: 'restOfPart',
    });
  });

  it('measures an unbounded take begun part way in against the rest of the script', () => {
    present(null, null, { startTokenIndex: 150 });
    at(199);
    expect(coverage()).toEqual({
      wordsFollowed: 49,
      coverageWords: 50,
      coverageScope: 'restOfScript',
    });
  });

  it('measures a take from the top against the whole script', () => {
    present(null);
    at(100);
    expect(coverage()).toEqual({ wordsFollowed: 100, coverageWords: 200, coverageScope: 'script' });
  });

  it('measures a retake from where it began, as the words followed are', () => {
    present(PART_TWO, PART_THREE);
    at(75);
    restartParagraph();
    at(99);
    expect(coverage()).toEqual({
      wordsFollowed: 24,
      coverageWords: 25,
      coverageScope: 'restOfPart',
    });
  });

  it('does not credit the run-up to a part to a retake begun above it', () => {
    present(PART_TWO, PART_THREE);
    at(30, 'manualAnchor');
    restartParagraph();
    at(60);
    expect(coverage()).toEqual({ wordsFollowed: 10, coverageWords: 50, coverageScope: 'part' });
  });
});
