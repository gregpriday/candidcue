/**
 * §10 recent-event ribbon and the audio-clock estimate that drives it.
 *
 * The two failures worth writing tests for:
 *
 *  - a late precision result appearing at "now" instead of where the speech
 *    actually was, which turns the ribbon from a memory aid into a liar;
 *  - motion that advances per *frame*, so the ribbon runs at a different speed
 *    on a 120 Hz display than on a 60 Hz one, or stalls when frames drop.
 */
import { describe, expect, it } from 'vitest';
import {
  RAIL_CLOCK_MAX_LEAD_MS,
  RailClock,
  railClockAnchorMs,
} from '../../../src/stage/renderer/coach/railClock';
import {
  RIBBON_ARRIVAL_FADE_MS,
  RIBBON_SHAPE,
  RIBBON_WINDOW_COACH_MS,
  RIBBON_WINDOW_STUDIO_MS,
  layoutRibbon,
  ribbonTypesFor,
  ribbonWindowMs,
} from '../../../src/stage/renderer/coach/ribbon';
import { railState, ribbonEvent, tip } from './coach-rail-fixture';
import type {
  CoachRailState,
  CoachRibbonEventType,
} from '../../../src/shared/contracts/coaching';

const ALL: ReadonlySet<CoachRibbonEventType> = new Set(
  Object.keys(RIBBON_SHAPE) as CoachRibbonEventType[],
);

describe('§10.2 window', () => {
  it('is 20 s in Coach and 30 s in Studio', () => {
    expect(ribbonWindowMs('coach')).toBe(RIBBON_WINDOW_COACH_MS);
    expect(RIBBON_WINDOW_COACH_MS).toBe(20_000);
    expect(ribbonWindowMs('studio')).toBe(RIBBON_WINDOW_STUDIO_MS);
    expect(RIBBON_WINDOW_STUDIO_MS).toBe(30_000);
  });

  it('puts the current audio time at the right edge', () => {
    const [mark] = layoutRibbon([ribbonEvent('confirmed_filler', 60_000, 60_000)], 60_000, 20_000, ALL);
    expect(mark!.leftPercent).toBe(100);
  });

  it('drops events that have aged out of the window', () => {
    const marks = layoutRibbon(
      [
        ribbonEvent('confirmed_filler', 30_000, 30_000),
        ribbonEvent('confirmed_filler', 55_000, 55_000),
      ],
      60_000,
      20_000,
      ALL,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]!.eventId).toBe('confirmed_filler-55000');
  });

  it('keeps a speech span that straddles the left edge, at its true position', () => {
    const [mark] = layoutRibbon([ribbonEvent('speech', 38_000, 45_000)], 60_000, 20_000, ALL);
    // Started before the window opened: the left edge is off-screen negative
    // rather than clamped to zero, so the span keeps its real length.
    expect(mark!.leftPercent).toBeLessThan(0);
    expect(mark!.widthPercent).toBeCloseTo(35, 6);
  });
});

describe('§10.4 retroactive insertion', () => {
  it('places a late result at its historical position, never at now', () => {
    const nowMs = 60_000;
    // Precision transcription confirms a filler that happened 12 s ago.
    const [mark] = layoutRibbon([ribbonEvent('confirmed_filler', 48_000, 48_300)], nowMs, 20_000, ALL);
    // 48 000 sits 12 000 ms into a 20 000 ms window: 40% from the left.
    expect(mark!.leftPercent).toBeCloseTo(40, 6);
    expect(mark!.leftPercent).toBeLessThan(100);
  });

  it('places it identically whenever the stage happens to first see it', () => {
    const event = ribbonEvent('confirmed_filler', 48_000, 48_300);
    const early = layoutRibbon([event], 60_000, 20_000, ALL)[0]!;
    // The same snapshot, delivered again by a control side that resent it.
    const late = layoutRibbon([event], 60_000, 20_000, ALL)[0]!;
    expect(late.leftPercent).toBe(early.leftPercent);
    // Position is a function of the event's timestamps and the current time,
    // and of nothing else: there is no arrival-time input to get wrong.
    expect(layoutRibbon.length).toBe(4);
  });

  it('fades in over 150–250 ms', () => {
    expect(RIBBON_ARRIVAL_FADE_MS).toBeGreaterThanOrEqual(150);
    expect(RIBBON_ARRIVAL_FADE_MS).toBeLessThanOrEqual(250);
  });
});

describe('§10.3 marker encoding', () => {
  it('gives every event type a distinct shape, so colour is never load-bearing', () => {
    const shapes = Object.values(RIBBON_SHAPE);
    expect(new Set(shapes).size).toBe(shapes.length);
    expect(RIBBON_SHAPE.confirmed_filler).toBe('tick');
    expect(RIBBON_SHAPE.probable_filler).toBe('hollow-tick');
    expect(RIBBON_SHAPE.repetition).toBe('double-tick');
    expect(RIBBON_SHAPE.retake).toBe('hook');
    expect(RIBBON_SHAPE.critical_mismatch).toBe('diamond');
    expect(RIBBON_SHAPE.clipping).toBe('top-block');
  });

  it('spans intervals for traces and points for events', () => {
    const marks = layoutRibbon(
      [ribbonEvent('speech', 50_000, 54_000), ribbonEvent('confirmed_filler', 52_000, 52_200)],
      60_000,
      20_000,
      ALL,
    );
    expect(marks[0]!.widthPercent).toBeCloseTo(20, 6);
    expect(marks[1]!.widthPercent).toBe(0);
  });
});

describe('§10.5 restraint', () => {
  it('shows only speech, confirmed fillers, and the now edge by default', () => {
    const allowed = ribbonTypesFor('coach');
    expect([...allowed].sort()).toEqual(['confirmed_filler', 'speech']);
    const marks = layoutRibbon(
      [
        ribbonEvent('speech', 50_000, 54_000),
        ribbonEvent('confirmed_filler', 52_000, 52_200),
        ribbonEvent('probable_filler', 53_000, 53_200),
        ribbonEvent('clipping', 53_500, 53_700),
        ribbonEvent('pause', 54_000, 55_000),
      ],
      60_000,
      20_000,
      allowed,
    );
    expect(marks.map((m) => m.type)).toEqual(['speech', 'confirmed_filler']);
  });

  it('opens the rest up in Studio', () => {
    expect(ribbonTypesFor('studio').size).toBe(Object.keys(RIBBON_SHAPE).length);
  });
});

describe('the rail audio clock', () => {
  /** A snapshot at a stated audio time, with evidence that says otherwise. */
  function atAudioTime(audioTimeMs: number, extra: Partial<CoachRailState> = {}): CoachRailState {
    return railState({
      audioTimeMs,
      ribbonEvents: [ribbonEvent('speech', 0, 5_000)],
      activeTip: tip({ createdAudioTimeMs: 9_000 }),
      pace: { ...railState().pace, recentSeries: [{ audioTimeMs: 6_000, wpm: 140 }] },
      ...extra,
    });
  }

  it('takes its anchor from the payload clock, not from the newest stamp it can find', () => {
    // The producer sends the clock; deriving one from the evidence was the
    // estimate this replaced. The evidence here peaks at 9 000 and is ignored.
    expect(railClockAnchorMs(atAudioTime(12_345))).toBe(12_345);
    expect(railClockAnchorMs(railState({ audioTimeMs: 0 }))).toBe(0);
  });

  it('falls back to the newest stamp only when the payload carries no clock', () => {
    // A payload that crossed the window boundary without the field. The type is
    // a claim, not a fact, and a rail pinned at zero would draw nothing.
    const malformed = atAudioTime(12_345);
    delete (malformed as { audioTimeMs?: number }).audioTimeMs;
    expect(railClockAnchorMs(malformed)).toBe(9_000);
  });

  it('reads the payload clock back exactly, with no catch-up crawl', () => {
    const clock = new RailClock();
    expect(clock.sync(atAudioTime(10_000), 0)).toBe(10_000);
    // The producer's clock jumped 500 ms in one snapshot — a stall, a resync,
    // or simply a late publish. The rail is told the time; it does not haggle.
    expect(clock.sync(atAudioTime(10_500, { stageRevision: 2 }), 0)).toBe(10_500);
  });

  it('tracks the payload clock instead of drifting away from it', () => {
    const clock = new RailClock();
    let audioMs = 30_000;
    clock.sync(atAudioTime(audioMs), 0);
    // Sixty seconds of 5 Hz snapshots, with the payload clock running 3% slow
    // against the wall clock — dropped frames, a busy analyzer. A free-running
    // estimate would end nearly two seconds ahead of the take.
    let monotonicMs = 0;
    let reading = 0;
    for (let i = 1; i <= 300; i += 1) {
      monotonicMs += 200;
      audioMs += 194;
      reading = clock.sync(atAudioTime(audioMs, { stageRevision: i + 1 }), monotonicMs);
    }
    expect(reading - audioMs).toBeLessThanOrEqual(RAIL_CLOCK_MAX_LEAD_MS);
    expect(reading).toBeGreaterThanOrEqual(audioMs);
    // Free-running from the first anchor would have reached 30 000 + 60 000.
    expect(reading).toBeLessThan(30_000 + 60_000 - 1_000);
  });

  it('never drags the ribbon rightward while it converges', () => {
    const clock = new RailClock();
    clock.sync(atAudioTime(10_000), 0);
    // A long silence in the publisher: the rail free-ran five seconds while the
    // audio clock only advanced one.
    const drifted = clock.read(5_000);
    expect(drifted).toBe(15_000);
    let previous = drifted;
    let audioMs = 11_000;
    let monotonicMs = 5_000;
    for (let i = 0; i < 40; i += 1) {
      monotonicMs += 200;
      audioMs += 200;
      const reading = clock.sync(atAudioTime(audioMs, { stageRevision: i + 2 }), monotonicMs);
      // The correction holds the clock still; it never runs it backward, which
      // would move a mark toward "now" (§10.4).
      expect(reading).toBeGreaterThanOrEqual(previous);
      previous = reading;
    }
    // …and it did converge, rather than holding the drift forever.
    expect(previous - audioMs).toBeLessThanOrEqual(RAIL_CLOCK_MAX_LEAD_MS);
  });

  it('advances with elapsed time, not with the number of reads', () => {
    const clock = new RailClock();
    const state = atAudioTime(10_000);
    clock.sync(state, 1_000);
    // A frame-counting implementation would drift with how often it is polled.
    const busy = new RailClock();
    busy.sync(state, 1_000);
    for (let i = 0; i < 500; i++) busy.read(1_000 + i * 0.2);
    expect(busy.read(1_100)).toBe(clock.read(1_100));
    expect(clock.read(1_100) - clock.read(1_000)).toBe(100);
  });

  it('keeps moving while snapshots stop arriving', () => {
    const clock = new RailClock();
    clock.sync(atAudioTime(10_000), 0);
    expect(clock.read(0)).toBe(10_000);
    expect(clock.read(5_000)).toBe(15_000);
  });

  it('keeps moving while the same snapshot is re-rendered', () => {
    // The component re-evaluates this on its own 10 Hz tick, with whatever
    // snapshot it last accepted. A clock that only advanced on new payloads
    // would freeze the ribbon between publishes.
    const clock = new RailClock();
    const stuck = atAudioTime(10_000);
    clock.sync(stuck, 0);
    expect(clock.sync(stuck, 1_000)).toBe(11_000);
    expect(clock.sync(stuck, 2_000)).toBe(12_000);
  });

  it('is idempotent for a fixed monotonic time', () => {
    const clock = new RailClock();
    clock.sync(atAudioTime(10_000), 0);
    const state = atAudioTime(10_600, { stageRevision: 2 });
    const first = clock.sync(state, 100);
    for (let i = 0; i < 20; i += 1) expect(clock.sync(state, 100)).toBe(first);
  });

  it('never runs backward when an older payload clock arrives', () => {
    const clock = new RailClock();
    clock.sync(atAudioTime(10_000), 0);
    const before = clock.read(2_000);
    // Out-of-order delivery is normal (§27) and a lower clock is not a
    // correction.
    const after = clock.sync(atAudioTime(5_000, { stageRevision: 2 }), 2_000);
    expect(after).toBe(before);
    expect(clock.read(2_000)).toBe(before);
  });

  it('starts over for a new take pass', () => {
    const clock = new RailClock();
    clock.sync(atAudioTime(90_000), 0);
    const restarted = clock.sync(
      railState({
        stageRevision: 2,
        takePassId: 'pass-2',
        audioTimeMs: 400,
        ribbonEvents: [ribbonEvent('speech', 0, 400, { takePassId: 'pass-2' })],
      }),
      0,
    );
    expect(restarted).toBe(400);
  });
});
