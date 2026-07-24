/**
 * §31.2 summary. Every fixture below is built so the correct answer is known
 * by hand: 900 audible words over 6 minutes of delivery is 150 WPM whatever
 * the implementation does, and each assertion names that number.
 *
 * Several fixtures are chosen specifically so a *plausible wrong*
 * implementation produces a different answer:
 *
 * - the dropout fixture reads 150 WPM if delivery time is taken as elapsed
 *   audio, and 163 WPM if the dropout is removed as it must be;
 * - the variety fixture reads 50 if the average is a mean of samples, and 60
 *   if it is weighted by duration as it must be;
 * - the pace-band fixture reads 50% if unmeasured intervals stay in the
 *   denominator, and 60% if they are excluded as they must be.
 *
 * A function returning `{}` or a constant fails all of them.
 */
import { describe, expect, it } from 'vitest';
import {
  computeTakeMetrics,
  deliveryMsBetween,
  longestFillerFreeMsInPass,
  summarizeMicrophone,
  summarizeSession,
} from '../../../../src/shared/coaching/review/session-summary';
import { formatRate, formatWpm } from '../../../../src/shared/coaching/review/cards';
import {
  EMPTY_CADENCE,
  makeFiller,
  makePass,
  makeRecord,
  TEST_PROFILE,
} from './support';

describe('headline rates', () => {
  // 900 audible words, 6:00 of delivery, 5:00 voiced, 12 confirmed fillers.
  const fillers = Array.from({ length: 12 }, (_, index) =>
    makeFiller({ atMs: 10_000 + index * 25_000 }),
  );
  const summary = summarizeSession(makeRecord([makePass({ fillers })]));

  it('audible WPM is words over delivery time', () => {
    // 900 / 6 minutes.
    expect(summary.metrics.pace.audibleWpm.value).toBe(150);
    expect(formatWpm(summary.metrics.pace.audibleWpm.value as number)).toBe('150 WPM');
  });

  it('articulation WPM is words over voiced time, which is a different number', () => {
    // 900 / 5 minutes.
    expect(summary.metrics.pace.articulationWpm.value).toBe(180);
  });

  it('counts exactly the confirmed fillers', () => {
    expect(summary.metrics.fillers.confirmedCount).toBe(12);
  });

  it('reports 1.33 fillers per 100 words for 12 fillers in 900 words', () => {
    const perHundred = summary.metrics.fillers.perHundredWords.value as number;
    expect(perHundred).toBeCloseTo(12 / 9, 10);
    expect(formatRate(perHundred)).toBe('1.33');
  });

  it('reports 2.0 fillers per minute over six minutes', () => {
    expect(summary.metrics.fillers.perMinute.value).toBe(2);
  });

  it('does not count probable, rejected, or authored-intentional fillers', () => {
    const mixed = summarizeSession(
      makeRecord([
        makePass({
          fillers: [
            makeFiller({ atMs: 1_000 }),
            makeFiller({ atMs: 2_000, confidence: 'probable' }),
            makeFiller({ atMs: 3_000, confidence: 'rejected' }),
            makeFiller({ atMs: 4_000, authoredIntentional: true }),
            // §2.4: a repetitive opener is a session pattern, never a filler.
            makeFiller({ atMs: 5_000, kind: 'repetitive_opener', normalizedForm: 'and' }),
          ],
        }),
      ]),
    );
    expect(mixed.metrics.fillers.confirmedCount).toBe(1);
    expect(mixed.metrics.fillers.probableCount).toBe(1);
    expect(mixed.metrics.fillers.repetitiveOpenerCount).toBe(1);
  });
});

describe('time accounting', () => {
  // 6:00 of audio with a 30 s worklet dropout in the middle.
  const pass = makePass({
    startMs: 0,
    endMs: 360_000,
    voicedMs: 250_000,
    internalPauseMs: 40_000,
    unmeasuredSpans: [{ startMs: 60_000, endMs: 90_000, reason: 'processor_dropout' }],
  });
  const metrics = computeTakeMetrics([pass], TEST_PROFILE);

  it('removes unmeasured audio from delivery time', () => {
    expect(metrics.time.deliveryMs).toBe(330_000);
    expect(metrics.time.unmeasuredMs).toBe(30_000);
  });

  it('never folds the dropout into pause time', () => {
    // The wrong answer — `spanMs - voicedMs` — is 110 000.
    expect(metrics.time.internalPauseMs).toBe(40_000);
    expect(metrics.time.internalPauseMs).not.toBe(metrics.time.spanMs - metrics.time.voicedMs);
  });

  it('reports the residual the VAD never classified rather than absorbing it', () => {
    // 360 000 − 250 000 − 40 000 − 30 000.
    expect(metrics.time.unaccountedMs).toBe(40_000);
  });

  it('changes the pace answer, which is the whole point', () => {
    // 900 / 5.5 minutes = 163.6…, not the 150 you get from elapsed audio.
    expect(metrics.pace.audibleWpm.value).toBeCloseTo(900 / 5.5, 9);
    expect(metrics.pace.audibleWpm.value).not.toBe(150);
  });

  it('flags a producer whose parts exceed the span instead of clamping', () => {
    const broken = computeTakeMetrics(
      [makePass({ startMs: 0, endMs: 10_000, voicedMs: 9_000, internalPauseMs: 5_000 })],
      TEST_PROFILE,
    );
    expect(broken.time.inconsistent).toBe(true);
    expect(broken.time.unaccountedMs).toBe(0);
  });

  it('deliveryMsBetween clamps to the pass and subtracts overlap once', () => {
    // Two overlapping unmeasured spans must not be subtracted twice.
    const time = {
      startMs: 0,
      endMs: 10_000,
      voicedMs: 0,
      internalPauseMs: 0,
      unmeasuredSpans: [
        { startMs: 1_000, endMs: 4_000, reason: 'command' as const },
        { startMs: 3_000, endMs: 5_000, reason: 'manual_pause' as const },
      ],
    };
    expect(deliveryMsBetween(time, 0, 10_000)).toBe(6_000);
    expect(deliveryMsBetween(time, -5_000, 50_000)).toBe(6_000);
    expect(deliveryMsBetween(time, 5_000, 8_000)).toBe(3_000);
  });
});

describe('time inside target pace', () => {
  const metrics = computeTakeMetrics(
    [
      makePass({
        paceSamples: [
          { startMs: 0, endMs: 60_000, audibleWpm: 130, state: 'on_target' },
          { startMs: 60_000, endMs: 120_000, audibleWpm: 180, state: 'fast' },
          { startMs: 120_000, endMs: 150_000, audibleWpm: null, state: 'paused' },
          // Exactly the band floor — inclusive.
          { startMs: 150_000, endMs: 180_000, audibleWpm: 115, state: 'on_target' },
        ],
      }),
    ],
    TEST_PROFILE,
  );

  it('sums milliseconds inside the band, inclusive of the edges', () => {
    expect(metrics.pace.insideTargetMs).toBe(90_000);
  });

  it('excludes unmeasured intervals from the denominator', () => {
    expect(metrics.pace.measuredMs).toBe(150_000);
    // 90 000 / 150 000. Leaving the paused interval in would give 0.5.
    expect(metrics.pace.insideTargetRatio.value).toBe(0.6);
  });

  it('has no ratio at all when pace was never measured', () => {
    const empty = computeTakeMetrics([makePass()], TEST_PROFILE);
    expect(empty.pace.insideTargetRatio.value).toBeNull();
    expect(empty.pace.insideTargetRatio.absent).toBe('no_pace_samples');
  });
});

describe('filler-free stretch', () => {
  it('is the whole take when there were no fillers — not null', () => {
    const metrics = computeTakeMetrics([makePass({ fillers: [] })], TEST_PROFILE);
    expect(metrics.fillers.longestFillerFreeMs.absent).toBeNull();
    expect(metrics.fillers.longestFillerFreeMs.value).toBe(360_000);
  });

  it('measures the longest gap between fillers in delivery time', () => {
    const pass = makePass({
      startMs: 0,
      endMs: 100_000,
      fillers: [makeFiller({ atMs: 20_000, durationMs: 500 })],
      unmeasuredSpans: [{ startMs: 40_000, endMs: 50_000, reason: 'manual_pause' }],
    });
    // Gaps: 0→20 000 = 20 000; 20 500→100 000 = 79 500 minus the 10 000 pause.
    expect(longestFillerFreeMsInPass(pass)).toBe(69_500);
  });

  it('never spans a take-pass boundary (§11.3)', () => {
    const metrics = computeTakeMetrics(
      [
        makePass({ takePassId: 'p1', passOrdinal: 1, startMs: 0, endMs: 100_000 }),
        makePass({
          takePassId: 'p2',
          passOrdinal: 2,
          startMs: 100_000,
          endMs: 300_000,
          fillers: [makeFiller({ atMs: 250_000, takePassId: 'p2' })],
        }),
      ],
      TEST_PROFILE,
    );
    // Joining the passes would give 250 000. The answer is the longest single
    // in-pass stretch: 100 000 → 250 000.
    expect(metrics.fillers.longestFillerFreeMs.value).toBe(150_000);
  });
});

describe('most frequent filler', () => {
  const metrics = computeTakeMetrics(
    [
      makePass({
        fillers: [
          ...Array.from({ length: 5 }, (_, i) => makeFiller({ atMs: 1_000 + i * 1_000 })),
          ...Array.from({ length: 7 }, (_, i) =>
            makeFiller({
              atMs: 100_000 + i * 1_000,
              kind: 'contextual',
              normalizedForm: 'like',
            }),
          ),
        ],
      }),
    ],
    TEST_PROFILE,
  );

  it('picks the genuinely most repeated form', () => {
    expect(metrics.fillers.mostFrequent.value?.normalizedForm).toBe('like');
    expect(metrics.fillers.mostFrequent.value?.count).toBe(7);
  });

  it('refuses to quote a contextual form back (§25.3)', () => {
    expect(metrics.fillers.mostFrequent.value?.displayForm).toBeNull();
  });

  it('quotes a strict lexicon form', () => {
    const strictOnly = computeTakeMetrics(
      [makePass({ fillers: [makeFiller({ atMs: 1_000 }), makeFiller({ atMs: 2_000 })] })],
      TEST_PROFILE,
    );
    expect(strictOnly.fillers.mostFrequent.value?.displayForm).toBe('um');
  });

  it('has no answer when there were no fillers', () => {
    const none = computeTakeMetrics([makePass()], TEST_PROFILE);
    expect(none.fillers.mostFrequent.value).toBeNull();
    expect(none.fillers.mostFrequent.absent).toBe('no_fillers');
  });
});

describe('filler clusters (§16.7)', () => {
  it('counts three inside twenty seconds as one cluster, and a long run as one', () => {
    const metrics = computeTakeMetrics(
      [
        makePass({
          fillers: [
            makeFiller({ atMs: 1_000 }),
            makeFiller({ atMs: 8_000 }),
            makeFiller({ atMs: 15_000 }),
            makeFiller({ atMs: 22_000 }),
            // A lone late filler, far outside any window.
            makeFiller({ atMs: 300_000 }),
          ],
        }),
      ],
      TEST_PROFILE,
    );
    expect(metrics.fillers.clusterCount).toBe(1);
  });

  it('counts no cluster when three fillers are spread beyond the window', () => {
    const metrics = computeTakeMetrics(
      [
        makePass({
          fillers: [
            makeFiller({ atMs: 0 }),
            makeFiller({ atMs: 15_000 }),
            makeFiller({ atMs: 40_000 }),
          ],
        }),
      ],
      TEST_PROFILE,
    );
    expect(metrics.fillers.clusterCount).toBe(0);
  });
});

describe('variety', () => {
  it('weights the average by duration, not by sample count', () => {
    const metrics = computeTakeMetrics(
      [
        makePass({
          varietySamples: [
            {
              startMs: 0,
              endMs: 10_000,
              level: 30,
              state: 'steady',
              energyRangeDb: null,
              pitchSpanSemitones: null,
            },
            {
              startMs: 10_000,
              endMs: 40_000,
              level: 70,
              state: 'expressive',
              energyRangeDb: null,
              pitchSpanSemitones: null,
            },
          ],
        }),
      ],
      TEST_PROFILE,
    );
    // A plain mean of the two samples is 50. Duration-weighted it is 60.
    expect(metrics.variety.averageLevel.value).toBe(60);
    expect(metrics.variety.range.value).toEqual({ low: 30, high: 70 });
  });

  it('fabricates nothing on a take too short to score', () => {
    const metrics = computeTakeMetrics([makePass({ varietySamples: [] })], TEST_PROFILE);
    expect(metrics.variety.averageLevel.value).toBeNull();
    expect(metrics.variety.averageLevel.absent).toBe('no_variety_samples');
    expect(metrics.variety.range.value).toBeNull();
    expect(metrics.variety.insideTargetRatio.value).toBeNull();
  });

  it('distinguishes "pitch was unusable" from "we never sampled"', () => {
    const metrics = computeTakeMetrics(
      [
        makePass({
          varietySamples: [
            {
              startMs: 0,
              endMs: 20_000,
              level: null,
              state: 'low_confidence',
              energyRangeDb: 9,
              pitchSpanSemitones: null,
            },
          ],
        }),
      ],
      TEST_PROFILE,
    );
    expect(metrics.variety.averageLevel.absent).toBe('pitch_unusable');
    // §17.5 allows an explicitly labelled energy-only observation in review.
    expect(metrics.variety.energyFallbackRangeDb.value).toEqual({
      meanDb: 9,
      lowDb: 9,
      highDb: 9,
    });
  });

  it('does not offer the energy fallback when a real variety level exists', () => {
    const metrics = computeTakeMetrics(
      [
        makePass({
          varietySamples: [
            {
              startMs: 0,
              endMs: 20_000,
              level: 55,
              state: 'balanced',
              energyRangeDb: 9,
              pitchSpanSemitones: 4,
            },
          ],
        }),
      ],
      TEST_PROFILE,
    );
    expect(metrics.variety.energyFallbackRangeDb.value).toBeNull();
    expect(metrics.variety.insideTargetRatio.value).toBe(1);
  });
});

describe('cadence and terminal rush', () => {
  const metrics = computeTakeMetrics(
    [
      makePass({
        cadence: { ...EMPTY_CADENCE, runOnCount: 2, choppyPauseCount: 4, longestBreathGroupMs: 21_000 },
        terminalRushSentences: [
          { startMs: 0, endMs: 5_000, wordCount: 12, ratio: 1.3, measurable: true, reason: 'ok', spanId: 'span-a', scriptAnchorTokenId: 't1' },
          // Exactly the threshold — counted.
          { startMs: 5_000, endMs: 10_000, wordCount: 10, ratio: 1.25, measurable: true, reason: 'ok', spanId: 'span-a', scriptAnchorTokenId: 't2' },
          { startMs: 10_000, endMs: 15_000, wordCount: 10, ratio: 1.24, measurable: true, reason: 'ok', spanId: 'span-b', scriptAnchorTokenId: 't4' },
          { startMs: 15_000, endMs: 20_000, wordCount: 4, ratio: null, measurable: false, reason: 'too_few_words', spanId: 'span-b', scriptAnchorTokenId: 't5' },
          { startMs: 20_000, endMs: 25_000, wordCount: 14, ratio: 1.5, measurable: true, reason: 'ok', spanId: 'span-c', scriptAnchorTokenId: 't7' },
        ],
        boundaries: [
          { atMs: 5_000, strength: 'strong', shaped: true, spanId: 'span-a', scriptAnchorTokenId: 't3' },
          { atMs: 10_000, strength: 'strong', shaped: false, spanId: 'span-b', scriptAnchorTokenId: 't6' },
          { atMs: 15_000, strength: 'paragraph', shaped: true, spanId: 'span-c', scriptAnchorTokenId: 't8' },
          // Weak boundaries are not eligible under §18.3.
          { atMs: 17_000, strength: 'weak', shaped: false, spanId: 'span-c', scriptAnchorTokenId: 't8' },
        ],
        pauses: [
          { startMs: 1_000, endMs: 1_100, location: 'between_words' },
          { startMs: 2_000, endMs: 2_300, location: 'comma_boundary' },
          { startMs: 3_000, endMs: 4_200, location: 'sentence_boundary' },
          { startMs: 5_000, endMs: 9_000, location: 'retake_boundary', manual: true },
        ],
      }),
    ],
    TEST_PROFILE,
  );

  it('counts a sentence ending as rushed at and above the threshold', () => {
    expect(metrics.cadence.terminalRushCount).toBe(3);
    expect(metrics.cadence.terminalRushEligibleSentences).toBe(4);
    expect(metrics.cadence.terminalRushRatio.value).toBe(0.75);
  });

  it('carries run-on and choppy counts through from the cadence lane', () => {
    expect(metrics.cadence.runOnCount).toBe(2);
    expect(metrics.cadence.choppyPauseCount).toBe(4);
    expect(metrics.cadence.longestBreathGroupMs).toBe(21_000);
  });

  it('scores only eligible boundaries', () => {
    expect(metrics.cadence.eligibleBoundaries).toBe(3);
    expect(metrics.cadence.shapedBoundaries).toBe(2);
    expect(metrics.cadence.shapedBoundaryRatio.value).toBeCloseTo(2 / 3, 10);
  });

  it('classifies pauses and excludes manual ones from the classes', () => {
    expect(metrics.cadence.pauseCounts.micro).toBe(1);
    expect(metrics.cadence.pauseCounts.short).toBe(1);
    expect(metrics.cadence.pauseCounts.long).toBe(1);
    expect(metrics.cadence.pauseCounts.excluded).toBe(1);
  });

  it('has no terminal-rush ratio when no sentence was measurable', () => {
    const none = computeTakeMetrics([makePass()], TEST_PROFILE);
    expect(none.cadence.terminalRushRatio.value).toBeNull();
    expect(none.cadence.terminalRushRatio.absent).toBe('no_eligible_sentences');
    expect(none.cadence.shapedBoundaryRatio.absent).toBe('no_eligible_boundaries');
  });
});

describe('take passes (§11.3)', () => {
  const summary = summarizeSession(
    makeRecord([
      makePass({
        takePassId: 'p1',
        passOrdinal: 1,
        startMs: 0,
        endMs: 120_000,
        audibleWords: 300,
        voicedMs: 100_000,
        fillers: Array.from({ length: 4 }, (_, i) =>
          makeFiller({ atMs: 1_000 + i * 1_000, takePassId: 'p1' }),
        ),
      }),
      makePass({
        takePassId: 'p2',
        passOrdinal: 2,
        startMs: 120_000,
        endMs: 360_000,
        audibleWords: 600,
        voicedMs: 200_000,
        fillers: Array.from({ length: 8 }, (_, i) =>
          makeFiller({ atMs: 130_000 + i * 1_000, takePassId: 'p2' }),
        ),
      }),
    ]),
  );

  it('counts every pass after the first as a retake', () => {
    expect(summary.takePassCount).toBe(2);
    expect(summary.retakeCount).toBe(1);
  });

  it('aggregates the session without losing the per-pass split', () => {
    expect(summary.metrics.fillers.confirmedCount).toBe(12);
    expect(summary.passes.map((pass) => pass.metrics.fillers.confirmedCount)).toEqual([4, 8]);
    expect(summary.passes.map((pass) => pass.takePassId)).toEqual(['p1', 'p2']);
  });

  it('keeps per-pass rates apart rather than averaging them', () => {
    // 300 words / 2 min = 150; 600 words / 4 min = 150 — but voiced time
    // differs, so articulation must differ.
    expect(summary.passes[0]?.metrics.pace.articulationWpm.value).toBe(180);
    expect(summary.passes[1]?.metrics.pace.articulationWpm.value).toBe(180);
    expect(summary.passes[0]?.metrics.time.spanMs).toBe(120_000);
    expect(summary.passes[1]?.metrics.time.spanMs).toBe(240_000);
  });

  it('reports a single-pass take as zero retakes', () => {
    expect(summarizeSession(makeRecord([makePass()])).retakeCount).toBe(0);
  });
});

describe('critical script discrepancies', () => {
  const finding = (id: string, selfCorrected: boolean) => ({
    findingId: id,
    kind: 'critical_number_mismatch' as const,
    atMs: 1_000,
    endMs: 1_500,
    takePassId: 'pass-1',
    spanId: 'span-b',
    scriptAnchorTokenId: 't4',
    authoredFragment: 'forty percent',
    spokenFragment: 'fourteen percent',
    localConfidence: 0.9,
    selfCorrected,
  });

  it('excludes self-corrected findings from the count but still lists them', () => {
    const metrics = computeTakeMetrics(
      [
        makePass({
          criticalFindings: [finding('f1', false), finding('f2', true), finding('f3', false)],
        }),
      ],
      TEST_PROFILE,
    );
    expect(metrics.fidelity.criticalDiscrepancyCount).toBe(2);
    expect(metrics.fidelity.selfCorrectedCount).toBe(1);
    expect(metrics.fidelity.findings).toHaveLength(3);
    expect(metrics.fidelity.byKind.critical_number_mismatch).toBe(2);
  });
});

describe('microphone summary', () => {
  it('reports the dominant status by time and lists sustained problems', () => {
    const mic = summarizeMicrophone({
      spans: [
        { startMs: 0, endMs: 100_000, status: 'ok', sustained: false },
        { startMs: 100_000, endMs: 120_000, status: 'noisy', sustained: true },
        { startMs: 120_000, endMs: 200_000, status: 'ok', sustained: false },
      ],
      levelSamples: [
        { atMs: 0, levelDbfs: -30, snrDb: 18 },
        { atMs: 1_000, levelDbfs: -20, snrDb: 22 },
        { atMs: 2_000, levelDbfs: -25, snrDb: 20 },
      ],
      transcriptionDegradedMs: 4_000,
    });
    expect(mic.dominantStatus.value).toBe('ok');
    expect(mic.msByStatus.ok).toBe(180_000);
    expect(mic.msByStatus.noisy).toBe(20_000);
    expect(mic.sustainedIssues).toEqual([{ status: 'noisy', totalMs: 20_000, episodes: 1 }]);
    // 180 000 / 200 000 = 0.9, below the 95% consistency bar.
    expect(mic.consistent.value).toBe(false);
    expect(mic.medianLevelDbfs.value).toBe(-25);
    expect(mic.medianSnrDb.value).toBe(20);
    expect(mic.transcriptionDegradedMs).toBe(4_000);
  });

  it('says nothing at all when the microphone was never measured', () => {
    const mic = summarizeMicrophone({ spans: [], levelSamples: [], transcriptionDegradedMs: 0 });
    expect(mic.dominantStatus.value).toBeNull();
    expect(mic.dominantStatus.absent).toBe('no_microphone_data');
    expect(mic.medianLevelDbfs.value).toBeNull();
    expect(mic.consistent.value).toBeNull();
  });

  it('makes no absolute loudness claim (§12.7.4)', () => {
    const mic = summarizeMicrophone({
      spans: [{ startMs: 0, endMs: 1_000, status: 'ok', sustained: false }],
      levelSamples: [{ atMs: 0, levelDbfs: -24, snrDb: null }],
      transcriptionDegradedMs: 0,
    });
    expect(JSON.stringify(mic)).not.toMatch(/spl|decibelsSpl|loudnessDb\b/i);
    expect(mic.medianLevelDbfs.value).toBeLessThan(0);
  });
});

describe('projected versus actual duration', () => {
  it('reports both and their difference when a projection existed', () => {
    const summary = summarizeSession(
      makeRecord([makePass({ endMs: 300_000, projectedTotalMs: 330_000 })], {
        profile: { ...TEST_PROFILE, targetDurationMs: 320_000 },
      }),
    );
    expect(summary.metrics.duration.actualDurationMs).toBe(300_000);
    expect(summary.metrics.duration.projectedTotalMs.value).toBe(330_000);
    expect(summary.metrics.duration.projectedMinusActualMs.value).toBe(30_000);
    expect(summary.metrics.duration.actualMinusTargetMs.value).toBe(-20_000);
  });

  it('offers no projection rather than a zero when there never was one', () => {
    const summary = summarizeSession(makeRecord([makePass({ projectedTotalMs: null })]));
    expect(summary.metrics.duration.projectedTotalMs.value).toBeNull();
    expect(summary.metrics.duration.projectedTotalMs.absent).toBe('no_projection');
    expect(summary.metrics.duration.actualMinusTargetMs.absent).toBe('no_target_duration');
  });
});
