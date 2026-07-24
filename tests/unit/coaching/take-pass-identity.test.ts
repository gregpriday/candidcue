/**
 * Take-pass identity, reconciled across the lanes that key state on it.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * `startCoaching` minted `` `${sessionId}:1` `` once, for the whole session, and
 * never advanced it. `CoachingOrchestrator.beginTakePass` existed, was tested,
 * and had **no caller**. So a retake opened pass 2 in the §36.3 take history
 * while the coaching rail kept counting into pass 1: the filler tile showed a
 * number belonging to two takes at once, and the gutter marks and ribbon events
 * of a discarded performance stayed on the glass for the next one.
 *
 * These tests drive the real `CoachingSessionController`, the real orchestrator
 * and the real lanes — nothing here is stubbed but the audio device — and
 * assert on what the presenter sees, because "the id advanced" is the symptom
 * and "the count reset with it" is the point.
 *
 * ---------------------------------------------------------------------------
 * THE DISTINCTION THAT MUST SURVIVE
 * ---------------------------------------------------------------------------
 * Commit `faed40e` deliberately separated "new take pass" from "tracking epoch
 * changed". An epoch bump is a *position* jump inside one take — a command
 * jump, a re-anchor — and it must invalidate position-sensitive coaching state
 * while leaving the presenter's cumulative filler total standing. The matched
 * negative below exists so that wiring `beginTakePass` cannot be "fixed" later
 * by hanging it off the epoch.
 */
import { describe, expect, it } from 'vitest';

import { compile } from '../../../src/shared/markdown/compile';
import {
  CoachingSessionController,
  type CoachingSessionDeps,
} from '../../../src/control/services/coaching-session';
import { defaultCoachingSettings } from '../../../src/control/lib/coaching-profiles';
import {
  FIRST_TAKE_PASS_ORDINAL,
  nextTakePassOrdinal,
  parseTakePassId,
  takePassIdFor,
} from '../../../src/shared/coaching/take-pass';
import { trackingFidelityPassId } from '../../../src/shared/tracking/semantic-context';
import type { AudioFrameFeatures, CoachRailState } from '../../../src/shared/contracts/coaching';

const SESSION_ID = '5c0a9b3e-1d24-4f77-8a90-6b1c2d3e4f50';

/* ------------------------------------------------------------------ */
/* The scheme itself                                                   */
/* ------------------------------------------------------------------ */

describe('the authoritative take-pass scheme', () => {
  it('is exactly what the persisted session_takes rows already carry', () => {
    // `stores/session.ts` writes `record_session_take` with this literal, and
    // rows on disk from earlier builds carry it. Changing the shape would
    // orphan every historical row, so the shape is pinned here rather than
    // being whatever `takePassIdFor` happens to return.
    expect(takePassIdFor(SESSION_ID, 1)).toBe(`${SESSION_ID}:1`);
    expect(takePassIdFor(SESSION_ID, 7)).toBe(`${SESSION_ID}:7`);
    expect(FIRST_TAKE_PASS_ORDINAL).toBe(1);
  });

  it('round-trips, so a row on disk can be read back to its ordinal', () => {
    expect(parseTakePassId(takePassIdFor(SESSION_ID, 4))).toEqual({
      sessionId: SESSION_ID,
      passOrdinal: 4,
    });
    expect(nextTakePassOrdinal(4)).toBe(5);
  });

  it('refuses to mint an id that would compare unequal to everything', () => {
    // A zero, fractional or NaN ordinal is a caller defect. `session:0.5` looks
    // valid and silently discards a whole take's evidence.
    expect(takePassIdFor(SESSION_ID, 0)).toBe(`${SESSION_ID}:1`);
    expect(takePassIdFor(SESSION_ID, 2.7)).toBe(`${SESSION_ID}:2`);
    expect(takePassIdFor(SESSION_ID, Number.NaN)).toBe(`${SESSION_ID}:1`);
  });

  it('does not accept a foreign scheme as a take pass', () => {
    expect(parseTakePassId('take-2')).toBeNull();
    expect(parseTakePassId(`${SESSION_ID}:0`)).toBeNull();
    expect(parseTakePassId(`${SESSION_ID}:`)).toBeNull();
    expect(parseTakePassId(`${SESSION_ID}:abc`)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The tracking worker's third scheme                                  */
/* ------------------------------------------------------------------ */

describe('the tracking worker does not pretend to have a take pass', () => {
  /**
   * `semantic-context.ts` used to mint `` `${sessionId}:${generation}:${epoch}` ``
   * and hand it to a field called `takePassId`, which made three lanes look
   * like they were spelling one concept three ways. It is a different concept
   * — it changes on every epoch, i.e. *within* a pass — and it is never
   * compared, because `toCriticalChecks` drops the stamp that carries it.
   */
  it('mints something no take-pass consumer can mistake for a take pass', () => {
    const id = trackingFidelityPassId({
      sessionId: SESSION_ID,
      sessionGeneration: 3,
      semanticEpoch: 9,
    });
    expect(id).toContain('tracking-fidelity:');
    // Unparseable as a take pass, so a future path that leaked this stamp into
    // an `isEvidenceCurrent` check fails closed instead of matching whichever
    // pass happened to be open.
    expect(parseTakePassId(id)).toBeNull();
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
      expect(id).not.toBe(takePassIdFor(SESSION_ID, ordinal));
    }
  });
});

/* ------------------------------------------------------------------ */
/* A take, driven through the real controller                          */
/* ------------------------------------------------------------------ */

const SENTENCES = [
  'um we should start the release right here',
  'um the numbers came in ahead of forecast',
  'um nobody expected the migration to finish early',
  'um the roadmap after this point is short',
];

const SCRIPT = SENTENCES.map((line) => `${line.replace(/^./, (c) => c.toUpperCase())}.\n`).join(
  '\n',
);

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

interface Take {
  controller: CoachingSessionController;
  published: CoachRailState[];
  /** Speak one scripted sentence and commit it, at `trackingEpoch`. */
  say: (index: number, options?: { epoch?: number }) => void;
  /** Push a cursor snapshot only — no audio — e.g. to move the epoch. */
  cursor: (index: number, options?: { epoch?: number }) => void;
  /**
   * Pump silent frames. The rail republishes on the AUDIO clock, so a test
   * that changes state and then reads `latest()` without advancing time is
   * reading the snapshot from before the change.
   */
  pump: (durationMs: number) => void;
  latest: () => CoachRailState | undefined;
  start: () => Promise<void>;
}

function makeTake(deps: Partial<CoachingSessionDeps> = {}): Take {
  const compiled = compile(SCRIPT, { scriptId: 'take-pass-script' });
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
    sessionId: SESSION_ID,
    settings: { ...defaultCoachingSettings(), mode: 'coach' },
    compiled,
    stream,
    publish: (state) => published.push(state),
    startAnalyzer,
    ...deps,
  });

  let audioMs = 0;
  const pump = (durationMs: number, speaking: boolean): void => {
    const until = audioMs + durationMs;
    for (; audioMs <= until; audioMs += 20) onFrames?.([speechFrame(audioMs, speaking)]);
  };

  const cursor = (index: number, options: { epoch?: number } = {}): void => {
    const sentence = compiled.sentences[index];
    if (!sentence) throw new Error(`no sentence ${index}`);
    controller.setTrackingState({
      tokenIndex: sentence.startTokenIndex + 1,
      alignmentConfidence: 0.9,
      reacquiring: false,
      commandActive: false,
      activeScriptSpanId: sentence.id,
      trackingEpoch: options.epoch ?? 0,
    });
  };

  const say = (index: number, options: { epoch?: number } = {}): void => {
    cursor(index, options);
    pump(2_400, true);
    pump(600, false);
    controller.noteFinalTranscript({
      itemId: `item-${index + 1}`,
      commitSequence: index + 1,
      transcript: SENTENCES[index] ?? 'um and on it goes',
    });
    pump(400, false);
    cursor(index, options);
  };

  return {
    controller,
    published,
    say,
    cursor,
    pump: (durationMs: number) => pump(durationMs, false),
    latest: () => published[published.length - 1],
    start: () => controller.start(),
  };
}

function confirmedCount(take: Take): number {
  return take.latest()?.fillers.confirmedCount ?? -1;
}

/* ------------------------------------------------------------------ */
/* A retake advances the pass AND resets the counts                    */
/* ------------------------------------------------------------------ */

describe('§11.3 a retake advances the coaching lane in step with the take history', () => {
  it('advances the pass and zeroes the take-scoped counts with it', async () => {
    const take = makeTake();
    await take.start();

    take.say(0);
    take.say(1);
    take.say(2);

    // The pass the whole session used to stay on.
    expect(take.controller.hostState().takePassId).toBe(takePassIdFor(SESSION_ID, 1));
    const before = confirmedCount(take);
    expect(before).toBeGreaterThan(0);

    // The §36.3 take boundary: `restartParagraph` closes pass 1 and opens
    // pass 2. The coaching lane is told with the same ordinal.
    take.controller.beginTakePass(nextTakePassOrdinal(1));

    expect(take.controller.hostState().takePassId).toBe(takePassIdFor(SESSION_ID, 2));
    expect(take.controller.currentPassOrdinal()).toBe(2);

    take.cursor(0);
    expect(
      confirmedCount(take),
      'the filler tile carried the discarded take’s count into the new one',
    ).toBe(0);
    expect(take.latest()?.takePassId).toBe(takePassIdFor(SESSION_ID, 2));
    // §11.3: nothing crosses the boundary.
    expect(take.latest()?.gutterMarks).toHaveLength(0);
    expect(
      take.latest()?.ribbonEvents.every((e) => e.takePassId === takePassIdFor(SESSION_ID, 2)),
    ).toBe(true);

    await take.controller.dispose();
  });

  it('keeps advancing — pass 3 is not pass 1 with a different name', async () => {
    const take = makeTake();
    await take.start();
    take.say(0);
    take.controller.beginTakePass(2);
    take.say(1);
    take.controller.beginTakePass(3);
    expect(take.controller.hostState().takePassId).toBe(takePassIdFor(SESSION_ID, 3));
    await take.controller.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* …and an epoch bump is still not a retake                            */
/* ------------------------------------------------------------------ */

describe('§5.4 a command jump is a position jump, not a new take', () => {
  it('leaves the pass and the cumulative filler count alone', async () => {
    const take = makeTake();
    await take.start();

    take.say(0);
    take.say(1);
    take.say(2);
    const before = confirmedCount(take);
    expect(before).toBeGreaterThan(0);

    // "Go to the conclusion." The presenter's position was re-established
    // inside the same take pass — they did not start a new take.
    take.cursor(3, { epoch: 1 });
    // Let the audio clock move so the rail actually republishes; asserting on
    // a snapshot from before the jump would pass no matter what the jump did.
    take.pump(1_200);
    take.cursor(3, { epoch: 1 });

    expect(take.controller.hostState().trackingEpoch).toBe(1);
    expect(
      take.controller.hostState().takePassId,
      'an epoch bump advanced the take pass — §5.4’s separation was lost',
    ).toBe(takePassIdFor(SESSION_ID, 1));
    expect(
      confirmedCount(take),
      'the presenter’s cumulative filler total was zeroed by a jump',
    ).toBe(before);

    await take.controller.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* The id cannot be supplied from outside                              */
/* ------------------------------------------------------------------ */

describe('the controller mints its own id, it does not adopt one', () => {
  it('starts on the first pass when nothing is supplied', () => {
    const take = makeTake();
    expect(take.controller.hostState().takePassId).toBe(
      takePassIdFor(SESSION_ID, FIRST_TAKE_PASS_ORDINAL),
    );
  });

  it('takes the ordinal, not the string, from the deprecated dep', () => {
    const take = makeTake({ takePassId: `${SESSION_ID}:3` });
    expect(take.controller.currentPassOrdinal()).toBe(3);
    expect(take.controller.hostState().takePassId).toBe(takePassIdFor(SESSION_ID, 3));
  });

  it('refuses a foreign scheme rather than adopting it', () => {
    // The old orchestrator-level tests handed in strings like `take-2`. A
    // string in some other scheme cannot become the session's take identity.
    const take = makeTake({ takePassId: 'take-2' });
    expect(take.controller.hostState().takePassId).toBe(takePassIdFor(SESSION_ID, 1));
  });

  it('reports the ordinal its own id actually contains', () => {
    // A caller ordinal of 0 mints pass 1. Reporting 0 while stamping `:1`
    // would make the two lanes disagree through the reporting seam instead of
    // the minting one.
    const take = makeTake({ initialPassOrdinal: 0 });
    expect(take.controller.currentPassOrdinal()).toBe(1);
    expect(take.controller.hostState().takePassId).toBe(takePassIdFor(SESSION_ID, 1));

    take.controller.beginTakePass(2.9);
    expect(take.controller.currentPassOrdinal()).toBe(2);
    expect(take.controller.hostState().takePassId).toBe(takePassIdFor(SESSION_ID, 2));
  });

  it('re-mints even a well-formed id under its own session', () => {
    // A caller that passes another session's id does not get to rename this
    // session's takes.
    const take = makeTake({ takePassId: 'someone-else:5' });
    expect(take.controller.hostState().takePassId).toBe(takePassIdFor(SESSION_ID, 5));
  });
});
