/**
 * §8 persistent rail telemetry and the §14.5 pause ladder.
 *
 * The defect this file exists to catch is the tile that lies: a `0` where the
 * analyzer said "I do not know", a number that keeps twitching four times
 * faster than the eye can settle on it, a score invented before calibration,
 * or a WPM figure that sinks toward zero while the presenter deliberately holds
 * a beat.
 */
import { describe, expect, it } from 'vitest';
import {
  PACE_NUMBER_INTERVAL_MS,
  PACE_PAUSE_HOLD_MS,
  PACE_PAUSE_UNKNOWN_MS,
  PaceTilePresenter,
  UNKNOWN_VALUE,
  roundWpm,
  scheduleLabel,
  sparklinePoints,
} from '../../../src/stage/renderer/coach/paceTile';
import {
  fillerSummaryText,
  microphoneAlertText,
  varietyTileView,
} from '../../../src/stage/renderer/coach/statusText';
import {
  initialMicrophoneState,
  initialPaceState,
  initialVarietyState,
} from '../../../src/shared/coaching/coach/coach-state';
import type { PaceDisplayState } from '../../../src/shared/contracts/coaching';

function pace(overrides: Partial<PaceDisplayState> = {}): PaceDisplayState {
  return { ...initialPaceState(115, 160), ...overrides };
}

describe('§8.1 pace number', () => {
  it('renders — for an unknown pace and never 0', () => {
    const tile = new PaceTilePresenter();
    const learning = tile.update(pace(), 0);
    expect(learning.number).toBe(UNKNOWN_VALUE);
    expect(learning.number).not.toBe('0');
    expect(learning.label).toBe('LEARNING');
  });

  it('drops back to — when the producer stops knowing, instead of holding a stale number', () => {
    const tile = new PaceTilePresenter();
    expect(tile.update(pace({ wpm: 142, confidence: 0.9, state: 'on_target' }), 0).number).toBe('142');
    const unknown = tile.update(pace({ wpm: null, confidence: 0, state: 'low_confidence' }), 400);
    expect(unknown.number).toBe(UNKNOWN_VALUE);
  });

  it('shows a measured zero as 0, because that is a different claim', () => {
    const tile = new PaceTilePresenter();
    expect(tile.update(pace({ wpm: 0, confidence: 0.9, state: 'slow' }), 0).number).toBe('0');
  });

  it('redraws no more than four times a second', () => {
    const tile = new PaceTilePresenter();
    tile.update(pace({ wpm: 140, confidence: 0.9, state: 'on_target' }), 0);
    // Twenty updates spread across 200 ms: none of them may reach the glass.
    for (let i = 1; i <= 20; i++) {
      const view = tile.update(pace({ wpm: 140 + i, confidence: 0.9, state: 'on_target' }), i * 10);
      expect(view.number).toBe('140');
    }
    const after = tile.update(
      pace({ wpm: 161, confidence: 0.9, state: 'on_target' }),
      PACE_NUMBER_INTERVAL_MS,
    );
    expect(after.number).toBe('161');
  });

  it('rounds to a whole WPM, or the nearest two when the evidence is noisy', () => {
    expect(roundWpm(141.6, 0.9)).toBe(142);
    expect(roundWpm(141.6, 0.3)).toBe(142);
    expect(roundWpm(140.6, 0.3)).toBe(140);
    expect(roundWpm(143, 0.3) % 2).toBe(0);
  });

  it('is idempotent for a fixed time, so re-rendering does not advance the rate limiter', () => {
    const tile = new PaceTilePresenter();
    tile.update(pace({ wpm: 140, confidence: 0.9, state: 'on_target' }), 0);
    const a = tile.update(pace({ wpm: 190, confidence: 0.9, state: 'fast' }), 100);
    const b = tile.update(pace({ wpm: 190, confidence: 0.9, state: 'fast' }), 100);
    expect(b.number).toBe(a.number);
    expect(b.number).toBe('140');
  });
});

describe('§14.5 pause ladder', () => {
  const settled = pace({ wpm: 144, confidence: 0.9, state: 'on_target' });
  const paused = pace({ wpm: null, confidence: 0.9, state: 'paused' });

  function ladder(atMs: number) {
    const tile = new PaceTilePresenter();
    tile.update(settled, 0);
    // The pause starts at t=1000.
    tile.update(paused, 1_000);
    return tile.update(paused, 1_000 + atMs);
  }

  it('holds the last stable number and label for the first 1.5 seconds', () => {
    const held = ladder(PACE_PAUSE_HOLD_MS - 1);
    expect(held.number).toBe('144');
    expect(held.label).toBe('ON TARGET');
    expect(held.dim).toBe(false);
  });

  it('then says PAUSED with the number at lower contrast', () => {
    const view = ladder(PACE_PAUSE_HOLD_MS + 10);
    expect(view.number).toBe('144');
    expect(view.label).toBe('PAUSED');
    expect(view.dim).toBe(true);
  });

  it('drops the number to — after 8 seconds, and never toward zero', () => {
    const view = ladder(PACE_PAUSE_UNKNOWN_MS + 10);
    expect(view.number).toBe(UNKNOWN_VALUE);
    expect(view.label).toBe('PAUSED');
  });

  it('never lets the held number fall as the pause lengthens', () => {
    const tile = new PaceTilePresenter();
    tile.update(settled, 0);
    for (let t = 1_000; t < 1_000 + PACE_PAUSE_UNKNOWN_MS; t += 100) {
      const view = tile.update(paused, t);
      expect(view.number === '144' || view.number === UNKNOWN_VALUE).toBe(true);
      expect(view.number).not.toBe('0');
    }
  });

  it('restarts the ladder when speech resumes', () => {
    const tile = new PaceTilePresenter();
    tile.update(settled, 0);
    tile.update(paused, 1_000);
    expect(tile.update(paused, 4_000).label).toBe('PAUSED');
    const resumed = tile.update(pace({ wpm: 150, confidence: 0.9, state: 'on_target' }), 4_100);
    expect(resumed.label).toBe('ON TARGET');
    expect(resumed.dim).toBe(false);
    // A second pause gets its own 1.5 s hold rather than inheriting the first.
    expect(tile.update(paused, 4_200).label).toBe('ON TARGET');
  });
});

describe('§8.2 target-duration mode', () => {
  it('says ON TIME inside the tolerance and never chases small errors', () => {
    expect(scheduleLabel(0)).toBe('ON TIME');
    expect(scheduleLabel(4_000)).toBe('ON TIME');
    expect(scheduleLabel(-9_000)).toBe('ON TIME');
  });

  it('reads a projected overrun as behind and an early finish as ahead', () => {
    expect(scheduleLabel(12_000)).toBe('12 SEC BEHIND');
    expect(scheduleLabel(-12_000)).toBe('12 SEC AHEAD');
    expect(scheduleLabel(-28_400)).toBe('28 SEC AHEAD');
  });

  it('replaces the generic state line only once there is a projection', () => {
    const tile = new PaceTilePresenter();
    const noProjection = tile.update(
      pace({ wpm: 148, confidence: 0.9, state: 'on_target', targetDurationMs: 90_000 }),
      0,
    );
    expect(noProjection.label).toBe('ON TARGET');
    const projected = tile.update(
      pace({
        wpm: 148,
        confidence: 0.9,
        state: 'on_target',
        targetDurationMs: 90_000,
        projectedFinishDeltaMs: -12_000,
      }),
      500,
    );
    expect(projected.label).toBe('12 SEC AHEAD');
  });
});

describe('§8.1 sparkline', () => {
  it('needs at least two samples', () => {
    expect(sparklinePoints([], 115, 160)).toBeNull();
    expect(sparklinePoints([{ audioTimeMs: 0, wpm: 140 }], 115, 160)).toBeNull();
  });

  it('normalises against a range that always contains the target band', () => {
    const points = sparklinePoints(
      [
        { audioTimeMs: 0, wpm: 130 },
        { audioTimeMs: 1_000, wpm: 150 },
      ],
      115,
      160,
    );
    expect(points).not.toBeNull();
    expect(points![0]).toEqual({ x: 0, y: 1 - (130 - 115) / 45 });
    expect(points![1]!.x).toBe(1);
    // Faster draws higher on screen.
    expect(points![1]!.y).toBeLessThan(points![0]!.y);
  });
});

describe('§8.3 variety tile', () => {
  it('shows — and LEARNING before calibration rather than inventing a score', () => {
    const view = varietyTileView(initialVarietyState(40, 75));
    expect(view.number).toBe(UNKNOWN_VALUE);
    expect(view.number).not.toBe('0');
    expect(view.label).toBe('LEARNING');
  });

  it('shows the score once there is one', () => {
    const view = varietyTileView({ ...initialVarietyState(40, 75), level: 68.4, state: 'balanced' });
    expect(view.number).toBe('68');
    expect(view.label).toBe('BALANCED');
  });

  it('withholds the number when the analyzer does not trust it', () => {
    const view = varietyTileView({
      ...initialVarietyState(40, 75),
      level: 68,
      state: 'low_confidence',
    });
    expect(view.number).toBe(UNKNOWN_VALUE);
    expect(view.label).toBe('LOW CONFIDENCE');
  });

  it('treats too much and too little movement symmetrically (§2.5)', () => {
    const steady = varietyTileView({
      ...initialVarietyState(40, 75),
      level: 12,
      state: 'very_steady',
    });
    const animated = varietyTileView({
      ...initialVarietyState(40, 75),
      level: 94,
      state: 'highly_animated',
    });
    expect(steady.label).toBe('VERY STEADY');
    expect(animated.label).toBe('HIGHLY ANIMATED');
  });
});

describe('§8.4 filler summary', () => {
  it('counts confirmed events only', () => {
    expect(
      fillerSummaryText({
        confirmedCount: 2,
        confirmedLast20s: 2,
        confirmedLast60s: 2,
        dominantForm: 'um',
        degraded: false,
      }),
    ).toBe('FILLERS 2');
  });

  it('puts no permanent degradation warning on the presenter’s glass', () => {
    const degraded = fillerSummaryText({
      confirmedCount: 0,
      confirmedLast20s: 0,
      confirmedLast60s: 0,
      dominantForm: null,
      degraded: true,
    });
    expect(degraded).toBe('FILLERS 0');
  });
});

describe('§12.7 microphone line', () => {
  it('stays silent while the microphone is fine or still learning', () => {
    expect(microphoneAlertText(initialMicrophoneState())).toBeNull();
    expect(
      microphoneAlertText({ ...initialMicrophoneState(), status: 'ok', levelDbfs: -18, snrDb: 24 }),
    ).toBeNull();
  });

  it('waits for a fault to sustain before speaking', () => {
    const mic = { ...initialMicrophoneState(), status: 'clipping' as const, sustained: false };
    expect(microphoneAlertText(mic)).toBeNull();
    expect(microphoneAlertText({ ...mic, sustained: true })).toBe('MIC IS CLIPPING');
  });

  it('never waits to report a disconnected microphone', () => {
    expect(
      microphoneAlertText({ ...initialMicrophoneState(), status: 'disconnected', sustained: false }),
    ).toBe('MIC DISCONNECTED');
  });

  it('reports a degraded transcription path', () => {
    expect(
      microphoneAlertText({ ...initialMicrophoneState(), status: 'ok', transcriptionDegraded: true }),
    ).toBe('TRANSCRIPTION DEGRADED');
  });
});
