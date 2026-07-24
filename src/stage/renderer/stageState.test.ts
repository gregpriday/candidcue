import { describe, it, expect } from 'vitest';
import {
  initialStageState,
  stageReducer,
  displayPhase,
  type StageAppState,
} from './stageState';
import type {
  CoachRailState,
  StageSessionEnvelope,
  TrackingSnapshot,
} from '../../shared/contracts';
import {
  initialPaceState,
  initialVarietyState,
  initialFillerState,
  initialMicrophoneState,
} from '../../shared/coaching/coach/coach-state';

function makeCoachRail(
  stageRevision: number,
  overrides: Partial<CoachRailState> = {},
): CoachRailState {
  return {
    schemaVersion: 1,
    stageRevision,
    sessionId: '00000000-0000-0000-0000-000000000001',
    takePassId: 'take-1',
    mode: 'coach',
    modules: {
      paceNumber: true,
      paceStatus: true,
      paceSparkline: false,
      targetDurationStatus: false,
      varietyScore: true,
      varietyLabel: true,
      fillerCount: true,
      fillerRibbon: true,
      gutterMarks: false,
      liveTips: true,
      deliveryScore: false,
    },
    audioTimeMs: 1000,
    visible: true,
    mirrored: false,
    reducedMotion: false,
    pace: initialPaceState(130, 170),
    variety: initialVarietyState(0.4, 0.7),
    fillers: initialFillerState(),
    microphone: initialMicrophoneState(),
    activeTip: null,
    ribbonEvents: [],
    gutterMarks: [],
    score: null,
    ...overrides,
  };
}

function makeEnvelope(stageGeneration = 1, sessionGeneration = 1): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-000000000001',
    sessionGeneration,
    stageGeneration,
    scriptId: '00000000-0000-0000-0000-000000000002',
    sourceHash: 'hash',
    compileRevision: 1,
    stageSettings: {
      schemaVersion: 1,
      themeId: 'stage-dark',
      background: '#000000',
      foreground: '#f5f3ef',
      fontFamilyId: 'system-sans',
      fontSizePx: 64,
      lineHeight: 1.28,
      letterSpacingEm: 0,
      columnWidthPercent: 68,
      readingBandCenterPercent: 38,
      readingBandHalfHeightPercent: 4,
      pastOpacity: 0.42,
      futureOpacity: 0.92,
      currentUnderlayOpacity: 0.1,
      mirrorX: false,
      mirrorY: false,
      showCues: true,
      stageAcknowledgements: true,
      reducedMotion: false,
    },
    renderDocument: {
      schemaVersion: 1,
      title: 'Test',
      blocks: [],
      tokenToNode: [],
      assets: {},
    },
    initialTokenIndex: 0,
  };
}

function makeTracking(
  revision: number,
  overrides: Partial<TrackingSnapshot> = {},
): TrackingSnapshot {
  return {
    schemaVersion: 1,
    revision,
    sessionId: '00000000-0000-0000-0000-000000000001',
    sessionGeneration: 1,
    stageGeneration: 1,
    scriptId: '00000000-0000-0000-0000-000000000002',
    tokenIndex: 10,
    committedTokenIndex: 8,
    blockId: 'b1',
    sentenceId: 's1',
    confidence: 0.9,
    state: 'following',
    provisional: false,
    movement: 'advance',
    sourceItemIds: [],
    generatedAtMs: 0,
    ...overrides,
  };
}

function hydrated(): StageAppState {
  let s = initialStageState();
  s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope() });
  s = stageReducer(s, { type: 'layout_ready' });
  return s;
}

describe('stage state machine (spec §45.6, §43.5)', () => {
  it('walks handshake → ready → live', () => {
    let s = initialStageState();
    expect(displayPhase(s)).toBe('handshake');
    s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope() });
    expect(displayPhase(s)).toBe('handshake');
    s = stageReducer(s, { type: 'layout_ready' });
    expect(displayPhase(s)).toBe('ready');
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(1) });
    expect(displayPhase(s)).toBe('live');
  });

  it('ignores layout_ready before any snapshot arrives', () => {
    const s = stageReducer(initialStageState(), { type: 'layout_ready' });
    expect(s.phase).toBe('handshake');
  });

  it('ignores tracking before layout is ready', () => {
    let s = initialStageState();
    s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope() });
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(1) });
    expect(s.tracking).toBeNull();
  });

  it('rejects stale snapshots from a previous stage generation', () => {
    let s = initialStageState();
    s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope(3) });
    const stale = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope(2) });
    expect(stale.envelope?.stageGeneration).toBe(3);
  });

  it('restarts the handshake on a new stage generation', () => {
    let s = hydrated();
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(5) });
    s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope(2) });
    expect(s.phase).toBe('handshake');
    expect(s.tracking).toBeNull();
    expect(s.lastTrackingRevision).toBeNull();
  });

  it('enforces tracking revision monotonicity', () => {
    let s = hydrated();
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(5) });
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(4, { tokenIndex: 99 }) });
    expect(s.tracking?.tokenIndex).toBe(10);
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(6, { tokenIndex: 12 }) });
    expect(s.tracking?.tokenIndex).toBe(12);
  });

  it('drops tracking from a mismatched stage or session generation', () => {
    let s = hydrated();
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(1, { stageGeneration: 9 }) });
    expect(s.tracking).toBeNull();
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(1, { sessionGeneration: 9 }) });
    expect(s.tracking).toBeNull();
  });

  it('applies freeze and blank directives; blank wins in displayPhase', () => {
    let s = hydrated();
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(1) });
    s = stageReducer(s, {
      type: 'directive',
      stageGeneration: 1,
      directive: { kind: 'freeze', frozen: true },
    });
    expect(displayPhase(s)).toBe('frozen');
    s = stageReducer(s, {
      type: 'directive',
      stageGeneration: 1,
      directive: { kind: 'blank', blanked: true, keepListener: true },
    });
    expect(displayPhase(s)).toBe('blank');
    expect(s.keepListenerWhenBlanked).toBe(true);
    s = stageReducer(s, {
      type: 'directive',
      stageGeneration: 1,
      directive: { kind: 'blank', blanked: false },
    });
    expect(displayPhase(s)).toBe('frozen');
    s = stageReducer(s, {
      type: 'directive',
      stageGeneration: 1,
      directive: { kind: 'freeze', frozen: false },
    });
    expect(displayPhase(s)).toBe('live');
  });

  it('ignores directives from another stage generation', () => {
    let s = hydrated();
    s = stageReducer(s, {
      type: 'directive',
      stageGeneration: 7,
      directive: { kind: 'blank', blanked: true },
    });
    expect(s.blanked).toBe(false);
  });

  it('re-triggers identical acks via the sequence counter', () => {
    let s = hydrated();
    const ackDirective = {
      type: 'directive',
      stageGeneration: 1,
      directive: { kind: 'ack', label: 'Chapter 1' },
    } as const;
    s = stageReducer(s, ackDirective);
    const firstSeq = s.ack?.seq;
    s = stageReducer(s, ackDirective);
    expect(s.ack?.seq).toBe((firstSeq ?? 0) + 1);
    expect(s.ack?.durationMs).toBe(900);
  });

  it('freezes on control loss and recovers on the next heartbeat', () => {
    let s = hydrated();
    s = stageReducer(s, { type: 'tracking', snapshot: makeTracking(1) });
    s = stageReducer(s, { type: 'control_lost' });
    expect(displayPhase(s)).toBe('frozen');
    expect(s.frozenReason).toBe('control_lost');
    s = stageReducer(s, {
      type: 'heartbeat',
      payload: { stageGeneration: 1, revision: 2, sentAtMs: 0 },
      receivedAtMs: 100,
    });
    expect(displayPhase(s)).toBe('live');
  });

  it('does not let a heartbeat lift a directive-ordered freeze', () => {
    let s = hydrated();
    s = stageReducer(s, {
      type: 'directive',
      stageGeneration: 1,
      directive: { kind: 'freeze', frozen: true },
    });
    s = stageReducer(s, {
      type: 'heartbeat',
      payload: { stageGeneration: 1, revision: 1, sentAtMs: 0 },
      receivedAtMs: 100,
    });
    expect(s.frozen).toBe(true);
  });

  describe('coaching rail (§27) — validate on arrival', () => {
    it('accepts the first snapshot and latches the reserved band', () => {
      let s = hydrated();
      expect(s.coachRail).toBeNull();
      expect(s.coachRailReserved).toBe(false);
      s = stageReducer(s, { type: 'coach_rail', snapshot: makeCoachRail(1) });
      expect(s.coachRail?.stageRevision).toBe(1);
      expect(s.lastCoachRailRevision).toBe(1);
      // §7.1: the band is reserved for the rest of the take.
      expect(s.coachRailReserved).toBe(true);
    });

    it('applies a newer revision and rejects a stale (lower/equal) one', () => {
      let s = hydrated();
      s = stageReducer(s, { type: 'coach_rail', snapshot: makeCoachRail(5) });
      // A lower revision is stale, not a correction (out-of-order delivery).
      s = stageReducer(s, {
        type: 'coach_rail',
        snapshot: makeCoachRail(3, { audioTimeMs: 9999 }),
      });
      expect(s.coachRail?.stageRevision).toBe(5);
      expect(s.coachRail?.audioTimeMs).toBe(1000);
      // Equal revision is also stale.
      s = stageReducer(s, {
        type: 'coach_rail',
        snapshot: makeCoachRail(5, { audioTimeMs: 8888 }),
      });
      expect(s.coachRail?.audioTimeMs).toBe(1000);
      // A strictly greater revision is applied.
      s = stageReducer(s, {
        type: 'coach_rail',
        snapshot: makeCoachRail(6, { audioTimeMs: 7777 }),
      });
      expect(s.coachRail?.stageRevision).toBe(6);
      expect(s.coachRail?.audioTimeMs).toBe(7777);
    });

    it('rejects a snapshot for a different session', () => {
      let s = hydrated();
      s = stageReducer(s, {
        type: 'coach_rail',
        snapshot: makeCoachRail(1, { sessionId: '00000000-0000-0000-0000-0000000000ff' }),
      });
      expect(s.coachRail).toBeNull();
      expect(s.coachRailReserved).toBe(false);
    });

    it('ignores a snapshot before any envelope exists', () => {
      const s0 = initialStageState();
      const s1 = stageReducer(s0, { type: 'coach_rail', snapshot: makeCoachRail(1) });
      expect(s1).toBe(s0);
    });

    it('keeps the reserved band and revision through a same-generation re-send', () => {
      let s = hydrated();
      s = stageReducer(s, { type: 'coach_rail', snapshot: makeCoachRail(4) });
      // Same stageGeneration re-send of the document refreshes in place.
      s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope(1, 1) });
      expect(s.coachRailReserved).toBe(true);
      expect(s.lastCoachRailRevision).toBe(4);
    });

    it('clears the rail, its watermark, and the band latch on a new generation', () => {
      let s = hydrated();
      s = stageReducer(s, { type: 'coach_rail', snapshot: makeCoachRail(4) });
      // A new stage generation is a new lifetime.
      s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope(2, 1) });
      expect(s.coachRail).toBeNull();
      expect(s.lastCoachRailRevision).toBeNull();
      expect(s.coachRailReserved).toBe(false);
    });
  });

  it('updates settings and listener via directives', () => {
    let s = hydrated();
    const settings = { ...makeEnvelope().stageSettings, mirrorX: true };
    s = stageReducer(s, {
      type: 'directive',
      stageGeneration: 1,
      directive: { kind: 'settings', settings },
    });
    expect(s.settings?.mirrorX).toBe(true);
    s = stageReducer(s, {
      type: 'directive',
      stageGeneration: 1,
      directive: { kind: 'listener', listener: null },
    });
    expect(s.listener).toBeNull();
  });
});
