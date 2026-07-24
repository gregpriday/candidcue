/**
 * §27 rail-state assembly, and the §2.1 hard constraint.
 *
 * The revision test would fail for a builder that returned a constant; the
 * ribbon tests assert both what is kept and what is dropped, so an
 * always-empty or pass-through implementation fails; the §2.1 test enumerates
 * the snapshot's own keys rather than trusting the type, because the type is
 * exactly what a future edit would change.
 */
import { describe, expect, it } from 'vitest';
import {
  CoachRailStateBuilder,
  CoachTipPolicy,
  RIBBON_MAX_EVENTS,
  RIBBON_WINDOW_MS,
  boundRibbon,
  initialFillerState,
  initialMicrophoneState,
  initialPaceState,
  initialVarietyState,
  type CoachRailInputs,
} from '../../../../src/shared/coaching/coach';
import type { CoachRibbonEvent } from '../../../../src/shared/contracts/coaching';
import type { Uuid } from '../../../../src/shared/contracts/core';
import { TAKE, candidate, context } from './fixtures';

const SESSION = '11111111-1111-4111-8111-111111111111' as Uuid;

function inputs(overrides: Partial<CoachRailInputs> = {}): CoachRailInputs {
  return {
    sessionId: SESSION,
    takePassId: TAKE,
    mode: 'coach',
    visible: true,
    mirrored: false,
    reducedMotion: false,
    pace: initialPaceState(115, 160),
    variety: initialVarietyState(45, 75),
    fillers: initialFillerState(),
    microphone: initialMicrophoneState(),
    activeTip: null,
    ribbonEvents: [],
    audioTimeMs: 30_000,
    ...overrides,
  };
}

function ribbonEvent(overrides: Partial<CoachRibbonEvent> = {}): CoachRibbonEvent {
  return {
    eventId: 'r-1',
    type: 'confirmed_filler',
    startMs: 25_000,
    endMs: 25_200,
    confidence: 0.9,
    takePassId: TAKE,
    ...overrides,
  };
}

describe('§27 snapshot identity', () => {
  it('increases stageRevision strictly on every build', () => {
    const builder = new CoachRailStateBuilder(SESSION);
    const revisions = [1, 2, 3, 4].map(() => builder.build(inputs()).stageRevision);
    expect(revisions).toEqual([1, 2, 3, 4]);
    expect(builder.lastRevision).toBe(4);
  });

  it('refuses to build a snapshot for a foreign session', () => {
    const builder = new CoachRailStateBuilder(SESSION);
    expect(() =>
      builder.build(inputs({ sessionId: '99999999-9999-4999-8999-999999999999' as Uuid })),
    ).toThrow(/foreign session/u);
  });

  it('carries the schema version and the take pass through', () => {
    const state = new CoachRailStateBuilder(SESSION).build(inputs());
    expect(state.schemaVersion).toBe(1);
    expect(state.takePassId).toBe(TAKE);
    expect(state.sessionId).toBe(SESSION);
  });
});

describe('§2.1 the rail cannot move the script', () => {
  it('exposes no positional, scroll, cursor, section or motion field', () => {
    const policy = new CoachTipPolicy();
    const tip = policy.propose(
      [{ candidate: candidate(), source: 'local' }],
      context({ audioTimeMs: 10_000 }),
    ).accepted;
    const state = new CoachRailStateBuilder(SESSION).build(inputs({ activeTip: tip }));

    expect(Object.keys(state).sort()).toEqual(
      [
        'activeTip',
        'fillers',
        'microphone',
        'mirrored',
        'mode',
        'pace',
        'reducedMotion',
        'ribbonEvents',
        'schemaVersion',
        'sessionId',
        'stageRevision',
        'takePassId',
        'variety',
        'visible',
      ].sort(),
    );

    const serialized = JSON.stringify(state);
    for (const forbidden of [
      'scrollTop',
      'scrollOffset',
      'cursorIndex',
      'unitIndex',
      'sectionId',
      'targetY',
      'velocity',
      'navigate',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('§9.1 at most one tip, and only from this take pass', () => {
  it('passes a current tip through', () => {
    const policy = new CoachTipPolicy();
    const tip = policy.propose(
      [{ candidate: candidate(), source: 'local' }],
      context({ audioTimeMs: 10_000 }),
    ).accepted;
    const state = new CoachRailStateBuilder(SESSION).build(inputs({ activeTip: tip }));
    expect(state.activeTip?.code).toBe('PACE_EASE_BACK');
  });

  it('drops a tip stamped with another take pass', () => {
    const policy = new CoachTipPolicy();
    const tip = policy.propose(
      [{ candidate: candidate(), source: 'local' }],
      context({ audioTimeMs: 10_000 }),
    ).accepted;
    expect(tip).not.toBeNull();
    const state = new CoachRailStateBuilder(SESSION).build(
      inputs({ activeTip: tip, takePassId: 'take-2' }),
    );
    expect(state.activeTip).toBeNull();
  });

  it('copies the interpolations rather than aliasing them', () => {
    const policy = new CoachTipPolicy();
    const tip = policy.propose(
      [
        {
          candidate: candidate({ type: 'repeated_filler', localConfidence: 0.9 }),
          source: 'local',
          filler: 'uh',
        },
      ],
      context({ audioTimeMs: 10_000 }),
    ).accepted;
    const state = new CoachRailStateBuilder(SESSION).build(inputs({ activeTip: tip }));
    expect(state.activeTip?.interpolations).toEqual({ filler: 'uh' });
    state.activeTip!.interpolations.filler = 'tampered';
    expect(tip?.interpolations.filler).toBe('uh');
  });
});

describe('§27.4 ribbon bounding is the producer’s job', () => {
  it('keeps the trailing 30 seconds and drops what falls out of it', () => {
    const now = 40_000;
    const cutoff = now - RIBBON_WINDOW_MS; // 10 000
    const events = [
      // Ends before the window opens: dropped.
      ribbonEvent({ eventId: 'old', startMs: 100, endMs: cutoff - 1 }),
      // Ends exactly on the boundary: kept.
      ribbonEvent({ eventId: 'edge', startMs: 0, endMs: cutoff }),
      ribbonEvent({ eventId: 'recent', startMs: 25_000, endMs: 25_400 }),
    ];
    const kept = boundRibbon(events, now, TAKE);
    expect(kept.map((event) => event.eventId)).toEqual(['edge', 'recent']);
  });

  it('drops events from another take pass', () => {
    const events = [
      ribbonEvent({ eventId: 'mine' }),
      ribbonEvent({ eventId: 'theirs', takePassId: 'take-2' }),
    ];
    expect(boundRibbon(events, 30_000, TAKE).map((event) => event.eventId)).toEqual(['mine']);
  });

  it('caps the count and keeps the newest', () => {
    const events = Array.from({ length: RIBBON_MAX_EVENTS + 40 }, (_, index) =>
      ribbonEvent({ eventId: `r-${index}`, startMs: 1_000 + index, endMs: 1_100 + index }),
    );
    const kept = boundRibbon(events, 2_000, TAKE, 60_000);
    expect(kept).toHaveLength(RIBBON_MAX_EVENTS);
    expect(kept[kept.length - 1]?.eventId).toBe(`r-${RIBBON_MAX_EVENTS + 39}`);
  });

  it('returns oldest first', () => {
    const events = [
      ribbonEvent({ eventId: 'b', startMs: 26_000, endMs: 26_100 }),
      ribbonEvent({ eventId: 'a', startMs: 25_000, endMs: 25_100 }),
    ];
    expect(boundRibbon(events, 30_000, TAKE).map((event) => event.eventId)).toEqual(['a', 'b']);
  });
});

describe('§27.1 the tiles start honest', () => {
  it('reports unknown as null, never as zero', () => {
    const pace = initialPaceState(115, 160);
    expect(pace.wpm).toBeNull();
    expect(pace.state).toBe('learning');
    expect(pace.targetLowWpm).toBe(115);
    const variety = initialVarietyState(45, 75);
    expect(variety.level).toBeNull();
    expect(variety.state).toBe('learning');
    expect(initialMicrophoneState().levelDbfs).toBeNull();
    // The filler count is genuinely zero at the start, which is a real claim.
    expect(initialFillerState().confirmedCount).toBe(0);
  });
});
