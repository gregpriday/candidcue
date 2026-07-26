import { describe, it, expect } from 'vitest';
import {
  initialStageState,
  stageReducer,
  displayPhase,
  type StageAppState,
} from './stageState';
import type {
  StageSessionEnvelope,
  AlignmentSnapshot,
} from '../../shared/contracts';


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
  seq: number,
  overrides: Partial<AlignmentSnapshot> = {},
): AlignmentSnapshot {
  return {
    sessionGeneration: 1,
    seq,
    state: 'following',
    decision: 'localConfirmed',
    confirmedToken: 8,
    observedToken: 10,
    rateTokensPerSecond: 2.5,
    evidenceAudioMs: 0,
    atAudioMs: 0,
    maxPredictionMs: 900,
    confidence: 0.9,
    suggestionToken: null,
    scriptLenTokens: 100,
    observedAtom: 10,
    confirmedAtom: 8,
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
    s = stageReducer(s, { type: 'alignment', snapshot: makeTracking(1) });
    expect(displayPhase(s)).toBe('live');
  });

  it('ignores layout_ready before any snapshot arrives', () => {
    const s = stageReducer(initialStageState(), { type: 'layout_ready' });
    expect(s.phase).toBe('handshake');
  });

  it('ignores tracking before layout is ready', () => {
    let s = initialStageState();
    s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope() });
    s = stageReducer(s, { type: 'alignment', snapshot: makeTracking(1) });
    expect(s.alignment).toBeNull();
  });

  it('rejects stale snapshots from a previous stage generation', () => {
    let s = initialStageState();
    s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope(3) });
    const stale = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope(2) });
    expect(stale.envelope?.stageGeneration).toBe(3);
  });

  it('restarts the handshake on a new stage generation', () => {
    let s = hydrated();
    s = stageReducer(s, { type: 'alignment', snapshot: makeTracking(5) });
    s = stageReducer(s, { type: 'snapshot', envelope: makeEnvelope(2) });
    expect(s.phase).toBe('handshake');
    expect(s.alignment).toBeNull();
    expect(s.lastTrackingRevision).toBeNull();
  });

  it('enforces snapshot sequence monotonicity', () => {
    let s = hydrated();
    s = stageReducer(s, { type: 'alignment', snapshot: makeTracking(5) });
    s = stageReducer(s, { type: 'alignment', snapshot: makeTracking(4, { observedToken: 99 }) });
    expect(s.alignment?.observedToken).toBe(10);
    s = stageReducer(s, { type: 'alignment', snapshot: makeTracking(6, { observedToken: 12 }) });
    expect(s.alignment?.observedToken).toBe(12);
  });

  it('applies freeze and blank directives; blank wins in displayPhase', () => {
    let s = hydrated();
    s = stageReducer(s, { type: 'alignment', snapshot: makeTracking(1) });
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
    s = stageReducer(s, { type: 'alignment', snapshot: makeTracking(1) });
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
