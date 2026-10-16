/**
 * The alignment driver — control's seam onto the Rust engine.
 *
 * What is worth asserting here is small, because the driver is small: the
 * engine lives in Rust and control neither aligns nor tokenizes. What control
 * still owns is the LIFECYCLE — which script is handed over, when snapshots are
 * allowed to move the UI, and which token an explicit navigation lands on — and
 * every one of those has been a source of a silent, take-losing bug.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import { createTrackingDriver } from '../../../src/control/services/session';
import { alignTokensFor } from '../../../src/control/services/alignment';
import type { AlignmentSnapshot } from '../../../src/shared/contracts';

/*
 * The snapshot feed is a Tauri event channel, which node does not have — the
 * real subscription returns a no-op outside the runtime. Capturing the handler
 * lets a test play Rust's part: publish what the engine would publish, and see
 * what the driver lets through. Everything else in the module stays real.
 */
const feed = vi.hoisted(() => ({ push: null as ((snapshot: unknown) => void) | null }));
vi.mock('../../../src/control/services/alignment', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/alignment')>();
  return {
    ...actual,
    subscribeAlignmentSnapshots: (handler: (snapshot: never) => void) => {
      feed.push = handler as (snapshot: unknown) => void;
      return () => {
        feed.push = null;
      };
    },
  };
});

const SOURCE = `# One

First paragraph sentence here. Another sentence in the same block.

Second paragraph sentence follows afterwards.
`;

interface Call {
  command: string;
  args: Record<string, unknown> | undefined;
}

function makeDriver() {
  const compiled = compile(SOURCE, { scriptId: 'script-1' });
  const calls: Call[] = [];
  setInvokeForTesting(async (command, args) => {
    calls.push({ command, args });
    return undefined as never;
  });
  const snapshots: AlignmentSnapshot[] = [];
  const driver = createTrackingDriver({
    sessionId: 'session-1',
    scriptId: 'script-1',
    sentences: compiled.sentences,
    totalTokens: compiled.spokenTokens.length,
    compiled,
    sessionGeneration: 7,
    onSnapshot: (s) => snapshots.push(s),
    onTranscript: () => {},
  });
  return { compiled, calls, driver, snapshots };
}

afterEach(() => {
  setInvokeForTesting(null);
  vi.restoreAllMocks();
});

describe('alignment driver', () => {
  it('hands Rust the compiled script under the transcription generation', async () => {
    const { compiled, calls, driver } = makeDriver();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const start = calls.find((c) => c.command === 'start_alignment');
    expect(start, 'the driver never started an alignment session').toBeDefined();
    // The generation pairs alignment with the socket that feeds it; Rust drops
    // any transcript frame stamped with a different one.
    expect(start?.args?.generation).toBe(7);
    const tokens = start?.args?.tokens as Array<{ surface: string }>;
    expect(tokens).toHaveLength(compiled.spokenTokens.length);
    driver.dispose();
  });

  /*
   * The ORDER and COUNT of the token list is the whole contract: every snapshot
   * position is a fractional index into it, and the stage resolves those
   * indexes through geometry it measured for `spokenTokens`. A token filtered
   * out here shifts every position after it, silently.
   */
  it('sends the spoken tokens verbatim, in order, unsplit', () => {
    const compiled = compile('We raised $12 million in a well-known round.', {
      scriptId: 'script-1',
    });
    const tokens = alignTokensFor(compiled);
    expect(tokens.map((t) => t.surface)).toEqual(
      compiled.spokenTokens.map((t) => t.surface),
    );
    // `$12` and `well-known` cross as authored. The engine decides they are two
    // spoken words each; splitting here would make this a second tokenizer.
    expect(tokens.map((t) => t.surface)).toContain('$12');
    expect(tokens.map((t) => t.surface)).toContain('well-known');
  });

  /*
   * §9.1: hold position until the user explicitly starts prompting. The engine
   * has no pause — it is a pure function of the frames it is given — so the
   * gate is here, and a snapshot arriving before `start()` must not move
   * anything.
   */
  it('ignores snapshots until prompting starts', () => {
    const { driver, snapshots } = makeDriver();
    expect(snapshots).toHaveLength(0);
    driver.start();
    expect(snapshots).toHaveLength(0);
    driver.dispose();
  });

  it('moves by sentence and paragraph onto a real token index', async () => {
    const { compiled, calls, driver } = makeDriver();
    driver.start();

    driver.moveSentences(1);
    await vi.waitFor(() =>
      expect(calls.some((c) => c.command === 'set_alignment_position')).toBe(true),
    );
    const move = calls.filter((c) => c.command === 'set_alignment_position').at(-1);
    const target = move?.args?.token as number;
    expect(Number.isFinite(target)).toBe(true);
    expect(
      compiled.sentences.some((s) => s.startTokenIndex === target),
      'a sentence move must land on a sentence boundary',
    ).toBe(true);
    driver.dispose();
  });

  it('stops the alignment session on dispose', async () => {
    const { calls, driver } = makeDriver();
    driver.dispose();
    await vi.waitFor(() => expect(calls.some((c) => c.command === 'stop_alignment')).toBe(true));
  });

  it('falls back to the mock driver when there is no compiled script', () => {
    const snapshots: AlignmentSnapshot[] = [];
    const driver = createTrackingDriver({
      sessionId: 'session-1',
      scriptId: 'script-1',
      sentences: [],
      totalTokens: 40,
      compiled: null,
      onSnapshot: (s) => snapshots.push(s),
      onTranscript: () => {},
    });
    driver.start();
    // The mock emits a contract-correct snapshot immediately, so the Live
    // screen stays exercisable with no Rust and no microphone.
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]?.state).toBe('following');
    driver.dispose();
  });
});

/*
 * #275 — a pause holds the VOICE, not the operator.
 *
 * Pausing (Space) and switching following off both stop the driver prompting,
 * and the gate used to drop every snapshot while it was not — including the
 * `manualAnchor` Rust publishes in answer to `set_alignment_position`. So a
 * sentence step while paused moved the engine and nothing else: the glass and
 * the take's ending stayed put, and the next step was computed from the same
 * stale snapshot, so three presses aimed at the same sentence three times.
 */
describe('manual moves while not prompting (#275)', () => {
  const LONG = `# One

First sentence here. Second sentence here. Third sentence here. Fourth sentence here.

Fifth sentence in another paragraph.
`;

  function snapshotAt(
    token: number,
    seq: number,
    overrides: Partial<AlignmentSnapshot> = {},
  ): AlignmentSnapshot {
    return {
      sessionGeneration: 7,
      seq,
      state: 'following',
      decision: 'manualAnchor',
      confirmedToken: token,
      observedToken: token,
      rateTokensPerSecond: 0,
      evidenceAudioMs: 0,
      atAudioMs: 0,
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
      observedAtom: token,
      confirmedAtom: token,
      ...overrides,
    };
  }

  /**
   * A driver whose IPC answers a move the way Rust does: by publishing a
   * `manualAnchor` at the token it was given, whether or not anybody is
   * following.
   */
  function makeAnsweringDriver(source = LONG) {
    const compiled = compile(source, { scriptId: 'script-1' });
    const moves: number[] = [];
    let seq = 0;
    setInvokeForTesting(async (command, args) => {
      if (command === 'set_alignment_position') {
        const token = args?.token as number;
        moves.push(token);
        seq += 1;
        feed.push?.(snapshotAt(token, seq));
      }
      return undefined as never;
    });
    const snapshots: AlignmentSnapshot[] = [];
    const driver = createTrackingDriver({
      sessionId: 'session-1',
      scriptId: 'script-1',
      sentences: compiled.sentences,
      totalTokens: compiled.spokenTokens.length,
      compiled,
      sessionGeneration: 7,
      onSnapshot: (s) => snapshots.push(s),
      onTranscript: () => {},
    });
    return { compiled, driver, moves, snapshots };
  }

  type Driver = ReturnType<typeof makeAnsweringDriver>['driver'];
  it.each([
    [
      'paused',
      (d: Driver) => {
        d.start();
        d.pause();
      },
    ],
    ['never started', (_d: Driver) => {}],
  ])('forwards the manual anchor when %s', async (_label, hold) => {
    const { compiled, driver, moves, snapshots } = makeAnsweringDriver();
    hold(driver);

    const target = compiled.sentences[3]!.startTokenIndex;
    driver.moveToToken(target);
    await vi.waitFor(() => expect(moves).toHaveLength(1));

    expect(snapshots.map((s) => s.confirmedToken)).toEqual([target]);
    expect(snapshots[0]?.decision).toBe('manualAnchor');
    driver.dispose();
  });

  it('steps one sentence further on every press while paused', async () => {
    const { compiled, driver, moves } = makeAnsweringDriver();
    driver.start();
    driver.pause();

    // Each press waits for the answer, which is what a presenter does: the
    // next step is measured from where the last one landed.
    for (let press = 1; press <= 3; press += 1) {
      driver.moveSentences(1);
      await vi.waitFor(() => expect(moves).toHaveLength(press));
    }

    expect(moves).toEqual(compiled.sentences.slice(1, 4).map((s) => s.startTokenIndex));
    driver.dispose();
  });

  it('restarts the paragraph the presenter stepped into while paused', async () => {
    const { compiled, driver, moves } = makeAnsweringDriver();
    driver.start();
    driver.pause();

    const fifth = compiled.sentences[4]!;
    driver.moveToToken(fifth.startTokenIndex + 1);
    await vi.waitFor(() => expect(moves).toHaveLength(1));
    driver.restartParagraph();
    await vi.waitFor(() => expect(moves).toHaveLength(2));

    const first = compiled.sentences.find((s) => s.blockId === fifth.blockId)!;
    expect(moves[1]).toBe(first.startTokenIndex);
    driver.dispose();
  });

  it('still drops the voice while paused', () => {
    const { driver, snapshots } = makeAnsweringDriver();
    driver.start();
    driver.pause();

    // Rust keeps publishing while the take is paused — transcription stays
    // connected — and none of it may move anything.
    for (const decision of [
      'localConfirmed',
      'localObserved',
      'relocationAccepted',
      'jumpForwardAccepted',
      'retakeAccepted',
      'holdLowEvidence',
    ] as const) {
      feed.push?.(snapshotAt(40, snapshots.length + 1, { decision }));
    }
    expect(snapshots).toHaveLength(0);

    driver.resume();
    feed.push?.(snapshotAt(40, 99, { decision: 'localConfirmed' }));
    expect(snapshots).toHaveLength(1);
    driver.dispose();
  });

  it('keeps the generation and disposal guards for a manual anchor', () => {
    const { driver, snapshots } = makeAnsweringDriver();
    driver.start();
    driver.pause();

    // The tail of a superseded take is not this take's position.
    feed.push?.(snapshotAt(12, 1, { sessionGeneration: 6 }));
    expect(snapshots).toHaveLength(0);

    const push = feed.push;
    driver.dispose();
    push?.(snapshotAt(12, 2));
    expect(snapshots).toHaveLength(0);
  });
});
