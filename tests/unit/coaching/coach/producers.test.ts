/**
 * The producers that did not exist: the ribbon, the §11 gutter marks, and the
 * §37 diagnostics record.
 *
 * Each of these had a contract type, a consumer, and no constructor anywhere —
 * the rail would have rendered an empty ribbon forever, `modules.gutterMarks`
 * gated an array nothing filled, and two diagnostics fields had no
 * instrumentation at all. The tests below are written so that a producer that
 * returned `[]`, or a constant, would fail: every "nothing is produced" case is
 * paired with a near-identical input that does produce something.
 */
import { describe, expect, it } from 'vitest';
import {
  CoachDiagnosticsCollector,
  RIBBON_MIN_EVENT_MS,
  buildGutterMarks,
  buildRibbonEvents,
  boundRibbon,
  meanLunaTransportLatencyMs,
  ribbonTypeForFiller,
  tipDisplayRatio,
} from '../../../../src/shared/coaching/coach';
import type { FillerEvent, SpeechInterval } from '../../../../src/shared/contracts/coaching';

const TAKE = 'take-1';

function filler(overrides: Partial<FillerEvent> = {}): FillerEvent {
  return {
    eventId: 'fil_1',
    kind: 'strict_vocalized',
    normalizedForm: 'um',
    displayForm: 'um',
    confidence: 'confirmed',
    evidenceSources: ['realtime'],
    audioStartMs: 1_000,
    audioEndMs: 1_300,
    timingConfidence: 0.9,
    scriptAnchorTokenId: 'tok-4',
    takePassId: TAKE,
    authoredIntentional: false,
    countedLive: false,
    ...overrides,
  };
}

function interval(startMs: number, endMs: number): SpeechInterval {
  return {
    startMs,
    endMs,
    voicedMs: endMs - startMs,
    silenceMs: 0,
    meanSnrDb: 20,
    takePassId: TAKE,
  };
}

/* ------------------------------------------------------------------------- */

describe('§27.4 the ribbon producer', () => {
  it('produces every shape the stage renders', () => {
    const events = buildRibbonEvents(
      {
        speechIntervals: [interval(0, 2_000)],
        fillers: [
          filler({ eventId: 'fil_a', audioStartMs: 500, audioEndMs: 700 }),
          filler({ eventId: 'fil_b', confidence: 'probable', audioStartMs: 900, audioEndMs: 1_000 }),
          filler({ eventId: 'fil_c', kind: 'false_start', audioStartMs: 1_200, audioEndMs: 1_400 }),
        ],
        pauses: [{ startMs: 2_000, endMs: 2_600, takePassId: TAKE }],
        retakes: [{ startMs: 3_000, endMs: 3_400, takePassId: TAKE }],
        criticalMismatches: [
          { evidenceId: 'fid-1', startMs: 4_000, endMs: 4_200, takePassId: TAKE, confidence: 0.9 },
        ],
        clipping: [{ startMs: 5_000, endMs: 5_500, takePassId: TAKE }],
      },
      TAKE,
    );

    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        'speech',
        'confirmed_filler',
        'probable_filler',
        'repetition',
        'pause',
        'retake',
        'critical_mismatch',
        'clipping',
      ]),
    );
    // Oldest first, matching the contract.
    const starts = events.map((e) => e.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('§10.4: the same input twice gives the same ids, so a revision replaces', () => {
    const first = buildRibbonEvents({ fillers: [filler()] }, TAKE);
    const revised = buildRibbonEvents({ fillers: [filler({ confidence: 'probable' })] }, TAKE);
    expect(revised[0]?.eventId).not.toBe(first[0]?.eventId);
    // …because the *type* changed; the underlying event id is still the same,
    // so the ribbon shows one tick that changed shape, not two ticks.
    expect(first[0]?.eventId).toContain('fil_1');
    expect(revised[0]?.eventId).toContain('fil_1');
    expect(buildRibbonEvents({ fillers: [filler()] }, TAKE)).toEqual(first);
  });

  it('§15.5: an authored disfluency is never drawn', () => {
    expect(buildRibbonEvents({ fillers: [filler({ authoredIntentional: true })] }, TAKE)).toEqual([]);
    // The same event without the flag is drawn — so the exclusion is the flag.
    expect(buildRibbonEvents({ fillers: [filler()] }, TAKE)).toHaveLength(1);
  });

  it('§15.3 / §2.4: an opener is not a disfluency tick', () => {
    expect(ribbonTypeForFiller(filler({ kind: 'repetitive_opener' }))).toBeNull();
    expect(ribbonTypeForFiller(filler({ confidence: 'rejected' }))).toBeNull();
    expect(ribbonTypeForFiller(filler())).toBe('confirmed_filler');
  });

  it('drops events from another take pass', () => {
    const events = buildRibbonEvents(
      { fillers: [filler({ takePassId: 'take-0' }), filler({ eventId: 'fil_2' })] },
      TAKE,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toContain('fil_2');
  });

  it('gives a zero-length event a drawable width', () => {
    const events = buildRibbonEvents(
      { clipping: [{ startMs: 5_000, endMs: 5_000, takePassId: TAKE }] },
      TAKE,
    );
    expect(events[0]?.endMs).toBe(5_000 + RIBBON_MIN_EVENT_MS);
  });

  it('composes with the builder’s windowing', () => {
    const events = buildRibbonEvents(
      {
        fillers: [
          filler({ eventId: 'old', audioStartMs: 0, audioEndMs: 100 }),
          filler({ eventId: 'new', audioStartMs: 59_000, audioEndMs: 59_100 }),
        ],
      },
      TAKE,
    );
    const bounded = boundRibbon(events, 60_000, TAKE);
    expect(bounded.map((e) => e.eventId)).toEqual([expect.stringContaining('new')]);
  });
});

/* ------------------------------------------------------------------------- */

describe('§11 the gutter-mark producer', () => {
  it('collapses several events on one line into one counted marker', () => {
    const marks = buildGutterMarks(
      {
        fillers: [
          filler({ eventId: 'fil_1', scriptAnchorTokenId: 'tok-1' }),
          filler({ eventId: 'fil_2', scriptAnchorTokenId: 'tok-2' }),
          filler({ eventId: 'fil_3', scriptAnchorTokenId: 'tok-9' }),
        ],
        lineForToken: (token) => (token === 'tok-9' ? 'line-2' : 'line-1'),
      },
      TAKE,
    );
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({ scriptAnchorTokenId: 'tok-1', count: 2, type: 'confirmed_filler' });
    expect(marks[1]).toMatchObject({ scriptAnchorTokenId: 'tok-9', count: 1 });
  });

  it('§11.2: an unlocalized event gets no mark rather than a guessed one', () => {
    expect(buildGutterMarks({ fillers: [filler({ scriptAnchorTokenId: null })] }, TAKE)).toEqual([]);
    // The same event with an anchor does get one.
    expect(buildGutterMarks({ fillers: [filler()] }, TAKE)).toHaveLength(1);
  });

  it('§11.3: marks from another pass over the same line are not conflated', () => {
    const marks = buildGutterMarks(
      {
        fillers: [
          filler({ eventId: 'fil_1', takePassId: 'take-0' }),
          filler({ eventId: 'fil_2', takePassId: TAKE }),
        ],
      },
      TAKE,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.count).toBe(1);
    expect(marks[0]?.takePassId).toBe(TAKE);
  });

  it('keeps different event types on the same line apart', () => {
    const marks = buildGutterMarks(
      {
        fillers: [
          filler({ eventId: 'fil_1' }),
          filler({ eventId: 'fil_2', kind: 'false_start' }),
        ],
        lineForToken: () => 'line-1',
      },
      TAKE,
    );
    expect(marks.map((m) => m.type).sort()).toEqual(['confirmed_filler', 'repetition']);
  });

  it('is stable across re-derivation, so marks do not renumber between frames', () => {
    const inputs = { fillers: [filler(), filler({ eventId: 'fil_2', scriptAnchorTokenId: 'tok-8' })] };
    expect(buildGutterMarks(inputs, TAKE)).toEqual(buildGutterMarks(inputs, TAKE));
  });
});

/* ------------------------------------------------------------------------- */

describe('§37 diagnostics', () => {
  it('assembles a complete record from the lanes that own each number', () => {
    const collector = new CoachDiagnosticsCollector();
    collector.noteDroppedFrameTotal(3);
    collector.noteAnalyzerPass(2);
    collector.noteAnalyzerPass(4);
    collector.noteLunaLatency(400);
    collector.noteLunaLatency(600);
    collector.noteObserver({ requests: 5, responses: 4, rejected: 1 });
    collector.notePrecision({ queued: 9, completed: 7, dropped: 2 });
    collector.noteTips({ proposed: 20, shown: 4, suppressed: 12, notSelected: 4 });

    expect(collector.snapshot()).toEqual({
      droppedFrameCount: 3,
      analyzerMeanCostMs: 3,
      lunaRequests: 5,
      lunaResponses: 4,
      lunaRejected: 1,
      lunaMeanLatencyMs: 500,
      precisionQueued: 9,
      precisionCompleted: 7,
      precisionDropped: 2,
      tipsProposed: 20,
      tipsShown: 4,
      tipsSuppressed: 12,
    });
    expect(tipDisplayRatio(collector.snapshot())).toBeCloseTo(0.2);
  });

  it('the dropped-frame count is a total, not a delta', () => {
    const collector = new CoachDiagnosticsCollector();
    collector.noteDroppedFrameTotal(4);
    collector.noteDroppedFrameTotal(7);
    // A late, lower report — an out-of-order worklet message — must not walk
    // the count backwards.
    collector.noteDroppedFrameTotal(5);
    expect(collector.snapshot().droppedFrameCount).toBe(7);
  });

  it('reports no ratio at all before anything has been proposed', () => {
    // `0/0` is not "the rail is quiet"; it is "no take has happened".
    expect(tipDisplayRatio(new CoachDiagnosticsCollector().snapshot())).toBeNull();
  });

  it('means the observer’s raw latency samples', () => {
    expect(
      meanLunaTransportLatencyMs({
        requests: 0,
        responses: 0,
        rejected: 0,
        failures: 0,
        refusals: 0,
        latencySamplesMs: [100, 200, 300],
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        availability: 'ready',
      }),
    ).toBe(200);
  });
});
