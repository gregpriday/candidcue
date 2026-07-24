/**
 * §9.4 / §14.8 — a fast presenter actually gets told to ease back.
 *
 * `sentenceBoundaryPassed` and `safeMoment` were both wired through the
 * orchestrator and read on every aggregation pass, and nothing ever set either
 * of them. §14.8 gates *every* pace tip on the first and §9.4 gates every
 * ordinary tip's *display* on the second, so through the real controller no
 * pace tip could fire at all, however fast the presenter went.
 *
 * Asserting that the flags are now set would prove nothing — the flags being
 * set is the symptom, not the purpose. So these tests drive the real
 * `CoachingSessionController`, the real orchestrator and the real lanes, and
 * assert on the thing the presenter sees: `PACE_EASE_BACK` on the published
 * rail. The matched negative — the identical take with the cursor pinned
 * inside one sentence — exists to prove the gate is still a gate rather than a
 * constant `true`.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown/compile';
import {
  CoachingSessionController,
  type CoachingSessionDeps,
  type CoachingTrackingState,
} from '../../../src/control/services/coaching-session';
import { defaultCoachingSettings } from '../../../src/control/lib/coaching-profiles';
import type { AudioFrameFeatures, CoachRailState } from '../../../src/shared/contracts/coaching';
import type { CompiledScript } from '../../../src/shared/contracts';

/* ------------------------------------------------------------------ */
/* A take, driven through the real controller                          */
/* ------------------------------------------------------------------ */

const stream = {
  getAudioTracks: () => [{ kind: 'audio' }],
} as unknown as CoachingSessionDeps['stream'];

function speechFrame(audioTimeMs: number, speaking: boolean): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs: speaking ? -20 : -70,
    peakDbfs: speaking ? -10 : -60,
    clippingRatio: 0,
    noiseFloorDbfs: -70,
    estimatedSnrDb: speaking ? 25 : 2,
    speechProbability: speaking ? 0.92 : 0.02,
    voicedProbability: speaking ? 0.88 : 0,
    f0Hz: speaking ? 140 + (audioTimeMs % 40) : null,
    f0Confidence: speaking ? 0.9 : 0,
    spectralFlux: speaking ? 0.4 : 0.02,
    zeroCrossingRate: 0.05,
    processorDropout: false,
  };
}

/**
 * Nine words a sentence, so a sentence is a meaningful unit of the script and
 * the §9.4 "opening third" is three tokens wide rather than degenerate.
 */
const SENTENCE_WORDS = [
  'we shipped the whole release in a single afternoon',
  'the numbers came in ahead of every internal forecast',
  'nobody expected the migration to finish before the weekend',
  'that is the part of the story worth repeating',
  'so here is what the next quarter actually looks like',
  'the team wants one more pass before the announcement',
  'every dashboard we built last spring finally paid off',
  'our smallest customers adopted it faster than the largest',
  'support tickets dropped by half within the first month',
  'the roadmap after this point is deliberately kept short',
  'we will hold the remaining budget until the review',
  'that leaves exactly one decision left for this meeting',
];

const SCRIPT = SENTENCE_WORDS.map((words) => `${words.replace(/^./, (c) => c.toUpperCase())}.`)
  .map((line) => `${line}\n`)
  .join('\n');

interface Take {
  compiled: CompiledScript;
  controller: CoachingSessionController;
  published: CoachRailState[];
  /** Push a cursor snapshot without any audio, e.g. to move the sentence. */
  cursor: (sentenceIndex: number, tokenOffset: number) => void;
  /** Speak one sentence's worth of words at a gallop, then commit it. */
  say: (sentenceIndex: number, tokenOffset: number, itemId: string) => void;
  start: () => Promise<void>;
}

function makeTake(): Take {
  const compiled = compile(SCRIPT, { scriptId: 'pace-boundary-script' });
  let onFrames: ((frames: AudioFrameFeatures[]) => void) | null = null;
  const startAnalyzer = (async (options: { onFrames: (f: AudioFrameFeatures[]) => void }) => {
    onFrames = options.onFrames;
    return {
      sampleRate: 48_000,
      currentTimeMs: () => 0,
      clearBuffer: () => {},
      extract: async () => null,
      reset: () => {},
      close: async () => {},
      frameCount: 0,
      keepAliveInstalled: false,
    };
  }) as unknown as CoachingSessionDeps['startAnalyzer'];

  const published: CoachRailState[] = [];
  const controller = new CoachingSessionController({
    sessionId: '00000000-0000-0000-0000-00000000000a',
    settings: defaultCoachingSettings(),
    compiled,
    stream,
    takePassId: 'take-1',
    publish: (state) => published.push(state),
    startAnalyzer,
  });

  let audioMs = 0;
  const pump = (durationMs: number, speaking: boolean): void => {
    const until = audioMs + durationMs;
    for (; audioMs <= until; audioMs += 20) onFrames?.([speechFrame(audioMs, speaking)]);
  };

  const base: Omit<CoachingTrackingState, 'tokenIndex' | 'activeScriptSpanId'> = {
    alignmentConfidence: 0.9,
    reacquiring: false,
    commandActive: false,
    trackingEpoch: 0,
  };

  const cursor = (sentenceIndex: number, tokenOffset: number): void => {
    const sentence = compiled.sentences[sentenceIndex];
    if (!sentence) throw new Error(`no sentence ${sentenceIndex}`);
    controller.setTrackingState({
      ...base,
      tokenIndex: sentence.startTokenIndex + tokenOffset,
      activeScriptSpanId: sentence.id,
    });
  };

  /**
   * Nine words in 1.8 s of speech is ~300 WPM against a 160 WPM ceiling: past
   * the §14.7 shoulder, and sustained across the whole take. The transcript is
   * committed after the VAD closes the run, which is the order a real session
   * produces.
   */
  const say = (sentenceIndex: number, tokenOffset: number, itemId: string): void => {
    cursor(sentenceIndex, tokenOffset);
    pump(1_800, true);
    pump(300, false);
    controller.noteFinalTranscript({
      itemId,
      commitSequence: Number.parseInt(itemId.replace(/\D/g, ''), 10),
      transcript: SENTENCE_WORDS[sentenceIndex % SENTENCE_WORDS.length] ?? 'and on it goes',
    });
    pump(100, false);
    cursor(sentenceIndex, tokenOffset);
  };

  return { compiled, controller, published, cursor, say, start: () => controller.start() };
}

function tipCodes(published: readonly CoachRailState[]): string[] {
  return published.flatMap((state) => (state.activeTip ? [state.activeTip.code] : []));
}

/* ------------------------------------------------------------------ */
/* The tip fires                                                       */
/* ------------------------------------------------------------------ */

describe('§14.8 a sustained fast read across sentence boundaries raises the tip', () => {
  it('publishes PACE_EASE_BACK through the real controller', async () => {
    const take = makeTake();
    await take.start();

    // The whole script read at a gallop: the presenter crosses a boundary
    // every couple of seconds, which is what a real fast delivery looks like.
    for (let index = 0; index < 12; index += 1) {
      take.say(index, 1, `item-${index + 1}`);
    }

    expect(take.controller.telemetry().pace.state).toBe('fast');
    expect(take.controller.hostState().sentenceBoundaryPassed).toBe(true);
    expect(
      take.controller.telemetry().activeCandidates.map((c) => c.type),
    ).toContain('pace_too_fast');
    expect(tipCodes(take.published)).toContain('PACE_EASE_BACK');
  });

  /**
   * The gate, still a gate. Identical audio and identical transcript — the only
   * difference is that the alignment cursor never leaves the first sentence, so
   * no boundary is ever crossed. §14.8 says no tip, and a fix that simply
   * reported `true` would light this up.
   */
  it('control: the same fast take inside one sentence raises no pace tip', async () => {
    const take = makeTake();
    await take.start();

    for (let index = 0; index < 6; index += 1) {
      take.say(0, 1, `item-${index + 1}`);
    }

    // Measured just as fast — §6.1 keeps analysing — but never said out loud.
    expect(take.controller.telemetry().pace.state).toBe('fast');
    expect(take.controller.hostState().sentenceBoundaryPassed).toBe(false);
    expect(
      take.controller.telemetry().activeCandidates.map((c) => c.type),
    ).not.toContain('pace_too_fast');
    expect(tipCodes(take.published)).not.toContain('PACE_EASE_BACK');
  });

  /**
   * §5.4. A command jump, a retake or a re-anchor moves the cursor across any
   * number of boundaries the presenter never read. The engine bumps the epoch
   * across that seam, and a boundary that only exists because of it must not
   * make a tip eligible.
   */
  it('does not count a boundary the presenter never read across', async () => {
    const take = makeTake();
    await take.start();

    for (let index = 0; index < 6; index += 1) {
      const sentence = take.compiled.sentences[index];
      if (!sentence) throw new Error('short script');
      take.controller.setTrackingState({
        tokenIndex: sentence.startTokenIndex + 1,
        alignmentConfidence: 0.9,
        reacquiring: false,
        commandActive: false,
        // Every snapshot lands in a new epoch: the cursor is being relocated,
        // not read through.
        activeScriptSpanId: sentence.id,
        trackingEpoch: index + 1,
      });
      expect(take.controller.hostState().sentenceBoundaryPassed).toBe(false);
    }
    await take.controller.dispose();
  });

  /** A boundary crossed while the engine is reacquiring is a re-anchor. */
  it('does not count a boundary observed while reacquiring', async () => {
    const take = makeTake();
    await take.start();
    const first = take.compiled.sentences[0];
    const second = take.compiled.sentences[1];
    if (!first || !second) throw new Error('short script');

    const snapshot = (index: number, reacquiring: boolean): CoachingTrackingState => ({
      tokenIndex: (index === 0 ? first : second).startTokenIndex + 1,
      alignmentConfidence: 0.9,
      reacquiring,
      commandActive: false,
      activeScriptSpanId: (index === 0 ? first : second).id,
      trackingEpoch: 0,
    });

    take.controller.setTrackingState(snapshot(0, false));
    take.controller.setTrackingState(snapshot(1, true));
    expect(take.controller.hostState().sentenceBoundaryPassed).toBe(false);
    await take.controller.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* §9.4 safe moment                                                    */
/* ------------------------------------------------------------------ */

describe('§9.4 the safe display opportunity comes from the cursor', () => {
  it('is the opening third of the sentence and nowhere else', async () => {
    const take = makeTake();
    const sentence = take.compiled.sentences[2];
    if (!sentence) throw new Error('short script');
    const length = sentence.endTokenIndex - sentence.startTokenIndex + 1;
    expect(length).toBeGreaterThanOrEqual(6);

    take.cursor(2, 0);
    expect(take.controller.hostState().safeMoment).toBe(true);
    take.cursor(2, length - 1);
    expect(take.controller.hostState().safeMoment).toBe(false);
    await take.controller.dispose();
  });

  it('claims nothing while the engine is reacquiring the cursor', async () => {
    const take = makeTake();
    const sentence = take.compiled.sentences[2];
    if (!sentence) throw new Error('short script');
    take.controller.setTrackingState({
      tokenIndex: sentence.startTokenIndex,
      alignmentConfidence: 0.9,
      reacquiring: true,
      commandActive: false,
      activeScriptSpanId: sentence.id,
      trackingEpoch: 0,
    });
    expect(take.controller.hostState().safeMoment).toBe(false);
    await take.controller.dispose();
  });

  /** No compiled script means no sentence geometry, so nothing is claimed. */
  it('claims nothing without a compiled script', async () => {
    const controller = new CoachingSessionController({
      sessionId: '00000000-0000-0000-0000-00000000000b',
      settings: defaultCoachingSettings(),
      compiled: null,
      stream,
      takePassId: 'take-1',
      publish: () => {},
    });
    controller.setTrackingState({
      tokenIndex: 3,
      alignmentConfidence: 0.9,
      reacquiring: false,
      commandActive: false,
      activeScriptSpanId: 'unknown-span',
      trackingEpoch: 0,
    });
    expect(controller.hostState().safeMoment).toBe(false);
    await controller.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* §17.9 completed sentences                                           */
/* ------------------------------------------------------------------ */

describe('§17.9 completed sentences are counted from the cursor', () => {
  it('counts forward boundaries and resets on a new take pass', async () => {
    const take = makeTake();
    await take.start();
    expect(take.controller.hostState().completedSentences).toBe(0);

    take.cursor(0, 1);
    take.cursor(1, 1);
    take.cursor(2, 1);
    expect(take.controller.hostState().completedSentences).toBe(2);

    take.controller.beginTakePass('take-2');
    take.cursor(0, 1);
    expect(take.controller.hostState().completedSentences).toBe(0);
    await take.controller.dispose();
  });
});
