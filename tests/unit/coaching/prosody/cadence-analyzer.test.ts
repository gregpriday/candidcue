/**
 * Cadence and pause analysis (spec §18).
 *
 * §18.2's pause thresholds are asserted *at* the boundary — 179/180, 399/400,
 * 899/900 — because "roughly a short pause" is not a classification anybody can
 * reason about later. §18.3's rule that any one shaping cue is sufficient is
 * tested cue by cue, since an implementation that silently requires silence
 * would still pass a test that always supplies silence.
 */
import { describe, expect, it } from 'vitest';
import {
  assessBoundary,
  CADENCE_BALANCE_WEIGHTS,
  CadenceAnalyzer,
  classifyPause,
  type BoundaryEvent,
  type PauseEvent,
} from '../../../../src/shared/coaching/prosody/cadence-analyzer';
import type { CoachClockContext } from '../../../../src/shared/coaching/pace/speech-clock';

function ctx(audioTimeMs: number): CoachClockContext {
  return { audioTimeMs, trackingEpoch: 5, takePassId: 'pass-2', commitSequence: null };
}

function boundary(atMs: number, overrides: Partial<BoundaryEvent> = {}): BoundaryEvent {
  return {
    atMs,
    strength: 'strong',
    silenceMs: 0,
    pitchResetSemitones: 0,
    energyResetDb: 0,
    rateDecelerationRatio: 0,
    newContour: false,
    alignmentConfidence: 0.9,
    ...overrides,
  };
}

function pause(startMs: number, durationMs: number, overrides: Partial<PauseEvent> = {}): PauseEvent {
  return {
    startMs,
    endMs: startMs + durationMs,
    location: 'between_words',
    explained: false,
    manual: false,
    ...overrides,
  };
}

describe('classifyPause (§18.2)', () => {
  it('classifies exactly at the documented boundaries', () => {
    expect(classifyPause(79)).toBe('sub_threshold');
    expect(classifyPause(80)).toBe('micro');
    expect(classifyPause(179)).toBe('micro');
    expect(classifyPause(180)).toBe('short');
    expect(classifyPause(399)).toBe('short');
    expect(classifyPause(400)).toBe('medium');
    expect(classifyPause(899)).toBe('medium');
    expect(classifyPause(900)).toBe('long');
    expect(classifyPause(5_000)).toBe('long');
  });

  it('honours adapted thresholds (§18.2 "adapt modestly to the user\'s style")', () => {
    const stretched = { microMs: 100, shortMs: 220, mediumMs: 500, longMs: 1_100 };
    expect(classifyPause(200, stretched)).toBe('micro');
    expect(classifyPause(200)).toBe('short');
  });
});

describe('assessBoundary (§18.3)', () => {
  it('accepts a short silence as shaping', () => {
    const assessment = assessBoundary(boundary(1_000, { silenceMs: 200 }));
    expect(assessment.shaped).toBe(true);
    expect(assessment.reasons).toEqual(['silence']);
  });

  it('accepts a pitch reset with no silence at all', () => {
    // The point of §18.3: good phrasing is not the same as silence.
    const assessment = assessBoundary(boundary(1_000, { pitchResetSemitones: -3 }));
    expect(assessment.shaped).toBe(true);
    expect(assessment.reasons).toEqual(['pitch_reset']);
  });

  it('accepts an energy reset, a deceleration, or a new contour on its own', () => {
    expect(assessBoundary(boundary(1_000, { energyResetDb: -4 })).reasons).toEqual(['energy_reset']);
    expect(assessBoundary(boundary(1_000, { rateDecelerationRatio: 0.2 })).reasons).toEqual([
      'rate_deceleration',
    ]);
    expect(assessBoundary(boundary(1_000, { newContour: true })).reasons).toEqual(['new_contour']);
  });

  it('rejects a boundary the presenter simply ran through', () => {
    const assessment = assessBoundary(
      boundary(1_000, {
        silenceMs: 100,
        pitchResetSemitones: 0.5,
        energyResetDb: 1,
        rateDecelerationRatio: 0.05,
      }),
    );
    expect(assessment.shaped).toBe(false);
    expect(assessment.reasons).toEqual([]);
  });

  it('ignores unusable acoustic cues rather than treating null as zero movement', () => {
    const assessment = assessBoundary(
      boundary(1_000, { pitchResetSemitones: null, energyResetDb: null, silenceMs: 250 }),
    );
    expect(assessment.shaped).toBe(true);
    expect(assessment.reasons).toEqual(['silence']);
  });
});

describe('CadenceAnalyzer run-on pattern (§18.4)', () => {
  /** One 16 s unbroken run containing two unshaped strong boundaries. */
  function runOnEpisode(
    analyzer: CadenceAnalyzer,
    startMs: number,
  ): ReturnType<CadenceAnalyzer['noteBoundary']>[] {
    analyzer.noteSpeechOnset(startMs);
    const first = analyzer.noteBoundary(boundary(startMs + 8_000), ctx(startMs + 8_000));
    const second = analyzer.noteBoundary(boundary(startMs + 16_000), ctx(startMs + 16_000));
    analyzer.noteSpeechEnd(startMs + 17_000);
    return [first, second];
  }

  it('needs the pattern twice before proposing anything', () => {
    const analyzer = new CadenceAnalyzer();
    expect(runOnEpisode(analyzer, 0)).toEqual([null, null]);
    expect(analyzer.metrics(20_000).runOnCount).toBe(1);

    const second = runOnEpisode(analyzer, 40_000);
    expect(second[0]).toBeNull();
    expect(second[1]?.type).toBe('run_on_delivery');
    expect(second[1]?.stamp.audioStartMs).toBe(40_000);
    expect(second[1]?.stamp.audioEndMs).toBe(56_000);
    expect(second[1]?.stamp.trackingEpoch).toBe(5);
    expect(second[1]?.finalEvidence).toBe(true);
    expect(analyzer.metrics(60_000).runOnCount).toBe(2);
  });

  it('does not count a run whose boundaries were allowed to land', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    analyzer.noteBoundary(boundary(8_000, { silenceMs: 400 }), ctx(8_000));
    analyzer.noteBoundary(boundary(16_000, { pitchResetSemitones: -4 }), ctx(16_000));
    analyzer.noteSpeechEnd(17_000);
    expect(analyzer.metrics(20_000).runOnCount).toBe(0);
    expect(analyzer.metrics(20_000).shapedBoundaries).toBe(2);
  });

  it('does not count a short run, however unshaped its boundaries', () => {
    // Two run-through boundaries in six seconds is normal connected speech,
    // not run-on delivery.
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    analyzer.noteBoundary(boundary(3_000), ctx(3_000));
    analyzer.noteBoundary(boundary(6_000), ctx(6_000));
    analyzer.noteSpeechEnd(6_500);
    expect(analyzer.metrics(7_000).runOnCount).toBe(0);
  });

  it('does not count a long run with only one unshaped boundary', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    analyzer.noteBoundary(boundary(8_000, { silenceMs: 500 }), ctx(8_000));
    analyzer.noteBoundary(boundary(16_000), ctx(16_000));
    analyzer.noteSpeechEnd(17_000);
    expect(analyzer.metrics(20_000).runOnCount).toBe(0);
  });

  it('ignores weak boundaries entirely', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    analyzer.noteBoundary(boundary(8_000, { strength: 'weak' }), ctx(8_000));
    analyzer.noteBoundary(boundary(16_000, { strength: 'medium' }), ctx(16_000));
    analyzer.noteSpeechEnd(17_000);
    const metrics = analyzer.metrics(20_000);
    expect(metrics.runOnCount).toBe(0);
    expect(metrics.eligibleBoundaries).toBe(0);
  });

  it('records the longest breath group without coaching about it (§18.6)', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    analyzer.noteSpeechEnd(9_000);
    analyzer.noteSpeechOnset(12_000);
    analyzer.noteSpeechEnd(33_000);
    expect(analyzer.metrics(40_000).longestBreathGroupMs).toBe(21_000);
  });
});

describe('CadenceAnalyzer choppy pattern (§18.5)', () => {
  it('proposes choppy_delivery on the third unexplained mid-clause pause', () => {
    const analyzer = new CadenceAnalyzer();
    expect(analyzer.notePause(pause(1_000, 300), ctx(1_300))).toBeNull();
    expect(analyzer.notePause(pause(4_000, 500), ctx(4_500))).toBeNull();
    const candidate = analyzer.notePause(pause(8_000, 300), ctx(8_300));
    expect(candidate?.type).toBe('choppy_delivery');
    expect(candidate?.stamp.audioStartMs).toBe(1_300);
    expect(candidate?.stamp.audioEndMs).toBe(8_300);
    expect(candidate?.detailCode).toBe('mid_clause_3');
  });

  it('ignores pauses the script explains', () => {
    // §18.5: pauses explained by commas, parentheticals or difficult names are
    // not evidence of anything.
    const analyzer = new CadenceAnalyzer();
    for (const startMs of [1_000, 4_000, 8_000]) {
      expect(analyzer.notePause(pause(startMs, 300, { explained: true }), ctx(startMs))).toBeNull();
    }
    expect(analyzer.metrics(10_000).choppyPauseCount).toBe(0);
  });

  it('ignores pauses at authored boundaries', () => {
    const analyzer = new CadenceAnalyzer();
    for (const startMs of [1_000, 4_000, 8_000]) {
      expect(
        analyzer.notePause(pause(startMs, 300, { location: 'comma_boundary' }), ctx(startMs)),
      ).toBeNull();
    }
    expect(analyzer.metrics(10_000).choppyPauseCount).toBe(0);
  });

  it('ignores manual and system pauses', () => {
    const analyzer = new CadenceAnalyzer();
    for (const startMs of [1_000, 4_000, 8_000]) {
      expect(analyzer.notePause(pause(startMs, 3_000, { manual: true }), ctx(startMs))).toBeNull();
    }
    expect(analyzer.metrics(10_000).choppyPauseCount).toBe(0);
  });

  it('ignores micro-pauses, which are ordinary speech', () => {
    const analyzer = new CadenceAnalyzer();
    for (const startMs of [1_000, 4_000, 8_000]) {
      expect(analyzer.notePause(pause(startMs, 120), ctx(startMs))).toBeNull();
    }
    expect(analyzer.metrics(10_000).choppyPauseCount).toBe(0);
  });

  it('does not fire when three pauses are spread beyond the 20 s window', () => {
    const analyzer = new CadenceAnalyzer();
    expect(analyzer.notePause(pause(0, 300), ctx(300))).toBeNull();
    expect(analyzer.notePause(pause(15_000, 300), ctx(15_300))).toBeNull();
    // The first has aged out by the time the third arrives.
    expect(analyzer.notePause(pause(30_000, 300), ctx(30_300))).toBeNull();
    expect(analyzer.metrics(30_300).choppyPauseCount).toBe(2);
  });

  it('does not fire while script alignment is uncertain', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.setAlignmentConfidence(0.4);
    expect(analyzer.notePause(pause(1_000, 300), ctx(1_300))).toBeNull();
    expect(analyzer.notePause(pause(4_000, 300), ctx(4_300))).toBeNull();
    expect(analyzer.notePause(pause(8_000, 300), ctx(8_300))).toBeNull();
    expect(analyzer.metrics(10_000).choppyPauseCount).toBe(3);
  });
});

describe('CadenceAnalyzer cadenceBalance (§18.9)', () => {
  it('reports nothing before there is a boundary to score', () => {
    expect(new CadenceAnalyzer().metrics(10_000).cadenceBalance).toBeNull();
  });

  it('is exactly 1 for a clean take', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    for (const atMs of [3_000, 6_000, 9_000, 12_000]) {
      analyzer.noteBoundary(boundary(atMs, { silenceMs: 400 }), ctx(atMs));
    }
    analyzer.noteSpeechEnd(13_000);
    const metrics = analyzer.metrics(13_000, { terminalRushRate: 0, phraseRateStability: 1 });
    expect(metrics.shapedBoundaries).toBe(4);
    expect(metrics.cadenceBalance).toBeCloseTo(1, 9);
  });

  it('drops by exactly the boundary-shaping weight when half the boundaries are run through', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    analyzer.noteBoundary(boundary(3_000, { silenceMs: 400 }), ctx(3_000));
    analyzer.noteBoundary(boundary(6_000, { silenceMs: 400 }), ctx(6_000));
    analyzer.noteBoundary(boundary(9_000), ctx(9_000));
    analyzer.noteBoundary(boundary(12_000), ctx(12_000));
    analyzer.noteSpeechEnd(13_000);

    const metrics = analyzer.metrics(13_000, { terminalRushRate: 0, phraseRateStability: 1 });
    expect(metrics.cadenceBalance).toBeCloseTo(1 - CADENCE_BALANCE_WEIGHTS.boundaryShaping * 0.5, 9);
  });

  it('drops by exactly the terminal-rush weight when every sentence rushes', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    for (const atMs of [3_000, 6_000]) {
      analyzer.noteBoundary(boundary(atMs, { silenceMs: 400 }), ctx(atMs));
    }
    analyzer.noteSpeechEnd(7_000);
    const metrics = analyzer.metrics(7_000, { terminalRushRate: 1, phraseRateStability: 1 });
    expect(metrics.cadenceBalance).toBeCloseTo(1 - CADENCE_BALANCE_WEIGHTS.terminalRush, 9);
  });

  it('assumes nothing about inputs it was not given', () => {
    // Missing terminal-rush and stability inputs default to "no problem" so a
    // caller that has not wired pace in yet does not see a phantom penalty.
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    analyzer.noteBoundary(boundary(3_000, { silenceMs: 400 }), ctx(3_000));
    analyzer.noteSpeechEnd(4_000);
    expect(analyzer.metrics(4_000).cadenceBalance).toBeCloseTo(1, 9);
  });
});

describe('CadenceAnalyzer reset', () => {
  it('forgets everything from the previous take pass', () => {
    const analyzer = new CadenceAnalyzer();
    analyzer.noteSpeechOnset(0);
    analyzer.noteBoundary(boundary(8_000), ctx(8_000));
    analyzer.noteBoundary(boundary(16_000), ctx(16_000));
    analyzer.notePause(pause(17_000, 300), ctx(17_300));
    expect(analyzer.metrics(18_000).runOnCount).toBe(1);

    analyzer.reset();
    const metrics = analyzer.metrics(18_000);
    expect(metrics.runOnCount).toBe(0);
    expect(metrics.choppyPauseCount).toBe(0);
    expect(metrics.cadenceBalance).toBeNull();
    expect(metrics.longestBreathGroupMs).toBe(0);
  });
});
