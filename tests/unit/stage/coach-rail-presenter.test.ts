/**
 * §27 arrival validation and §6 mode behaviour, at the seam where a snapshot
 * becomes a frame of rail.
 *
 * These cover the cases that only appear when snapshots arrive badly: out of
 * order, from a session that has already ended, or not at all.
 */
import { describe, expect, it } from 'vitest';
import { CoachRailPresenter } from '../../../src/stage/renderer/coach/presenter';
import { resolveRailModules } from '../../../src/shared/coaching/coach/coach-state';
import { railState, ribbonEvent, tip } from './coach-rail-fixture';
import type { CoachRailState } from '../../../src/shared/contracts/coaching';

function frame(
  presenter: CoachRailPresenter,
  state: CoachRailState,
  monotonicMs: number,
  widthPx = 1280,
) {
  return presenter.update({ state, monotonicMs, widthPx, viewportHeightPx: 1080, textScale: 1 });
}

describe('§27 snapshot arrival', () => {
  it('ignores a stale revision instead of rolling the rail back', () => {
    const presenter = new CoachRailPresenter();
    const settled = railState({
      stageRevision: 7,
      pace: { ...railState().pace, wpm: 142, confidence: 0.9, state: 'on_target' },
    });
    expect(frame(presenter, settled, 0).pace?.number).toBe('142');
    // An older snapshot overtakes it on the wire.
    const stale = railState({
      stageRevision: 5,
      pace: { ...railState().pace, wpm: 90, confidence: 0.9, state: 'slow' },
    });
    const view = frame(presenter, stale, 1_000);
    expect(view.pace?.number).toBe('142');
    expect(view.pace?.label).toBe('ON TARGET');
  });

  it('keeps time running while stale snapshots arrive, so the ribbon still moves', () => {
    const presenter = new CoachRailPresenter();
    const state = railState({ stageRevision: 7, ribbonEvents: [ribbonEvent('speech', 0, 10_000)] });
    const first = frame(presenter, state, 0);
    const later = frame(presenter, railState({ stageRevision: 2 }), 3_000);
    expect(later.ribbon.nowMs).toBe(first.ribbon.nowMs + 3_000);
  });

  it('starts over for a different session rather than freezing on the old one', () => {
    const presenter = new CoachRailPresenter();
    frame(
      presenter,
      railState({
        stageRevision: 99,
        pace: { ...railState().pace, wpm: 142, confidence: 0.9, state: 'on_target' },
      }),
      0,
    );
    const next = frame(presenter, railState({ sessionId: 'session-2', stageRevision: 1 }), 1_000);
    // A rail stuck on the previous session's numbers is worse than a reset one.
    expect(next.pace?.number).toBe('—');
    expect(next.pace?.label).toBe('LEARNING');
  });
});

describe('§10.2 the ribbon rides the payload clock', () => {
  it('puts the payload clock at the now edge, not the newest event', () => {
    // The take is 60 s in and the last confirmed filler was at 50 s. The right
    // edge is 60 s, so the filler sits halfway through the 20 s window — a rail
    // that anchored on the newest *event* would pin it to the edge and claim
    // the presenter had just said it.
    const view = frame(
      new CoachRailPresenter(),
      railState({
        audioTimeMs: 60_000,
        ribbonEvents: [ribbonEvent('confirmed_filler', 50_000, 50_000)],
      }),
      0,
    );
    expect(view.ribbon.nowMs).toBe(60_000);
    expect(view.ribbon.marks[0]!.leftPercent).toBeCloseTo(50, 6);
  });

  it('keeps the now edge on the payload clock over a long take', () => {
    // Five minutes of 5 Hz snapshots whose audio clock runs slightly behind the
    // wall clock. An estimate that only ever ran forward would end the take
    // seconds ahead of the audio it is describing.
    const presenter = new CoachRailPresenter();
    let audioMs = 0;
    let monotonicMs = 0;
    let view = frame(presenter, railState({ audioTimeMs: audioMs }), monotonicMs);
    for (let i = 1; i <= 1_500; i += 1) {
      monotonicMs += 200;
      audioMs += 196;
      view = frame(
        presenter,
        railState({ stageRevision: i + 1, audioTimeMs: audioMs }),
        monotonicMs,
      );
    }
    expect(view.ribbon.nowMs).toBeGreaterThanOrEqual(audioMs);
    expect(view.ribbon.nowMs - audioMs).toBeLessThanOrEqual(500);
  });

  it('keeps the ribbon moving through a gap in the snapshots', () => {
    // Control publishes nothing for three seconds. The ribbon must keep
    // scrolling — the take did not stop happening (§10.2).
    const presenter = new CoachRailPresenter();
    const state = railState({
      audioTimeMs: 20_000,
      ribbonEvents: [ribbonEvent('confirmed_filler', 20_000, 20_000)],
    });
    const first = frame(presenter, state, 0);
    const during = frame(presenter, state, 1_500);
    const after = frame(presenter, state, 3_000);
    expect(during.ribbon.nowMs).toBe(first.ribbon.nowMs + 1_500);
    expect(after.ribbon.nowMs).toBe(first.ribbon.nowMs + 3_000);
    // …and the mark it already had slides left rather than sticking to the edge.
    expect(first.ribbon.marks[0]!.leftPercent).toBeCloseTo(100, 6);
    expect(after.ribbon.marks[0]!.leftPercent).toBeCloseTo(85, 6);
    // The next real snapshot picks the clock back up where the producer is.
    const resumed = frame(
      presenter,
      railState({ stageRevision: 2, audioTimeMs: 23_100, ribbonEvents: state.ribbonEvents }),
      3_000,
    );
    expect(resumed.ribbon.nowMs).toBe(23_100);
  });
});

describe('§9.3 the rail ages a tip on its own clock', () => {
  it('expires a tip while control repeats the same snapshot forever', () => {
    const presenter = new CoachRailPresenter();
    const stuck = railState({
      activeTip: tip({ maximumDisplayMs: 4_500, expiresAudioTimeMs: 1_000_000 }),
      ribbonEvents: [ribbonEvent('speech', 9_000, 10_000)],
    });
    expect(frame(presenter, stuck, 0).centre.kind).toBe('tip');
    expect(frame(presenter, stuck, 4_400).centre.kind).toBe('tip');
    expect(frame(presenter, stuck, 4_600).centre.kind).toBe('none');
  });

  it('keeps ageing the tip while the rail is hidden, so un-hiding cannot replay it', () => {
    const presenter = new CoachRailPresenter();
    const hidden = railState({
      visible: false,
      activeTip: tip({ maximumDisplayMs: 4_500, expiresAudioTimeMs: 1_000_000 }),
      ribbonEvents: [ribbonEvent('speech', 9_000, 10_000)],
    });
    frame(presenter, hidden, 0);
    frame(presenter, hidden, 5_000);
    const shown = frame(
      presenter,
      railState({
        stageRevision: 2,
        visible: true,
        activeTip: tip({ maximumDisplayMs: 4_500, expiresAudioTimeMs: 1_000_000 }),
        ribbonEvents: [ribbonEvent('speech', 9_000, 10_000)],
      }),
      5_100,
    );
    expect(shown.visible).toBe(true);
    expect(shown.centre.kind).toBe('none');
  });
});

describe('§6 modes end to end', () => {
  const busy = {
    pace: { ...railState().pace, wpm: 142, confidence: 0.9, state: 'on_target' as const },
    variety: { ...railState().variety, level: 68, state: 'balanced' as const },
    fillers: { ...railState().fillers, confirmedCount: 2 },
    ribbonEvents: [ribbonEvent('speech', 0, 10_000), ribbonEvent('confirmed_filler', 8_000, 8_200)],
  };

  it('Minimal keeps the pace tile and drops everything else', () => {
    const view = frame(new CoachRailPresenter(), railState({ mode: 'minimal', ...busy }), 0);
    expect(view.pace?.number).toBe('142');
    expect(view.variety).toBeNull();
    expect(view.fillers).toBeNull();
    expect(view.ribbon.show).toBe(false);
    expect(view.ribbon.marks).toHaveLength(0);
  });

  it('Coach shows the tiles and a restrained ribbon, but no sparkline', () => {
    const view = frame(
      new CoachRailPresenter(),
      railState({
        mode: 'coach',
        ...busy,
        pace: {
          ...busy.pace,
          recentSeries: [
            { audioTimeMs: 0, wpm: 130 },
            { audioTimeMs: 1_000, wpm: 150 },
          ],
        },
      }),
      0,
    );
    expect(view.sparkline).toBeNull();
    expect(view.ribbon.windowMs).toBe(20_000);
    expect(view.ribbon.marks.map((m) => m.type)).toEqual(['speech', 'confirmed_filler']);
  });

  it('Studio adds the sparkline and the wider window', () => {
    const view = frame(
      new CoachRailPresenter(),
      railState({
        mode: 'studio',
        ...busy,
        pace: {
          ...busy.pace,
          recentSeries: [
            { audioTimeMs: 0, wpm: 130 },
            { audioTimeMs: 1_000, wpm: 150 },
          ],
        },
      }),
      0,
    );
    expect(view.sparkline).toHaveLength(2);
    expect(view.ribbon.windowMs).toBe(30_000);
  });

  it('Review-only leaves the band and the critical alert, nothing else', () => {
    const view = frame(
      new CoachRailPresenter(),
      railState({
        mode: 'review_only',
        ...busy,
        microphone: {
          status: 'clipping',
          levelDbfs: -2,
          snrDb: 30,
          sustained: true,
          transcriptionDegraded: false,
        },
      }),
      0,
    );
    expect(view.present).toBe(true);
    expect(view.pace).toBeNull();
    expect(view.variety).toBeNull();
    expect(view.ribbon.show).toBe(false);
    expect(view.centre.text).toBe('MIC IS CLIPPING');
  });

  it('renders Custom from the flags it was sent, not from a guess', () => {
    // §6.6. `CoachRailModules` crosses in the snapshot precisely so the stage
    // never has to interpret `custom` for itself — the failure this replaced
    // was `custom` being indistinguishable from Coach on the glass, so a module
    // the user had turned off stayed on.
    const coach = frame(new CoachRailPresenter(), railState({ mode: 'coach', ...busy }), 0);
    const asCoach = frame(
      new CoachRailPresenter(),
      railState({ mode: 'custom', modules: resolveRailModules('coach'), ...busy }),
      0,
    );
    expect(asCoach.layout).toEqual(coach.layout);
    expect(asCoach.ribbon.windowMs).toBe(coach.ribbon.windowMs);

    const withoutScore = frame(
      new CoachRailPresenter(),
      railState({
        mode: 'custom',
        modules: resolveRailModules('custom', { ...resolveRailModules('coach'), deliveryScore: false }),
        ...busy,
      }),
      0,
    );
    expect(withoutScore.layout.showScore).toBe(false);
    expect(coach.layout.showScore).toBe(true);
    // Everything else about the two layouts is the same: turning one module off
    // must not quietly change another.
    expect({ ...withoutScore.layout, showScore: true }).toEqual(coach.layout);
  });

  it('mode off removes the rail from the layout entirely', () => {
    expect(frame(new CoachRailPresenter(), railState({ mode: 'off', ...busy }), 0).present).toBe(false);
  });
});
