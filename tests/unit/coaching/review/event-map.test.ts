/**
 * §31.3 timeline.
 *
 * The assertions that matter here are the ones about what the timeline
 * *refuses* to do: it does not interpolate a WPM across an interval nobody
 * measured, it does not guess which sentence an unanchored filler belongs to,
 * and it does not offer playback for a recording that was never made. Each of
 * those has a fixture where the wrong behaviour produces a different, clearly
 * named value.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPassageIndex,
  buildTimeline,
  downsampleSteps,
  eventsForPass,
  eventsOnTrack,
  selectPassageForEvent,
} from '../../../../src/shared/coaching/review/event-map';
import { makeFiller, makePass, makeRecord, TEST_SCRIPT } from './support';

const index = buildPassageIndex(TEST_SCRIPT);

describe('timeline shape', () => {
  const timeline = buildTimeline(
    makeRecord([
      makePass({ takePassId: 'p1', passOrdinal: 1, startMs: 0, endMs: 100_000 }),
      makePass({ takePassId: 'p2', passOrdinal: 2, startMs: 100_000, endMs: 250_000 }),
    ]),
  );

  it('spans every pass on one axis', () => {
    expect(timeline.startMs).toBe(0);
    expect(timeline.endMs).toBe(250_000);
    expect(timeline.durationMs).toBe(250_000);
  });

  it('keeps the pass boundaries rather than flattening them (§11.3)', () => {
    expect(timeline.passes).toEqual([
      { takePassId: 'p1', passOrdinal: 1, startMs: 0, endMs: 100_000 },
      { takePassId: 'p2', passOrdinal: 2, startMs: 100_000, endMs: 250_000 },
    ]);
  });

  it('marks a retake at every pass after the first, and only there', () => {
    const retakes = eventsOnTrack(timeline, 'retakes');
    expect(retakes).toHaveLength(1);
    expect(retakes[0]?.startMs).toBe(100_000);
    expect(retakes[0]?.passOrdinal).toBe(2);
  });
});

describe('filler events', () => {
  const timeline = buildTimeline(
    makeRecord([
      makePass({
        fillers: [
          makeFiller({ atMs: 1_000, scriptAnchorTokenId: 't4' }),
          makeFiller({ atMs: 2_000, confidence: 'probable' }),
          makeFiller({ atMs: 3_000, confidence: 'rejected' }),
          makeFiller({ atMs: 4_000, authoredIntentional: true }),
          makeFiller({ atMs: 5_000, kind: 'false_start', normalizedForm: 'we we' }),
          makeFiller({
            atMs: 6_000,
            kind: 'contextual',
            normalizedForm: 'like',
            scriptAnchorTokenId: 't7',
          }),
        ],
      }),
    ]),
  );

  it('shows confirmed and probable fillers distinctly, and drops the rest', () => {
    const kinds = eventsOnTrack(timeline, 'fillers').map((event) => event.kind);
    expect(kinds).toEqual([
      'filler_confirmed',
      'filler_probable',
      'false_start',
      'filler_confirmed',
    ]);
  });

  it('quotes only a fixed-lexicon display form (§25.3)', () => {
    const labels = eventsOnTrack(timeline, 'fillers').map((event) => event.label);
    expect(labels).toContain('“um”');
    // The contextual detection is shown, but its transcript word is not.
    expect(labels).toContain('Filler');
    expect(labels.join(' ')).not.toContain('like');
  });

  it('orders every event by audio time', () => {
    const starts = timeline.events.map((event) => event.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe('selecting the aligned script passage', () => {
  const timeline = buildTimeline(
    makeRecord([
      makePass({
        fillers: [
          makeFiller({ atMs: 1_000, scriptAnchorTokenId: 't4' }),
          // §16.3.4: counted, but not localized — no anchor at all.
          makeFiller({ atMs: 2_000, scriptAnchorTokenId: null, timingConfidence: 0.1 }),
          makeFiller({ atMs: 3_000, scriptAnchorTokenId: 'token-from-another-revision' }),
        ],
      }),
    ]),
  );
  const [anchored, unanchored, foreign] = eventsOnTrack(timeline, 'fillers');

  it('resolves an anchored event to the passage containing its token', () => {
    const result = selectPassageForEvent(timeline, index, anchored?.eventId ?? '');
    expect(result.resolved).toBe(true);
    expect(result.resolved && result.selection.passage.spanId).toBe('span-b');
    expect(result.resolved && result.selection.passage.text).toBe(
      'Adoption reached forty percent in the first week.',
    );
  });

  it('declines rather than guessing when the event has no anchor', () => {
    const result = selectPassageForEvent(timeline, index, unanchored?.eventId ?? '');
    expect(result).toEqual({ resolved: false, reason: 'no_script_anchor' });
  });

  it('distinguishes "no anchor" from "anchor is not in this script"', () => {
    const result = selectPassageForEvent(timeline, index, foreign?.eventId ?? '');
    expect(result).toEqual({ resolved: false, reason: 'anchor_not_in_script' });
  });

  it('reports an unknown event id instead of throwing or returning a default', () => {
    expect(selectPassageForEvent(timeline, index, 'nope')).toEqual({
      resolved: false,
      reason: 'unknown_event',
    });
  });
});

describe('audio playback availability (§31.3)', () => {
  it('offers nothing when recording was never enabled', () => {
    const timeline = buildTimeline(makeRecord([makePass()]));
    expect(timeline.audio).toEqual({ available: false, reason: 'recording_not_enabled' });
    expect(timeline.audio.available).toBe(false);
  });

  it('offers playback only when the record says a recording exists', () => {
    const timeline = buildTimeline(
      makeRecord([makePass()], {
        audio: { available: true, recordingId: 'rec-1', durationMs: 360_000 },
      }),
    );
    expect(timeline.audio).toEqual({
      available: true,
      recordingId: 'rec-1',
      durationMs: 360_000,
    });
  });

  it('never upgrades an unavailable recording, whatever else the take contains', () => {
    const timeline = buildTimeline(
      makeRecord([makePass({ fillers: [makeFiller({ atMs: 1_000 })] })], {
        audio: { available: false, reason: 'consent_withdrawn' },
      }),
    );
    expect(timeline.audio.available).toBe(false);
    expect(timeline.audio.available === false && timeline.audio.reason).toBe('consent_withdrawn');
  });
});

describe('series', () => {
  it('preserves an unmeasured interval as a hole rather than a line', () => {
    const timeline = buildTimeline(
      makeRecord([
        makePass({
          paceSamples: [
            { startMs: 0, endMs: 10_000, audibleWpm: 130, state: 'on_target' },
            { startMs: 10_000, endMs: 20_000, audibleWpm: null, state: 'paused' },
            { startMs: 20_000, endMs: 30_000, audibleWpm: 150, state: 'on_target' },
          ],
        }),
      ]),
    );
    expect(timeline.wpm.map((step) => step.value)).toEqual([130, null, 150]);
    expect(timeline.wpm.map((step) => step.measuredMs)).toEqual([10_000, 0, 10_000]);
  });

  it('downsamples by duration-weighted mean of the measured part', () => {
    const steps = [
      { startMs: 0, endMs: 10_000, value: 100, measuredMs: 10_000 },
      { startMs: 10_000, endMs: 20_000, value: null, measuredMs: 0 },
      { startMs: 20_000, endMs: 30_000, value: 40, measuredMs: 10_000 },
      { startMs: 30_000, endMs: 40_000, value: 60, measuredMs: 30_000 },
    ];
    const out = downsampleSteps(steps, 2);
    expect(out).toHaveLength(2);
    // First bucket: only the 100 was measured, so the bucket is 100 — the
    // null neighbour is not treated as a zero.
    expect(out[0]).toEqual({ startMs: 0, endMs: 20_000, value: 100, measuredMs: 10_000 });
    // Second bucket: (40×10 000 + 60×30 000) / 40 000 = 55, not the plain mean 50.
    expect(out[1]).toEqual({ startMs: 20_000, endMs: 40_000, value: 55, measuredMs: 40_000 });
  });

  it('keeps an entirely unmeasured bucket null rather than borrowing a neighbour', () => {
    const out = downsampleSteps(
      [
        { startMs: 0, endMs: 1_000, value: 90, measuredMs: 1_000 },
        { startMs: 1_000, endMs: 2_000, value: null, measuredMs: 0 },
        { startMs: 2_000, endMs: 3_000, value: null, measuredMs: 0 },
        { startMs: 3_000, endMs: 4_000, value: null, measuredMs: 0 },
      ],
      2,
    );
    expect(out[1]?.value).toBeNull();
    expect(out[1]?.measuredMs).toBe(0);
  });

  it('leaves a series alone when it already fits', () => {
    const steps = [{ startMs: 0, endMs: 1_000, value: 5, measuredMs: 1_000 }];
    expect(downsampleSteps(steps, 100)).toEqual(steps);
  });

  it('publishes no script position while the cursor is re-acquiring', () => {
    const timeline = buildTimeline(
      makeRecord([
        makePass({
          scriptPositions: [
            { atMs: 0, cursorUnitIndex: 10, totalUnits: 100, confidence: 0.9, reacquiring: false, spanId: 'span-a' },
            { atMs: 1_000, cursorUnitIndex: 10, totalUnits: 100, confidence: 0.2, reacquiring: true, spanId: null },
          ],
        }),
      ]),
    );
    expect(timeline.scriptPosition.map((point) => point.progress)).toEqual([0.1, null]);
  });
});

describe('speech activity track', () => {
  it('separates voiced, pause and unmeasured rather than deriving silence', () => {
    const timeline = buildTimeline(
      makeRecord([
        makePass({
          startMs: 0,
          endMs: 20_000,
          speechIntervals: [
            {
              startMs: 0,
              endMs: 5_000,
              voicedMs: 4_500,
              silenceMs: 500,
              meanSnrDb: 20,
              takePassId: 'pass-1',
            },
          ],
          pauses: [
            { startMs: 5_000, endMs: 5_400, location: 'sentence_boundary' },
            { startMs: 10_000, endMs: 14_000, location: 'retake_boundary', manual: true },
          ],
          unmeasuredSpans: [{ startMs: 16_000, endMs: 17_000, reason: 'processor_dropout' }],
        }),
      ]),
    );
    expect(timeline.speech).toEqual([
      { startMs: 0, endMs: 5_000, kind: 'voiced' },
      { startMs: 5_000, endMs: 5_400, kind: 'pause' },
      // A manual pause is not delivery; it goes in the unmeasured lane (§18.2).
      { startMs: 10_000, endMs: 14_000, kind: 'unmeasured' },
      { startMs: 16_000, endMs: 17_000, kind: 'unmeasured' },
    ]);
  });
});

describe('take passes are never conflated (§11.3)', () => {
  const timeline = buildTimeline(
    makeRecord([
      makePass({
        takePassId: 'p1',
        passOrdinal: 1,
        startMs: 0,
        endMs: 50_000,
        fillers: [makeFiller({ atMs: 10_000, takePassId: 'p1', scriptAnchorTokenId: 't4' })],
      }),
      makePass({
        takePassId: 'p2',
        passOrdinal: 2,
        startMs: 50_000,
        endMs: 100_000,
        fillers: [makeFiller({ atMs: 60_000, takePassId: 'p2', scriptAnchorTokenId: 't4' })],
      }),
    ]),
  );

  it('keeps both readings of the same sentence as separate events', () => {
    const fillers = eventsOnTrack(timeline, 'fillers');
    expect(fillers).toHaveLength(2);
    expect(fillers.map((event) => event.passOrdinal)).toEqual([1, 2]);
    // Both resolve to the same passage — that is the point of showing both.
    for (const event of fillers) {
      const result = selectPassageForEvent(timeline, index, event.eventId);
      expect(result.resolved && result.selection.passage.spanId).toBe('span-b');
    }
  });

  it('filters events down to one pass on request', () => {
    expect(eventsForPass(timeline, 'p1').map((event) => event.takePassId)).toEqual(['p1']);
    expect(eventsForPass(timeline, 'p2').map((event) => event.takePassId)).toEqual(['p2', 'p2']);
  });
});
