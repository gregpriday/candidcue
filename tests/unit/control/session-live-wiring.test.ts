/**
 * C1 / C2 regression — the things a packaged build needed and did not have.
 *
 * The defect these guard survived 2038 green vitest tests, because every one of
 * them stopped at the seam: the store was tested, the stage renderer was tested,
 * and nothing asserted that the numbers crossing between them agreed or that
 * anything was ever sent at all.
 *
 * What each test here would catch on revert:
 *  1. `sessionGeneration` back to a hard-coded 1 → the relayed snapshot carries
 *     1 instead of the generation Rust assigned, and Rust drops it;
 *  2. `publishSemanticFrame` removed → `stage://semantic-frame` has no producer
 *     again and the stage's whole v2 motion engine receives nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { STAGE_EVENT } from '../../../src/shared/contracts';
import type { AlignmentSnapshot, CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
}));

/**
 * The voice pipeline is stubbed so the test can drive its callbacks directly —
 * a real transport cannot be stood up in node.
 */
const pipeline = vi.hoisted(() => {
  const captured: {
    deps: Record<string, (...args: never[]) => unknown> | null;
    /** The live instance, so a test can make one of its methods misbehave. */
    instance: unknown;
  } = { deps: null, instance: null };
  class FakePipeline {
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
      captured.instance = this;
    }
    async switchMicrophone(): Promise<void> {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  }
  return { captured, FakePipeline };
});

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
/*
 * A vi.mock of `services/semantic-sidecar` used to sit here.
 *
 * The OpenAI semantic sidecar was removed from the product; the module does
 * not exist. Nothing imports it, so the mock never applied and the factory
 * below it — a whole fake scheduler with token budgets and cost estimates —
 * was inert. It survived because a mock of a missing module is silent: vitest
 * only resolves the path if something asks for it. The repository completeness
 * gate (scripts/verify-repository.mjs) is what finally named it.
 */
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
/*
 * The snapshot feed arrives from Rust over a Tauri event channel, which does
 * not exist in node. Capturing the subscription lets a test push a snapshot
 * through the REAL driver and the REAL store, which is the only way to assert
 * on anything the take summary accumulates.
 */
const alignmentFeed: { push: ((snapshot: unknown) => void) | null } = { push: null };
vi.mock('../../../src/control/services/alignment', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/alignment')>();
  return {
    ...actual,
    subscribeAlignmentSnapshots: (handler: (snapshot: never) => void) => {
      alignmentFeed.push = handler as (snapshot: unknown) => void;
      return () => {
        alignmentFeed.push = null;
      };
    },
  };
});

const { setInvokeForTesting } = await import('../../../src/control/services/ipc');
const { compile } = await import('../../../src/shared/markdown');
const {
  autoScrollLive,
  autoScrollReachedEnd,
  awaitPendingPersistence,
  clearSession,
  goToToken,
  hardPause,
  moveSentences,
  pauseListening,
  restartParagraph,
  session,
  startLiveSession,
  startPrompting,
  stopSession,
  toggleAutoScroll,
  togglePlayPause,
  toggleVoiceFollow,
} = await import('../../../src/control/stores/session');
const { smoothFollow } = await import('../../../src/control/stores/smooth-follow');
const { resolveTakeOutcome } = await import('../../../src/control/lib/take-outcome');
const { toasts, clearToasts } = await import('../../../src/control/stores/toasts');

/** Enough of a CompiledScript for the store and for the alignment handshake. */
function compiledStub(): CompiledScript {
  return {
    sourceHash: 'hash-abc',
    spokenTokens: [
      { index: 0, blockId: 'b-1', sentenceId: 's-1', surface: 'Hello', normalized: 'hello' },
      { index: 1, blockId: 'b-1', sentenceId: 's-1', surface: 'there', normalized: 'there' },
    ],
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
    ],
    navigationTargets: [],
    literalCommandRanges: [],
  } as unknown as CompiledScript;
}

interface StartOverrides {
  sessionGeneration?: number;
  mode?: 'voice' | 'manual';
  /** A real compile, for tests that navigate by sentence. */
  compiled?: CompiledScript;
  sentences?: Array<{
    id: string;
    blockId: string;
    startTokenIndex: number;
    endTokenIndex: number;
    normalizedText: string;
  }>;
  practice?: boolean;
}

function start(overrides: StartOverrides = {}): string {
  return startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: overrides.mode ?? 'voice',
    displayLabel: 'Stage',
    // A real compile brings its own outline and length, as `startTake` hands
    // them over; the stub has neither and stands in for degraded input.
    outline: overrides.compiled?.outline ?? [],
    sentences: (overrides.sentences ?? []) as never,
    totalTokens: overrides.compiled?.spokenTokens.length ?? 200,
    sessionId: 'session-uuid-1',
    compiled: overrides.compiled ?? compiledStub(),
    sessionGeneration: overrides.sessionGeneration ?? 7,
    practice: overrides.practice,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Toasts are module state shared by every test in this file, and several
  // here count them. A test that raises one must not be able to change what
  // the next one sees.
  clearToasts();
  invoked.length = 0;
  setInvokeForTesting(async (command, args) => {
    invoked.push({ command, args });
    return undefined as never;
  });
  records.endSessionRecord.mockClear();
  pipeline.captured.deps = null;
  pipeline.captured.instance = null;
});

afterEach(() => {
  clearSession();
  setInvokeForTesting(null);
  vi.useRealTimers();
});

/** Every IPC command the store issued, in order. */
const invoked: Array<{ command: string; args?: Record<string, unknown> }> = [];

/**
 * C1 — the session generation control hands Rust is the one Rust assigned.
 *
 * The hard-coded `1` is what `validate_stage_payload_header` compared against a
 * coordinator sitting elsewhere, and dropped. Motion no longer travels through
 * control at all, but the generation still does: it is the argument that pairs
 * an alignment session with the socket feeding it, and Rust drops every
 * transcript frame whose generation does not match.
 */
describe('C1 — the generation control hands Rust is the one Rust assigned', () => {
  it('starts alignment under the assigned generation, not a literal 1', async () => {
    start({ sessionGeneration: 7 });
    startPrompting();
    await vi.advanceTimersByTimeAsync(0);
    const call = invoked.find((c) => c.command === 'start_alignment');
    expect(call, 'the take never started an alignment session').toBeDefined();
    expect(call?.args?.generation).toBe(7);
    expect(call?.args?.generation).not.toBe(1);
  });

  it('adopts a different generation for the next take rather than reusing one', async () => {
    start({ sessionGeneration: 7 });
    startPrompting();
    await vi.advanceTimersByTimeAsync(0);
    stopSession();
    clearSession();
    invoked.length = 0;

    start({ sessionGeneration: 8 });
    startPrompting();
    await vi.advanceTimersByTimeAsync(0);
    const call = invoked.find((c) => c.command === 'start_alignment');
    expect(call?.args?.generation).toBe(8);
  });

  it('stops the alignment session when the take ends', async () => {
    start({ sessionGeneration: 7 });
    startPrompting();
    stopSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoked.some((c) => c.command === 'stop_alignment')).toBe(true);
  });
});

/**
 * #214 — the take history and the retained transcript are gone, and these are
 * the two things that used to ride along with them and must not have gone too.
 *
 * `beginTake` was the only reset of a pass's follow measurements, and it sat
 * beside the take-row write; the session row shared `pendingPersistence` with
 * the transcript appends. Removing either neighbour carelessly takes these
 * with it, and neither failure shows anywhere but a summary or a quit.
 */
describe('#214 — a take keeps its summary and its session row without the history', () => {
  const SOURCE =
    '# Opening\n\nFirst sentence of the opening. Second sentence of the opening.\n\n' +
    '## Middle\n\nThird sentence in the middle. Fourth sentence in the middle.\n\n' +
    '## Close\n\nFifth sentence near the close. Sixth and final sentence of the close.\n';

  let seq = 0;

  function heardAt(token: number): Record<string, unknown> {
    seq += 1;
    return {
      sessionGeneration: 7,
      seq,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: token,
      observedToken: token,
      rateTokensPerSecond: 2,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 900,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 200,
      observedAtom: token,
      confirmedAtom: token,
    };
  }

  function startScript() {
    const compiled = compile(SOURCE, { scriptId: 'script-1' });
    start({ compiled, sentences: compiled.sentences as never });
    return compiled;
  }

  beforeEach(() => {
    seq = 0;
  });

  it('measures a restarted paragraph from where the new pass began', async () => {
    const compiled = startScript();
    await vi.advanceTimersByTimeAsync(0);
    const restartAt = compiled.sentences[2]!.startTokenIndex;
    alignmentFeed.push?.(heardAt(compiled.sentences[1]!.startTokenIndex));
    await vi.advanceTimersByTimeAsync(1000);
    alignmentFeed.push?.(heardAt(restartAt));

    restartParagraph();
    const reached = compiled.sentences[3]!.startTokenIndex;
    alignmentFeed.push?.(heardAt(reached));

    // The distance THIS pass travelled. Carrying the first pass's start (0)
    // into the retake would report the whole document up to here.
    expect(stopSession().wordsFollowed).toBe(reached - restartAt);
  });

  it('gives a retake that has heard nothing yet no following share', async () => {
    const compiled = startScript();
    await vi.advanceTimersByTimeAsync(0);
    alignmentFeed.push?.(heardAt(compiled.sentences[1]!.startTokenIndex));
    await vi.advanceTimersByTimeAsync(1000);
    alignmentFeed.push?.(heardAt(compiled.sentences[2]!.startTokenIndex));

    restartParagraph();
    // Time passes on the new pass, so a zero-length pass cannot be what makes
    // the share null — only the reset of the snapshot history can.
    await vi.advanceTimersByTimeAsync(500);

    const summary = stopSession();
    expect(summary.followingShare, 'the first pass’s snapshots belong to the first pass').toBeNull();
    expect(summary.wordsFollowed).toBe(0);
  });

  it('counts sections reached across the whole session, not per pass', async () => {
    const compiled = startScript();
    await vi.advanceTimersByTimeAsync(0);
    const [opening, , middle, , close] = compiled.sentences;
    alignmentFeed.push?.(heardAt(opening!.startTokenIndex));
    alignmentFeed.push?.(heardAt(middle!.startTokenIndex));

    restartParagraph();
    alignmentFeed.push?.(heardAt(close!.startTokenIndex));
    alignmentFeed.push?.(heardAt(opening!.startTokenIndex));

    // Opening, Middle and Close — each once, though Opening was read twice and
    // the retake opened a pass that had reached none of them yet.
    const summary = stopSession();
    expect(summary.sectionsReached).toBe(3);
    const [, recorded] = records.endSessionRecord.mock.calls.at(-1) as unknown as [
      string,
      { metrics?: { sectionsReached: number } },
    ];
    expect(recorded.metrics?.sectionsReached).toBe(3);
  });

  it('closes a practice’s session row once, with where it ended', async () => {
    const compiled = compile(SOURCE, { scriptId: 'script-1' });
    start({ compiled, sentences: compiled.sentences as never, practice: true });
    await vi.advanceTimersByTimeAsync(0);
    const ended = compiled.sentences[3]!.startTokenIndex;
    alignmentFeed.push?.(heardAt(ended));

    stopSession();
    expect(get(session).summary, 'a practice opens no report').toBeNull();
    stopSession();
    clearSession();

    expect(records.endSessionRecord).toHaveBeenCalledTimes(1);
    const [, recorded] = records.endSessionRecord.mock.calls[0] as unknown as [
      string,
      { endTokenIndex?: number },
    ];
    expect(recorded.endTokenIndex, 'Editor starts the next take from here').toBe(ended);
  });

  it('closes the session record on stop, with the §36.1 aggregate metrics', () => {
    start();
    startPrompting();
    // One real snapshot through the real driver: `sectionsReached` is a fact
    // about alignment output, and a take that produced none has reached none.
    alignmentFeed.push?.({
      sessionGeneration: 7,
      seq: 1,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: 1,
      observedToken: 2,
      rateTokensPerSecond: 2.5,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 900,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 200,
      observedAtom: 2,
      confirmedAtom: 1,
    });
    vi.advanceTimersByTime(1600 * 3);
    stopSession();

    expect(records.endSessionRecord).toHaveBeenCalledTimes(1);
    const [sessionId, summary] = records.endSessionRecord.mock.calls[0] as unknown as [
      string,
      { endTokenIndex?: number; metrics?: { sectionsReached: number } },
    ];
    expect(sessionId).toBe('session-uuid-1');
    expect(typeof summary.endTokenIndex).toBe('number');
    // No outline at all: the whole script is the one section the take was in.
    expect(summary.metrics?.sectionsReached).toBe(1);
  });

  it('holds shutdown until the session row is written', async () => {
    const deferred: { resolve?: () => void } = {};
    records.endSessionRecord.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          deferred.resolve = () => resolve(null);
        }),
    );
    start();
    startPrompting();
    stopSession();

    try {
      let drained = false;
      void awaitPendingPersistence().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained, 'the quit must wait for the ending token Editor reads').toBe(false);

      deferred.resolve?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(true);
    } finally {
      // `pendingPersistence` is module state: a write left hanging by a failed
      // assertion would hold every later wait in this file.
      deferred.resolve?.();
      await awaitPendingPersistence();
    }
  });
});

/**
 * #285 — "Sections reached" counts sections, and the session row agrees.
 *
 * It counted authored BLOCKS, and every paragraph is a block: two headings over
 * six paragraphs, followed end to end through the real compiler and store,
 * reported six.
 */
describe('#285 — sections reached counts sections, not paragraphs', () => {
  let seq = 0;

  /**
   * A complete snapshot, typed as the real subscription would demand it — the
   * mocked feed forwards whatever it is given, so a short payload here would
   * prove nothing about one that could cross the actual boundary.
   */
  function snapshotAt(
    compiled: CompiledScript,
    confirmedToken: number,
    decision: AlignmentSnapshot['decision'] = 'localConfirmed',
  ): AlignmentSnapshot {
    seq += 1;
    return {
      sessionGeneration: 7,
      seq,
      state: 'following',
      decision,
      confirmedToken,
      observedToken: confirmedToken,
      rateTokensPerSecond: 2,
      evidenceAudioMs: 1000 * seq,
      atAudioMs: 1000 * seq,
      maxPredictionMs: 900,
      pauseOnsetMs: 1800,
      leadFloorMs: 550,
      maxLeadTokens: 2.5,
      leadMarginTokens: 1.2,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
      displayLimitToken: compiled.spokenTokens.length,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: compiled.spokenTokens.length,
      observedAtom: Math.floor(confirmedToken),
      confirmedAtom: Math.floor(confirmedToken),
    } satisfies AlignmentSnapshot;
  }

  /** Follow every sentence of `compiled`, in order, as a voice take would. */
  function followAll(
    compiled: CompiledScript,
    decision: AlignmentSnapshot['decision'] = 'localConfirmed',
  ): void {
    for (const sentence of compiled.sentences) {
      alignmentFeed.push?.(snapshotAt(compiled, sentence.endTokenIndex, decision));
    }
  }

  function recordedSections(): number | undefined {
    const [, recorded] = records.endSessionRecord.mock.calls.at(-1) as unknown as [
      string,
      { metrics?: { sectionsReached: number } },
    ];
    return recorded.metrics?.sectionsReached;
  }

  function paragraphs(prefix: string): string {
    return [1, 2, 3].map((n) => `The ${prefix} paragraph number ${n} is here.`).join('\n\n');
  }

  /** Two sections, three paragraphs each, with no division into parts. */
  function undivided(): CompiledScript {
    const compiled = compile(
      `# Setup\n\n${paragraphs('setup')}\n\n## Demo\n\n${paragraphs('demo')}\n`,
      { scriptId: 'script-1' },
    );
    expect(compiled.parts).toEqual([]);
    return compiled;
  }

  beforeEach(() => {
    seq = 0;
  });

  it('reports two sections for two headings over six paragraphs', async () => {
    // The issue's own script. Two headings at one level divide it into two
    // parts, so this is the parts path.
    const compiled = compile(
      `## Setup\n\n${paragraphs('setup')}\n\n## Demo\n\n${paragraphs('demo')}\n`,
      { scriptId: 'script-1' },
    );
    expect(new Set(compiled.sentences.map((s) => s.blockId)).size).toBe(6);
    expect((compiled.parts ?? []).map((p) => p.label)).toEqual(['Setup', 'Demo']);
    start({ compiled, sentences: compiled.sentences as never });
    await vi.advanceTimersByTimeAsync(0);
    followAll(compiled);

    expect(stopSession().sectionsReached).toBe(2);
    expect(recordedSections()).toBe(2);
  });

  it('counts headings on a script that does not divide', async () => {
    // One H1 over one H2 has a single top-level heading, so there are no
    // parts, and the outline is what is counted.
    const compiled = undivided();
    start({ compiled, sentences: compiled.sentences as never });
    await vi.advanceTimersByTimeAsync(0);
    followAll(compiled);

    expect(stopSession().sectionsReached).toBe(2);
    expect(recordedSections()).toBe(2);
  });

  it('counts parts on a divided script, and still names the heading it ended in', async () => {
    // Two take markers over three headings: the count is of parts, the ending
    // is as precise as the outline can make it.
    const compiled = compile(
      [
        '[Take: First]',
        '## Alpha',
        'Alpha has a sentence of its own.',
        '## Beta',
        'Beta has a sentence of its own.',
        '[Take: Second]',
        '## Gamma',
        'Gamma has a sentence of its own.',
      ].join('\n\n'),
      { scriptId: 'script-1' },
    );
    expect((compiled.parts ?? []).map((p) => p.label)).toEqual(['First', 'Second']);
    start({ compiled, sentences: compiled.sentences as never });
    await vi.advanceTimersByTimeAsync(0);
    followAll(compiled);

    const summary = stopSession();
    expect(summary.sectionsReached).toBe(2);
    expect(summary.endingLocation).toBe('Gamma');
    expect(recordedSections()).toBe(2);
  });

  it('counts a heading only once its first word is reached', async () => {
    const compiled = undivided();
    const demo = compiled.outline[0]!.children[0]!;
    start({ compiled, sentences: compiled.sentences as never });
    await vi.advanceTimersByTimeAsync(0);
    alignmentFeed.push?.(snapshotAt(compiled, compiled.sentences[0]!.endTokenIndex));
    // Half a token short of the heading: still finishing the last section.
    // Rounding would have put it in Demo.
    alignmentFeed.push?.(snapshotAt(compiled, demo.startTokenIndex - 0.5));
    expect(get(session).sectionsSeen).toHaveLength(1);

    alignmentFeed.push?.(snapshotAt(compiled, demo.startTokenIndex));
    expect(stopSession().sectionsReached).toBe(2);
    expect(recordedSections()).toBe(2);
  });

  it('counts a document with no outline as one section, however many paragraphs', async () => {
    // Degraded input — the compiler always emits an outline — but six
    // paragraphs is still one script, not six sections.
    const compiled = { ...undivided(), outline: [], parts: [] } as CompiledScript;
    start({ compiled, sentences: compiled.sentences as never });
    await vi.advanceTimersByTimeAsync(0);
    followAll(compiled);

    expect(stopSession().sectionsReached).toBe(1);
    expect(recordedSections()).toBe(1);
  });

  it('counts the sections a manual take is stepped through', async () => {
    // A manual take moves by nothing but anchors, so they have to count.
    const compiled = undivided();
    start({ compiled, sentences: compiled.sentences as never, mode: 'manual' });
    await vi.advanceTimersByTimeAsync(0);
    followAll(compiled, 'manualAnchor');
    // And back again: a revisit is not another section.
    alignmentFeed.push?.(snapshotAt(compiled, 0, 'manualAnchor'));

    expect(stopSession().sectionsReached).toBe(2);
    expect(recordedSections()).toBe(2);
  });

  it('records a practice’s sections on its row, though it opens no report', async () => {
    const compiled = undivided();
    start({ compiled, sentences: compiled.sentences as never, practice: true });
    await vi.advanceTimersByTimeAsync(0);
    followAll(compiled);

    expect(stopSession().sectionsReached).toBe(2);
    expect(get(session).summary).toBeNull();
    expect(recordedSections()).toBe(2);
  });

  it('has reached nothing when nothing was followed', () => {
    const compiled = undivided();
    start({ compiled, sentences: compiled.sentences as never });
    expect(stopSession().sectionsReached).toBe(0);
    expect(recordedSections()).toBe(0);
  });

  it('gives a stop with no session no denominator from an earlier one', () => {
    start();
    stopSession();
    clearSession();
    const empty = stopSession();
    expect(empty.coverageWords).toBe(0);
    expect(empty.wordsFollowed).toBe(0);
  });
});

/**
 * #286 — a stop with no session to stop claims no refused speech model.
 *
 * `emptySummary` is the shape-complete zero, and with no take there was no
 * start for a model to be refused on.
 */
describe('#286 — the empty summary does not report voice following as unavailable', () => {
  it('reports voice following available for a stop that had no session to stop', () => {
    const summary = stopSession();
    expect(summary.voiceFollowingAvailable).toBe(true);
  });
});

/**
 * §115 — the ending location is presenter-facing copy, so it may not be in
 * engine units.
 *
 * `Token 417` is a measured span index. It is not a word count, it appears
 * nowhere else the presenter can see, and nobody reading the summary can
 * convert it into anything. The heading is used when there is one; this covers
 * the fallback, which is what a script with no headings always hit.
 */
describe('§115 — the ending location never reports a raw token index', () => {
  const sentences = [
    { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, normalizedText: 'Hello there.' },
    { id: 's-2', blockId: 'b-1', startTokenIndex: 4, endTokenIndex: 9, normalizedText: 'Second one.' },
  ];

  function pushSnapshot(confirmedToken: number): void {
    alignmentFeed.push?.({
      sessionGeneration: 7,
      seq: 1,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken,
      observedToken: confirmedToken + 1,
      rateTokensPerSecond: 2.5,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 900,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 200,
      observedAtom: confirmedToken + 1,
      confirmedAtom: confirmedToken,
    });
  }

  it('locates the ending by sentence when the script has no headings', () => {
    start({ sentences });
    startPrompting();
    pushSnapshot(5);
    const summary = stopSession();

    expect(summary.endingLocation).not.toMatch(/token/i);
    expect(summary.endingLocation).toBe('Sentence 2 of 2');
  });

  it('still says Beginning before anything has been followed', () => {
    start({ sentences });
    startPrompting();
    const summary = stopSession();
    expect(summary.endingLocation).toBe('Beginning');
  });

  it('says Beginning when the take never reached the first sentence', () => {
    /*
     * The `reached === 0` branch, which needs a SNAPSHOT to get to — the test
     * above returns at `!snapshot` and never exercises it. Degraded input (a
     * first sentence that does not start at token 0) is what reaches this, and
     * flooring it to "Sentence 1 of 2" would name a sentence never begun.
     */
    start({ sentences: [{ ...sentences[0]!, startTokenIndex: 40, endTokenIndex: 48 }] });
    startPrompting();
    pushSnapshot(3);
    expect(stopSession().endingLocation).toBe('Beginning');
  });

  it('says the location is unavailable rather than inventing one', () => {
    // Degraded input: a snapshot arrived but there is no sentence metadata to
    // locate it against. "Beginning" would be a claim; this is not.
    start({ sentences: [] });
    startPrompting();
    pushSnapshot(5);
    expect(stopSession().endingLocation).toBe('Location unavailable');
  });
});

/**
 * §115 — an instruction the operator can actually carry out.
 *
 * The busy-device fallback notice says "pick another input in the take
 * controls". Two things had to be true for that to mean anything, and neither
 * was: the notice had to outlive the four-second `info` default (it is an
 * instruction, and the take runs for minutes), and the picker it names had to
 * render — which it did not, because the picker was gated on `inputDeviceLost`
 * and a fallback loses nothing.
 */
describe('§115 — the fallback-input notice is followable', () => {
  function fellBackToDefault(): void {
    const deps = pipeline.captured.deps as unknown as {
      onInputFellBackToDefault?: () => void;
    };
    deps.onInputFellBackToDefault?.();
  }

  it('offers the picker without claiming the microphone failed', () => {
    start();
    startPrompting();
    fellBackToDefault();

    const s = get(session);
    // The flag the picker reads...
    expect(s.usingFallbackInput).toBe(true);
    // ...and NOT the one that means "this is broken". Nothing failed: audio is
    // being captured, just not from the chosen device.
    expect(s.inputDeviceLost).toBe(false);
    expect(s.micState).toBe('live');
  });

  it('does not expire while the take is still running', () => {
    start();
    startPrompting();
    fellBackToDefault();
    expect(get(toasts)).toHaveLength(1);

    // Well past the 4000 ms `info` default that used to retire it.
    vi.advanceTimersByTime(30_000);
    expect(get(toasts)).toHaveLength(1);
  });

  it('reports the condition once rather than stacking', () => {
    start();
    startPrompting();
    fellBackToDefault();
    fellBackToDefault();
    expect(get(toasts)).toHaveLength(1);
  });

  it('is retired with the take', () => {
    start();
    startPrompting();
    fellBackToDefault();
    stopSession();
    expect(get(toasts)).toHaveLength(0);
  });

  it('ignores a fallback reported by a superseded pipeline', () => {
    start();
    startPrompting();
    const deps = pipeline.captured.deps as unknown as {
      onInputFellBackToDefault?: () => void;
    };
    stopSession();
    clearSession();

    // The old take's pipeline, reporting late. Nothing it says belongs to what
    // is on screen now.
    deps.onInputFellBackToDefault?.();
    expect(get(toasts)).toHaveLength(0);
    expect(get(session).usingFallbackInput).toBe(false);
  });

  /**
   * A resolved switch is not necessarily the device that was asked for.
   *
   * The pipeline falls back to the system default when the REPLACEMENT is also
   * busy, and reports that by callback rather than by rejecting. Treating it as
   * success took the picker away and announced that following had resumed, for
   * a device the operator had chosen and silently not been given.
   */
  it('does not claim success when the replacement input also fell back', async () => {
    start();
    startPrompting();

    const deps = pipeline.captured.deps as unknown as {
      onInputFellBackToDefault?: () => void;
    };
    const { switchMicrophone } = await import('../../../src/control/stores/session');

    // The fake pipeline's `switchMicrophone` falls back while switching.
    const live = pipeline.captured.instance as unknown as {
      switchMicrophone: (deviceId: string) => Promise<void>;
    };
    live.switchMicrophone = async () => {
      deps.onInputFellBackToDefault?.();
    };

    const ok = await switchMicrophone('device-b', 'Interface B');
    expect(ok).toBe(false);
    // Still offering the remedy, still saying why, still capturing.
    expect(get(session).usingFallbackInput).toBe(true);
    expect(get(session).micState).toBe('live');
    expect(get(toasts)).toHaveLength(1);
  });
});

/**
 * #275 — a paused take still goes where the presenter sends it.
 *
 * Space, a hard pause and switching following off all stop the driver
 * prompting, and the driver used to drop every snapshot while it was not —
 * including the `manualAnchor` Rust publishes in answer to a move. The engine
 * moved; `$session.snapshot` did not, so the embedded stage (fed from it) never
 * moved, and the take ended where following had been paused: "expected 3 to be
 * 47". Pausing must still stop the VOICE, and that half is pinned here too.
 */
describe('#275 — manual moves while the take is paused or not following', () => {
  const SOURCE =
    '# Opening\n\nFirst sentence of the opening. Second sentence of the opening.\n\n' +
    '## Middle\n\nThird sentence in the middle. Fourth sentence in the middle.\n\n' +
    '## Close\n\nFifth sentence near the close. Sixth and final sentence of the close.\n';

  let seq = 0;

  function manualAnchorAt(token: number): Record<string, unknown> {
    seq += 1;
    return {
      sessionGeneration: 7,
      seq,
      // What `Engine::set_manual_position` reports: following, at the place it
      // was given — which is exactly why it must not be taken for the voice.
      state: 'following',
      decision: 'manualAnchor',
      confirmedToken: token,
      observedToken: token,
      rateTokensPerSecond: 2,
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
      displayLimitToken: token,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 200,
      observedAtom: token,
      confirmedAtom: token,
    };
  }

  function voiceAt(token: number): Record<string, unknown> {
    return { ...manualAnchorAt(token), decision: 'localConfirmed' };
  }

  /** Answer every move the way Rust does: publish where it was put. */
  function answerMovesLikeRust(): void {
    setInvokeForTesting(async (command, args) => {
      invoked.push({ command, args });
      if (command === 'set_alignment_position') {
        alignmentFeed.push?.(manualAnchorAt(args?.token as number));
      }
      return undefined as never;
    });
  }

  function startScript() {
    const compiled = compile(SOURCE, { scriptId: 'script-1' });
    start({ compiled, sentences: compiled.sentences as never });
    return compiled;
  }

  const positionMoves = () =>
    invoked.filter((c) => c.command === 'set_alignment_position').map((c) => c.args?.token);

  beforeEach(() => {
    seq = 0;
    answerMovesLikeRust();
  });

  it.each([
    ['paused with Space', () => pauseListening()],
    ['hard-paused', () => hardPause()],
    ['following off', () => toggleVoiceFollow()],
  ])('ends a take %s where the presenter moved it, not where it paused', async (_label, pause) => {
    const compiled = startScript();
    await vi.advanceTimersByTimeAsync(0);
    // Following got as far as the second sentence before the pause.
    const second = compiled.sentences[1]!.startTokenIndex;
    alignmentFeed.push?.(voiceAt(second));
    expect(get(session).snapshot?.confirmedToken).toBe(second);

    pause();
    const last = compiled.sentences.at(-1)!.startTokenIndex;
    goToToken(last);
    await vi.advanceTimersByTimeAsync(0);

    expect(get(session).snapshot?.confirmedToken).toBe(last);
    const summary = stopSession();
    expect(summary.endTokenIndex).toBe(last);
    const [, recorded] = records.endSessionRecord.mock.calls.at(-1) as unknown as [
      string,
      { endTokenIndex?: number },
    ];
    expect(recorded.endTokenIndex).toBe(last);
  });

  it('ends where the presenter last put it, not the furthest place it went', async () => {
    const compiled = startScript();
    await vi.advanceTimersByTimeAsync(0);
    pauseListening();

    goToToken(compiled.sentences.at(-1)!.startTokenIndex);
    await vi.advanceTimersByTimeAsync(0);
    const back = compiled.sentences[2]!.startTokenIndex;
    goToToken(back);
    await vi.advanceTimersByTimeAsync(0);

    expect(stopSession().endTokenIndex).toBe(back);
  });

  it('steps one sentence further on every press while paused', async () => {
    const compiled = startScript();
    await vi.advanceTimersByTimeAsync(0);
    pauseListening();

    for (let press = 0; press < 3; press += 1) {
      moveSentences(1);
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(positionMoves()).toEqual(
      compiled.sentences.slice(1, 4).map((s) => s.startTokenIndex),
    );
    expect(get(session).snapshot?.confirmedToken).toBe(compiled.sentences[3]!.startTokenIndex);
  });

  it('keeps the voice out while paused, before and after a manual move', async () => {
    const compiled = startScript();
    await vi.advanceTimersByTimeAsync(0);
    toggleVoiceFollow();

    alignmentFeed.push?.(voiceAt(compiled.sentences[4]!.startTokenIndex));
    expect(get(session).snapshot).toBeNull();

    const target = compiled.sentences[2]!.startTokenIndex;
    goToToken(target);
    await vi.advanceTimersByTimeAsync(0);
    alignmentFeed.push?.(voiceAt(compiled.sentences[4]!.startTokenIndex));

    expect(get(session).snapshot?.confirmedToken).toBe(target);
    expect(stopSession().endTokenIndex).toBe(target);
  });

  it('does not book a paused presenter stepping by hand as time spent following', async () => {
    startScript();
    await vi.advanceTimersByTimeAsync(0);
    pauseListening();

    // A step a second for four seconds: every gap is under the credit cap, and
    // every answer says `following`.
    for (let press = 0; press < 4; press += 1) {
      moveSentences(1);
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Back on for a second, so there is following time to be a share OF — the
    // paused stretch is not in it any more (#287), and without this the share
    // would be null whatever the steps had been credited.
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(1000);

    expect(stopSession().followingShare).toBe(0);
  });
});

/**
 * #277 — the transport and the voice never carry the take together.
 *
 * Auto-scroll replaces following, it does not run beside it: two things moving
 * one document with different ideas of where the presenter is. Every road that
 * could switch the voice back on under a running roll — the dock, the
 * take-controls drawer, Space, a hold recovering — is enumerated here, and each
 * is checked where it matters: whether a voice snapshot still reaches the take.
 */
describe('#277 — auto-scroll and voice following never both carry the take', () => {
  const SOURCE =
    '# Opening\n\nFirst sentence of the opening. Second sentence of the opening.\n\n' +
    '## Close\n\nThird sentence near the close. Fourth and final sentence.\n';

  let seq = 0;

  function voiceAt(token: number): Record<string, unknown> {
    seq += 1;
    return {
      sessionGeneration: 7,
      seq,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: token,
      observedToken: token,
      rateTokensPerSecond: 2,
      evidenceAudioMs: 1000 * seq,
      atAudioMs: 1000 * seq,
      maxPredictionMs: 900,
      pauseOnsetMs: 1800,
      leadFloorMs: 550,
      maxLeadTokens: 2.5,
      leadMarginTokens: 1.2,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
      displayLimitToken: token,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 200,
      observedAtom: token,
      confirmedAtom: token,
    };
  }

  async function startScript(mode: 'voice' | 'manual' = 'voice') {
    const compiled = compile(SOURCE, { scriptId: 'script-1' });
    start({ compiled, sentences: compiled.sentences as never, mode });
    await vi.advanceTimersByTimeAsync(0);
    return compiled;
  }

  /**
   * Whether a voice snapshot pushed now reaches the take.
   *
   * Throws rather than answering false without a feed: a "kept out" that only
   * meant "never sent" would pass every test below for the wrong reason.
   */
  function voiceReaches(token: number): boolean {
    if (!alignmentFeed.push) throw new Error('the take never subscribed to the alignment feed');
    alignmentFeed.push(voiceAt(token));
    return get(session).snapshot?.confirmedToken === token;
  }

  /** One of the stubbed pipeline's callbacks, as the take handed it over. */
  function pipelineCallback<T>(name: string): T {
    const callback = pipeline.captured.deps?.[name];
    if (!callback) throw new Error('the voice pipeline was never constructed');
    return callback as unknown as T;
  }

  /** What `onFollowingHold` is told when the transcript goes untrustworthy and back. */
  function hold(held: boolean): void {
    pipelineCallback<(held: boolean, reason: string | null) => void>('onFollowingHold')(
      held,
      held ? 'reconnecting' : null,
    );
  }

  const lastToast = () => get(toasts).at(-1)?.message;

  beforeEach(() => {
    seq = 0;
  });

  it('stops the roll when following is switched back on at the dock', async () => {
    const compiled = await startScript();
    toggleAutoScroll();
    expect(get(autoScrollLive).running).toBe(true);
    expect(get(session).voiceFollow).toBe(false);

    toggleVoiceFollow();
    const s = get(session);
    expect(s.autoScroll.running, 'the voice took the document back').toBe(false);
    expect(get(autoScrollLive).running).toBe(false);
    expect(s.voiceFollow).toBe(true);
    expect(s.followPausedByUser).toBe(false);
    expect(lastToast()).toBe('Auto-scroll off — following your voice again');
    expect(voiceReaches(compiled.sentences[2]!.startTokenIndex)).toBe(true);
  });

  it('stops the roll when following is switched back on in the take-controls drawer', async () => {
    // The drawer reaches the follow store directly, never `toggleVoiceFollow`.
    const compiled = await startScript();
    toggleAutoScroll();
    expect(get(smoothFollow).followingPaused).toBe(true);

    smoothFollow.toggleFollowingPaused();
    const s = get(session);
    expect(s.autoScroll.running).toBe(false);
    expect(s.voiceFollow).toBe(true);
    expect(s.followPausedByUser).toBe(false);
    expect(get(smoothFollow).followingPaused).toBe(false);
    expect(lastToast()).toBe('Auto-scroll off — following your voice again');
    expect(get(toasts).filter((t) => t.message.startsWith('Auto-scroll off'))).toHaveLength(1);
    expect(voiceReaches(compiled.sentences[2]!.startTokenIndex)).toBe(true);
  });

  it('hands over a roll Space has paused, and Space does not start it again', async () => {
    const compiled = await startScript();
    toggleAutoScroll();
    togglePlayPause();
    expect(get(session).paused).toBe('listening');

    toggleVoiceFollow();
    expect(get(session).autoScroll.running, 'the armed roll is disarmed too').toBe(false);

    togglePlayPause();
    await vi.advanceTimersByTimeAsync(0);
    expect(get(session).paused).toBe('none');
    expect(get(autoScrollLive).running).toBe(false);
    expect(get(session).voiceFollow).toBe(true);
    expect(voiceReaches(compiled.sentences[2]!.startTokenIndex)).toBe(true);
  });

  it('keeps the voice out of a roll through a Space pause and resume', async () => {
    const compiled = await startScript();
    toggleAutoScroll();
    togglePlayPause();
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(0);
    expect(get(session).paused).toBe('none');
    expect(get(autoScrollLive).running, 'the roll picks up where it stopped').toBe(true);

    expect(voiceReaches(compiled.sentences[2]!.startTokenIndex)).toBe(false);
    expect(get(session).voiceFollow).toBe(false);
  });

  it('keeps the voice out through Space while following is switched off', async () => {
    // The same rule without the transport: Space is not the follow switch.
    const compiled = await startScript();
    toggleVoiceFollow();
    togglePlayPause();
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(0);

    expect(voiceReaches(compiled.sentences[2]!.startTokenIndex)).toBe(false);
    toggleVoiceFollow();
    expect(voiceReaches(compiled.sentences[3]!.startTokenIndex)).toBe(true);
  });

  it('does not let a hold that began before the roll release into it', async () => {
    const compiled = await startScript();
    hold(true);
    expect(get(session).voiceFollow).toBe(false);
    expect(get(session).followPausedByUser).toBe(false);

    toggleAutoScroll();
    // The stage holds the voice off the glass on this flag, not on `voiceFollow`.
    expect(get(session).followPausedByUser).toBe(true);
    hold(false);
    let s = get(session);
    expect(s.voiceFollow, 'a recovering transcript is not a request for the voice').toBe(false);
    expect(get(autoScrollLive).running).toBe(true);
    expect(voiceReaches(compiled.sentences[2]!.startTokenIndex)).toBe(false);

    // The pause the roll took over is still the roll's to give back.
    toggleAutoScroll();
    s = get(session);
    expect(s.voiceFollow).toBe(true);
    expect(s.followPausedByUser).toBe(false);
    expect(voiceReaches(compiled.sentences[3]!.startTokenIndex)).toBe(true);
  });

  it('gives back a roll stopped under a hold without claiming the voice is back', async () => {
    const compiled = await startScript();
    toggleAutoScroll();
    pipelineCallback<(connection: string) => void>('onConnectionState')('reconnecting');
    hold(true);

    toggleAutoScroll();
    expect(get(session).micState, 'the microphone itself is fine').toBe('live');
    expect(lastToast()).toBe('Auto-scroll off');

    hold(false);
    expect(get(session).voiceFollow).toBe(true);
    expect(get(session).autoScroll.running, 'the recovery does not restart the roll').toBe(false);
    expect(voiceReaches(compiled.sentences[2]!.startTokenIndex)).toBe(true);
  });

  it('keeps the voice out of a roll through a hard pause and resume', async () => {
    const compiled = await startScript();
    toggleAutoScroll();
    hardPause();
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(0);
    expect(get(session).paused).toBe('none');
    expect(get(autoScrollLive).running).toBe(true);
    expect(voiceReaches(compiled.sentences[2]!.startTokenIndex)).toBe(false);

    toggleAutoScroll();
    expect(voiceReaches(compiled.sentences[3]!.startTokenIndex)).toBe(true);
  });

  it('does not say the voice is back while Space still holds the take', async () => {
    await startScript();
    toggleAutoScroll();
    togglePlayPause();
    toggleAutoScroll();
    expect(get(session).voiceFollow).toBe(true);
    expect(lastToast()).toBe('Auto-scroll off');
  });

  it('says following is back when stopping the roll gave it back', async () => {
    await startScript();
    toggleAutoScroll();
    toggleAutoScroll();
    expect(get(session).voiceFollow).toBe(true);
    expect(lastToast()).toBe('Auto-scroll off — following your voice again');
  });

  it('leaves following off, and says so, when the presenter had switched it off first', async () => {
    await startScript();
    toggleVoiceFollow();
    toggleAutoScroll();
    toggleAutoScroll();

    const s = get(session);
    expect(s.voiceFollow).toBe(false);
    expect(s.followPausedByUser).toBe(true);
    expect(lastToast()).toBe('Auto-scroll off — voice following is still off');
  });

  it('claims nothing about a voice a manual take never had', async () => {
    await startScript('manual');
    expect(get(session).voiceFollow).toBe(false);
    toggleAutoScroll();
    toggleAutoScroll();

    const s = get(session);
    expect(s.voiceFollow, 'the roll gave back nothing it did not take').toBe(false);
    expect(s.followPausedByUser).toBe(false);
    expect(lastToast()).toBe('Auto-scroll off');
  });

  it('ignores an end report from a roll the voice has already taken over', async () => {
    await startScript();
    toggleAutoScroll();
    toggleVoiceFollow();
    const before = get(toasts).length;

    autoScrollReachedEnd('document_end');
    expect(get(toasts)).toHaveLength(before);
    expect(get(session).voiceFollow).toBe(true);
    expect(stopSession().endTokenIndex, 'no ending was recorded for the roll').toBe(0);
  });

  it('starts the next take following after one that ended mid-roll', async () => {
    await startScript();
    toggleAutoScroll();
    stopSession();
    clearSession();

    const compiled = await startScript();
    hold(true);
    hold(false);
    expect(get(session).voiceFollow, 'the last take’s pause is not this one’s').toBe(true);
    expect(voiceReaches(compiled.sentences[1]!.startTokenIndex)).toBe(true);
  });
});

/**
 * #287 — following is judged on the time it was asked to run.
 *
 * The share divided by the whole pass, so a minute of Space was a minute of
 * following failing and a take auto-scroll rolled from the first line had
 * "did not track". These drive the real store and the real driver, because
 * the bug lived in how the two account for time between them.
 */
describe('#287 — time the presenter set following aside is not charged to following', () => {
  const SOURCE =
    '# Opening\n\nFirst sentence of the opening. Second sentence of the opening.\n\n' +
    '## Close\n\nThird sentence near the close. Fourth and final sentence.\n';

  let seq = 0;

  function voiceAt(token: number): Record<string, unknown> {
    seq += 1;
    return {
      sessionGeneration: 7,
      seq,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: token,
      observedToken: token,
      rateTokensPerSecond: 2,
      evidenceAudioMs: 1000 * seq,
      atAudioMs: 1000 * seq,
      maxPredictionMs: 900,
      pauseOnsetMs: 1800,
      leadFloorMs: 550,
      maxLeadTokens: 2.5,
      leadMarginTokens: 1.2,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
      displayLimitToken: token,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 200,
      observedAtom: token,
      confirmedAtom: token,
    };
  }

  function feed(snapshot: Record<string, unknown>): void {
    if (!alignmentFeed.push) throw new Error('the take never subscribed to the alignment feed');
    alignmentFeed.push(snapshot);
  }

  function pipelineCallback<T>(name: string): T {
    const callback = pipeline.captured.deps?.[name];
    if (!callback) throw new Error('the voice pipeline was never constructed');
    return callback as unknown as T;
  }

  /** Words the recogniser finalised — without them every take is "nothing was transcribed". */
  function heard(text: string): void {
    pipelineCallback<(text: string, final: boolean) => void>('onTranscriptText')(text, true);
  }

  function hold(held: boolean): void {
    pipelineCallback<(held: boolean, reason: string | null) => void>('onFollowingHold')(
      held,
      held ? 'reconnecting' : null,
    );
  }

  /**
   * A steady read: a snapshot a second for `seconds` seconds, every gap well
   * under the credit cap, ending on a snapshot so the last second is booked.
   */
  async function follow(seconds: number): Promise<void> {
    for (let second = 0; second < seconds; second += 1) {
      feed(voiceAt(1));
      await vi.advanceTimersByTimeAsync(1000);
    }
    feed(voiceAt(1));
  }

  async function startScript({ speak = true } = {}) {
    const compiled = compile(SOURCE, { scriptId: 'script-1' });
    start({ compiled, sentences: compiled.sentences as never });
    await vi.advanceTimersByTimeAsync(0);
    if (speak) heard('first sentence of the opening second sentence of the opening');
    return compiled;
  }

  beforeEach(() => {
    seq = 0;
  });

  it.each([
    ['a Space pause', () => togglePlayPause(), () => togglePlayPause(), 'pausedSeconds'],
    ['a hard pause', () => hardPause(), () => togglePlayPause(), 'pausedSeconds'],
    ['following switched off', () => toggleVoiceFollow(), () => toggleVoiceFollow(), 'offSeconds'],
  ] as const)(
    'scores 20 s followed, a minute of %s and 10 s more as following throughout',
    async (_label, standDown, resume, bucket) => {
      await startScript();
      await follow(20);
      standDown();
      await vi.advanceTimersByTimeAsync(60_000);
      resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(get(session).paused).toBe('none');
      expect(get(session).followPausedByUser).toBe(false);
      await follow(10);

      const summary = stopSession();
      expect(summary.followingTime[bucket]).toBeCloseTo(60, 1);
      expect(summary.followingTime.onSeconds).toBeCloseTo(30, 1);
      // The issue measured 0.31 here, and "Following needed help".
      expect(summary.followingShare).toBeCloseTo(1, 2);
      const outcome = resolveTakeOutcome(summary);
      expect(outcome.headline).toBe('CandidCue stayed with you');
      expect(outcome.health).toBe('steady');
    },
  );

  it('reports a take auto-scroll rolled from the first line as auto-scroll', async () => {
    await startScript();
    toggleAutoScroll();
    // The recogniser keeps listening under a roll; the driver keeps the voice
    // off the take.
    for (let second = 0; second < 60; second += 1) {
      feed(voiceAt(1));
      await vi.advanceTimersByTimeAsync(1000);
    }

    const summary = stopSession();
    expect(summary.followingShare).toBeNull();
    expect(summary.followingTime.autoScrollSeconds).toBeCloseTo(60, 1);
    expect(summary.followingTime.onSeconds).toBeCloseTo(0, 1);
    const outcome = resolveTakeOutcome(summary);
    // It was "CandidCue heard you, but did not track", with a support bundle.
    expect(outcome.headline).toBe('This take used auto-scroll');
    expect(outcome.suggestion).toBeNull();
  });

  it('gives the same answer when a snapshot landed before the roll began', async () => {
    // A take started part way gets a snapshot before the roll can begin — the
    // answer to its opening anchor — so the share is not null, and the take is
    // still one auto-scroll carried.
    await startScript();
    feed(voiceAt(1));
    await vi.advanceTimersByTimeAsync(500);
    toggleAutoScroll();
    await vi.advanceTimersByTimeAsync(60_000);

    const summary = stopSession();
    expect(summary.followingShare).not.toBeNull();
    expect(summary.followingTime.onSeconds).toBeCloseTo(0.5, 2);
    expect(summary.followingTime.autoScrollSeconds).toBeCloseTo(60, 1);
    expect(resolveTakeOutcome(summary).headline).toBe('This take used auto-scroll');
  });

  it('does not book the gap a pause interrupted as following straight through it', async () => {
    /*
     * Intervals are credited when the NEXT snapshot arrives. Following until
     * 10 s, Space at 11 s, back at 13 s, a snapshot at 14 s: that snapshot
     * would credit all four seconds since the last one, two of them paused.
     */
    await startScript();
    await follow(10);
    await vi.advanceTimersByTimeAsync(1000);
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(2000);
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(1000);
    feed(voiceAt(1));

    const summary = stopSession();
    expect(summary.followingTime.pausedSeconds).toBeCloseTo(2, 1);
    expect(summary.followingTime.onSeconds).toBeCloseTo(12, 1);
    // Ten seconds followed plus the one up to the pause, out of twelve on.
    expect(summary.followingShare).toBeCloseTo(11 / 12, 3);
  });

  it('counts a pause still in force when the take is stopped', async () => {
    await startScript();
    await follow(10);
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(30_000);

    const summary = stopSession();
    expect(summary.followingTime.pausedSeconds).toBeCloseTo(30, 1);
    expect(summary.followingTime.onSeconds).toBeCloseTo(10, 1);
    expect(summary.followingShare).toBeCloseTo(1, 2);
  });

  it('opens a retake made while paused as paused', async () => {
    // Nothing promises a store write after the retake to announce the pause,
    // so the new pass reads the pause it starts under.
    await startScript();
    await follow(5);
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(10_000);
    restartParagraph();
    await vi.advanceTimersByTimeAsync(20_000);

    const summary = stopSession();
    expect(summary.followingTime.pausedSeconds).toBeCloseTo(20, 1);
    expect(summary.followingTime.onSeconds).toBeCloseTo(0, 1);
    expect(resolveTakeOutcome(summary).headline).toBe('This take was paused');
  });

  it('starts the next take with nothing set aside after one stopped paused', async () => {
    // Straight from the stop to the next take, as "Present again" does: the
    // store still says paused when the next one begins.
    await startScript();
    togglePlayPause();
    await vi.advanceTimersByTimeAsync(10_000);
    stopSession();
    expect(get(session).paused).toBe('listening');

    await startScript();
    await follow(10);
    const summary = stopSession();
    expect(summary.followingTime.pausedSeconds).toBe(0);
    expect(summary.followingTime.onSeconds).toBeCloseTo(10, 1);
    expect(summary.listenedSeconds, 'the last session’s listening is not this one’s').toBeCloseTo(10, 1);
  });

  it('keeps a resume that is still reopening the recogniser out of following', async () => {
    /*
     * After a hard pause the driver is let go before the recogniser answers,
     * and the take stays paused until it does. Snapshots in that window must
     * not open following intervals: credited, they would add two seconds the
     * denominator does not have.
     */
    await startScript();
    await follow(5);
    hardPause();
    await vi.advanceTimersByTimeAsync(10_000);
    let reopened!: () => void;
    (pipeline.captured.instance as { resume: () => Promise<void> }).resume = () =>
      new Promise<void>((resolve) => {
        reopened = resolve;
      });
    togglePlayPause();
    for (let second = 0; second < 3; second += 1) {
      feed(voiceAt(1));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(get(session).paused).toBe('hard');
    reopened();
    await vi.advanceTimersByTimeAsync(0);
    expect(get(session).paused).toBe('none');
    // Ten quiet seconds — past the credit cap — then five more followed.
    await vi.advanceTimersByTimeAsync(10_000);
    await follow(5);

    const summary = stopSession();
    expect(summary.followingTime.pausedSeconds).toBeCloseTo(13, 1);
    expect(summary.followingTime.onSeconds).toBeCloseTo(20, 1);
    expect(summary.followingShare).toBeCloseTo(10 / 20, 2);
  });

  it('does not send a presenter who hard-paused straight away to test the microphone', async () => {
    await startScript({ speak: false });
    hardPause();
    await vi.advanceTimersByTimeAsync(90_000);

    const summary = stopSession();
    expect(summary.wordsHeard).toBe(0);
    expect(summary.listenedSeconds).toBeCloseTo(0, 1);
    const outcome = resolveTakeOutcome(summary);
    expect(outcome.headline).toBe('This take was paused');
    expect(outcome.suggestion).toBeNull();
  });

  it('still reports a silent minute that a paused retake came after', async () => {
    // Words are counted across the session, so the listening is too: the
    // retake's pause does not excuse the minute of silence before it.
    await startScript({ speak: false });
    await vi.advanceTimersByTimeAsync(60_000);
    togglePlayPause();
    restartParagraph();
    await vi.advanceTimersByTimeAsync(20_000);

    const summary = stopSession();
    expect(summary.listenedSeconds).toBeCloseTo(60, 1);
    expect(summary.followingTime.pausedSeconds).toBeCloseTo(20, 1);
    expect(resolveTakeOutcome(summary).headline).toBe('Nothing was transcribed');
  });

  it('still charges an automatic hold to following', async () => {
    /*
     * The verdict the issue keeps. A hold stops following too, but nobody
     * chose it — the transcript stopped being trustworthy — and it is exactly
     * what "Following needed help" exists to report.
     */
    await startScript();
    await follow(5);
    hold(true);
    for (let second = 0; second < 40; second += 1) {
      feed(voiceAt(1));
      await vi.advanceTimersByTimeAsync(1000);
    }
    hold(false);
    await follow(5);

    const summary = stopSession();
    const { pausedSeconds, offSeconds, autoScrollSeconds, onSeconds } = summary.followingTime;
    expect(pausedSeconds + offSeconds + autoScrollSeconds).toBe(0);
    expect(onSeconds).toBeCloseTo(50, 1);
    expect(summary.followingShare).toBeCloseTo(10 / 50, 2);
    expect(resolveTakeOutcome(summary).headline).toBe('Following needed help');
  });
});
