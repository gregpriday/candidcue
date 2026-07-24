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
