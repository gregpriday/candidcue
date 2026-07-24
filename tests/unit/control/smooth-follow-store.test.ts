import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { SemanticMotionFrame, StageMotionAck } from '../../../src/shared/contracts';
import type { MovementDecisionRecord } from '../../../src/control/lib/follow-language';
import { defaultFollowingSettings } from '../../../src/control/lib/follow-profiles';
import {
  createSmoothFollowStore,
  deriveNotices,
  paceFromFrame,
  type FollowActions,
  type SmoothFollowStore,
} from '../../../src/control/stores/smooth-follow';

/* ------------------------------------------------------------------ fixtures */

let clock = 1_000;
const now = () => clock;

function frame(patch: Partial<SemanticMotionFrame> = {}): SemanticMotionFrame {
  return {
    sessionId: 'session-1',
    sessionGeneration: 1,
    scriptCompileHash: 'hash-1',
    layoutGeneration: 3,
    revision: 1,
    epoch: 1,
    sessionTimeMs: 1_000,
    estimatedUnit: 120,
    committedUnit: 118,
    velocityUnitsPerSecond: 2.4,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0.1,
    confidence: 0.86,
    sectionId: 'section-1',
    tokenIndex: 120,
    sentenceId: 'sentence-4',
    blockId: 'block-2',
    state: 'following',
    behavior: 'normal',
    finalEvidence: true,
    motionProfileId: 'default-v1',
    ...patch,
  };
}

function ack(patch: Partial<StageMotionAck> = {}): StageMotionAck {
  return {
    sessionId: 'session-1',
    revision: 1,
    epoch: 1,
    layoutGeneration: 3,
    actualScrollPx: 980,
    actualVelocityPxPerSecond: 42,
    targetScrollPx: 1000,
    activeLineId: 'line-9',
    controllerState: 'tracking',
    droppedFrameCountWindow: 0,
    renderedAtMs: 1_000,
    ...patch,
  };
}

function movement(patch: Partial<MovementDecisionRecord> = {}): MovementDecisionRecord {
  return {
    revision: 4,
    sessionTimeMs: 4_000,
    fromUnit: 100,
    toUnit: 108,
    behavior: 'small_skip',
    stateBefore: 'following',
    stateAfter: 'catching_up',
    localConfidence: 0.72,
    secondBestMargin: 0.2,
    sectionGate: 'allowed',
    authority: 'ordinary',
    visualDisposition: 'catch_up',
    ...patch,
  };
}

function makeStore(
  options: { actions?: Partial<FollowActions>; timelineCapacity?: number; movementCapacity?: number } = {},
): SmoothFollowStore {
  clock = 1_000;
  const store = createSmoothFollowStore({ now, ...options });
  store.beginSession('session-1', defaultFollowingSettings());
  return store;
}

/* --------------------------------------------------------------------- tests */

describe('smooth follow store — session lifecycle', () => {
  it('starts inert and only reports frames once one has arrived', () => {
    const store = createSmoothFollowStore({ now });
    expect(get(store).receivingFrames).toBe(false);
    expect(get(store).confidence).toBeNull();
    expect(get(store).band).toBe('unknown');

    store.beginSession('session-1');
    expect(get(store).active).toBe(true);
    expect(get(store).receivingFrames).toBe(false);

    store.ingestMotionFrame(frame());
    expect(get(store).receivingFrames).toBe(true);
  });

  it('clears session state on reset and stops reporting frames on end', () => {
    const store = makeStore();
    store.ingestMotionFrame(frame());
    store.endSession();
    expect(get(store).active).toBe(false);
    expect(get(store).receivingFrames).toBe(false);

    store.reset();
    expect(get(store).sessionId).toBeNull();
    expect(get(store).timeline).toHaveLength(0);
    expect(get(store).movements).toHaveLength(0);
  });
});

describe('smooth follow store — motion frames (§52)', () => {
  it('maps state, behavior, confidence band, and position', () => {
    const store = makeStore();
    store.ingestMotionFrame(frame({ state: 'uncertain', behavior: 'paraphrase', confidence: 0.5 }));
    const state = get(store);
    expect(state.state).toBe('uncertain');
    expect(state.behavior).toBe('paraphrase');
    expect(state.band).toBe('unsure');
    expect(state.sectionId).toBe('section-1');
    expect(state.tokenIndex).toBe(120);
    expect(state.counts.frames).toBe(1);
  });

  it('ignores frames from another session', () => {
    const store = makeStore();
    store.ingestMotionFrame(frame({ sessionId: 'other', state: 'lost_local' }));
    expect(get(store).state).toBe('acquiring');
    expect(get(store).counts.frames).toBe(0);
  });

  it('ignores a stale revision from the same epoch', () => {
    const store = makeStore();
    store.ingestMotionFrame(frame({ revision: 10, state: 'following' }));
    store.ingestMotionFrame(frame({ revision: 4, state: 'lost_local' }));
    expect(get(store).state).toBe('following');
  });

  it('logs state transitions on the timeline in plain language', () => {
    const store = makeStore();
    store.ingestMotionFrame(frame({ revision: 1, state: 'following' }));
    store.ingestMotionFrame(frame({ revision: 2, state: 'uncertain' }));
    const transitions = get(store).timeline.filter(
      (e) => e.kind === 'state' && e.summary.includes('→'),
    );
    expect(transitions.map((e) => e.summary)).toEqual([
      'Looking for your place → Following',
      'Following → Unsure — slowing down',
    ]);
  });

  it('reports pace only while moving with usable confidence', () => {
    expect(paceFromFrame(frame({ state: 'following', velocityUnitsPerSecond: 2 }))).toBe(120);
    expect(paceFromFrame(frame({ state: 'uncertain' }))).toBeNull();
    expect(paceFromFrame(frame({ velocityUnitsPerSecond: 0 }))).toBeNull();
    expect(paceFromFrame(frame({ confidence: 0.2 }))).toBeNull();
  });

  it('drops stale candidate offers once following resumes', () => {
    const store = makeStore();
    store.setCandidates([
      { id: 'c1', label: 'The simplest way…', sectionTitle: 'Intro', tokenIndex: 40, score: 0.4 },
    ]);
    store.ingestMotionFrame(frame({ state: 'lost_local' }));
    expect(get(store).candidates).toHaveLength(1);
    store.ingestMotionFrame(frame({ revision: 2, state: 'following' }));
    expect(get(store).candidates).toHaveLength(0);
  });
});

describe('smooth follow store — degraded states (Part XI)', () => {
  it('enters and leaves the §59 transcription-interruption state', () => {
    const store = makeStore();
    store.reportTranscriptStatus('interrupted', 'WebRTC connection dropped');
    const notice = get(store).notices.find((n) => n.id === 'transcription_interrupted');
    expect(notice?.title).toBe('Reconnecting — position held');
    expect(notice?.detail).toContain('WebRTC connection dropped');

    store.reportTranscriptStatus('live');
    expect(get(store).notices.some((n) => n.id === 'transcription_interrupted')).toBe(false);
  });

  it('reports §60 low transcript confidence without calling it an error', () => {
    const store = makeStore();
    store.reportTranscriptStatus('low_confidence');
    const notice = get(store).notices.find((n) => n.id === 'low_transcript_confidence');
    expect(notice?.tone).toBe('info');
    expect(notice?.detail).toContain('holding back tips');
  });

  it('enters §61 frame degradation from stage acks and recovers', () => {
    const store = makeStore({});
    store.ingestStageAck(ack({ droppedFrameCountWindow: 0 }));
    expect(get(store).motion.degraded).toBe(false);

    store.ingestStageAck(ack({ droppedFrameCountWindow: 5 }));
    expect(get(store).motion.degraded).toBe(true);
    expect(get(store).notices.some((n) => n.id === 'frame_performance')).toBe(true);
    expect(get(store).motion.trackingErrorPx).toBe(20);

    store.ingestStageAck(ack({ droppedFrameCountWindow: 0 }));
    expect(get(store).notices.some((n) => n.id === 'frame_performance')).toBe(false);
    const recovered = get(store).timeline.find((e) => e.summary.includes('recovered'));
    expect(recovered).toBeDefined();
  });

  it('treats a degraded controller state as degradation even with no dropped frames', () => {
    const store = makeStore();
    store.ingestStageAck(ack({ controllerState: 'tracking_degraded' }));
    expect(get(store).motion.degraded).toBe(true);
  });

  it('offers a concrete recovery action for §62 invalid line maps', () => {
    const store = makeStore();
    store.reportLineMapInvalid('token coverage is not monotonic');
    const notice = get(store).notices[0];
    expect(notice?.id).toBe('invalid_line_map');
    expect(notice?.tone).toBe('danger');
    expect(notice?.action?.id).toBe('rebuild_layout');

    store.reportLineMapRebuilt(4);
    expect(get(store).notices.some((n) => n.id === 'invalid_line_map')).toBe(false);
    expect(get(store).layoutGeneration).toBe(4);
  });

  it('shows §58 Luna outages with the reason and never blames tracking', () => {
    const store = makeStore();
    store.ingestAssistStatus({ state: 'unavailable', reason: 'quota' });
    const notice = get(store).notices.find((n) => n.id === 'luna_unavailable');
    expect(notice?.title).toContain('quota');
    expect(notice?.detail).toContain('local tracking are unaffected');

    store.ingestAssistStatus({ state: 'ready', reason: null });
    expect(get(store).notices.some((n) => n.id === 'luna_unavailable')).toBe(false);
  });

  it('surfaces and clears §63 runtime budget breaches', () => {
    const store = makeStore();
    store.reportBudgetBreach({ id: 'stage_frame', observed: 2.6, budget: 1, unit: ' ms' });
    expect(get(store).notices.some((n) => n.id === 'budget_exceeded')).toBe(true);

    // A second report for the same budget replaces rather than accumulates.
    store.reportBudgetBreach({ id: 'stage_frame', observed: 3.1, budget: 1, unit: ' ms' });
    expect(get(store).budgets).toHaveLength(1);

    store.clearBudget('stage_frame');
    expect(get(store).notices.some((n) => n.id === 'budget_exceeded')).toBe(false);
  });

  it('orders notices with the most serious condition first', () => {
    const store = makeStore();
    store.reportBudgetBreach({ id: 'alignment_update', observed: 9, budget: 4, unit: ' ms' });
    store.ingestAssistStatus({ state: 'unavailable', reason: 'timeout' });
    store.reportTranscriptStatus('interrupted');
    store.reportLineMapInvalid('measurement failed');
    expect(get(store).notices.map((n) => n.id)).toEqual([
      'invalid_line_map',
      'transcription_interrupted',
      'luna_unavailable',
      'budget_exceeded',
    ]);
  });

  it('derives notices purely from state', () => {
    const store = makeStore();
    store.reportTranscriptStatus('interrupted');
    expect(deriveNotices(get(store))).toEqual(get(store).notices);
  });
});

describe('smooth follow store — movement records and ring buffers (§64, §65)', () => {
  it('keeps the latest transition reason and counts re-anchors', () => {
    const store = makeStore();
    store.ingestMovementRecord(movement());
    store.ingestMovementRecord(movement({ revision: 5, visualDisposition: 'reanchor' }));
    const state = get(store);
    expect(state.counts.movements).toBe(2);
    expect(state.counts.reanchors).toBe(1);
    expect(state.lastTransitionReason).toContain('re-anchored');
    expect(state.lastMovement?.revision).toBe(5);
  });

  it('bounds the movement ring buffer and keeps the newest records', () => {
    const store = makeStore({ movementCapacity: 3 });
    for (let i = 0; i < 10; i += 1) store.ingestMovementRecord(movement({ revision: i }));
    const movements = get(store).movements;
    expect(movements).toHaveLength(3);
    expect(movements.map((m) => m.revision)).toEqual([7, 8, 9]);
  });

  it('bounds the diagnostics timeline', () => {
    const store = makeStore({ timelineCapacity: 5 });
    for (let i = 0; i < 40; i += 1) store.ingestMovementRecord(movement({ revision: i }));
    const timeline = get(store).timeline;
    expect(timeline).toHaveLength(5);
    // Sequence numbers are monotonic, so the newest entries are retained.
    expect(timeline[timeline.length - 1]!.seq).toBeGreaterThan(timeline[0]!.seq);
  });

  it('stamps timeline entries with session-relative time', () => {
    const store = makeStore();
    clock = 4_500;
    store.ingestMovementRecord(movement());
    const entry = get(store).timeline.at(-1);
    expect(entry?.sessionTimeMs).toBe(3_500);
  });
});

describe('smooth follow store — user actions (§48)', () => {
  function spies(): Partial<FollowActions> {
    return {
      nudge: vi.fn(),
      reAnchor: vi.fn(),
      acceptCandidate: vi.fn(),
      setFollowingPaused: vi.fn(),
      setIntelligenceMode: vi.fn(),
      setCoachingDisplay: vi.fn(),
      rebuildStageLayout: vi.fn(),
    };
  }

  it('delegates nudges in whole sentences and logs them', () => {
    const actions = spies();
    const store = makeStore({ actions });
    store.nudge('back');
    store.nudge('forward');
    expect(actions.nudge).toHaveBeenNthCalledWith(1, -1);
    expect(actions.nudge).toHaveBeenNthCalledWith(2, 1);
    expect(get(store).timeline.filter((e) => e.kind === 'action')).toHaveLength(2);
  });

  it('re-anchors on request', () => {
    const actions = spies();
    const store = makeStore({ actions });
    store.reAnchorHere();
    expect(actions.reAnchor).toHaveBeenCalledOnce();
  });

  it('pauses following without touching the session', () => {
    const actions = spies();
    const store = makeStore({ actions });
    store.toggleFollowingPaused();
    expect(get(store).followingPaused).toBe(true);
    expect(actions.setFollowingPaused).toHaveBeenCalledWith(true);
    store.toggleFollowingPaused();
    expect(get(store).followingPaused).toBe(false);
  });

  it('accepts a local candidate and clears the offer', () => {
    const actions = spies();
    const store = makeStore({ actions });
    const candidate = {
      id: 'c1',
      label: 'the simplest way to organize',
      sectionTitle: 'Intro',
      tokenIndex: 88,
      score: 0.5,
    };
    store.setCandidates([candidate]);
    store.acceptCandidate('c1');
    expect(actions.acceptCandidate).toHaveBeenCalledWith(candidate);
    expect(get(store).candidates).toHaveLength(0);

    store.acceptCandidate('missing');
    expect(actions.acceptCandidate).toHaveBeenCalledOnce();
  });

  it('quick-switches the intelligence mode and resets assist state', () => {
    const actions = spies();
    const store = makeStore({ actions });
    store.ingestAssistStatus({ state: 'unavailable', reason: 'timeout', requestCount: 7 });
    store.chooseIntelligenceMode('local_only');
    expect(actions.setIntelligenceMode).toHaveBeenCalledWith('local_only');
    const assist = get(store).assist;
    expect(assist.configuredMode).toBe('local_only');
    expect(assist.state).toBe('off');
    expect(assist.reason).toBeNull();
    // Usage counters survive a mode change — they describe the session.
    expect(assist.requestCount).toBe(7);
    expect(get(store).notices.some((n) => n.id === 'luna_unavailable')).toBe(false);
  });

  it('toggles coaching while preserving the stage preference', () => {
    const actions = spies();
    const store = makeStore({ actions });
    store.setCoachingDisplay('stage_and_control');
    store.setCoachingEnabled(false);
    expect(get(store).coaching.display).toBe('off');
    expect(get(store).coaching.enabled).toBe(false);
    store.setCoachingEnabled(true);
    expect(get(store).coaching.display).toBe('control');
  });

  it('drops coach tips while coaching is off', () => {
    const store = makeStore();
    store.setCoachingDisplay('off');
    store.ingestCoachTip({
      id: 't1',
      code: 'pace_fast',
      text: 'You are moving quickly.',
      priority: 5,
      receivedAtMs: 1,
      stageEligible: false,
    });
    expect(get(store).coaching.lastTip).toBeNull();
  });

  it('requests a stage layout rebuild for §62 recovery', () => {
    const actions = spies();
    const store = makeStore({ actions });
    store.requestLayoutRebuild();
    expect(actions.rebuildStageLayout).toHaveBeenCalledOnce();
  });

  it('applies changed follow settings to the live view', () => {
    const store = makeStore();
    store.applyFollowingSettings({
      ...defaultFollowingSettings(),
      intelligenceMode: 'enhanced',
      coachingDisplay: 'off',
    });
    expect(get(store).assist.configuredMode).toBe('enhanced');
    expect(get(store).coaching.enabled).toBe(false);
  });
});

describe('smooth follow store — diagnostics export (§57.3, §64)', () => {
  it('exports a redacted, bounded support payload', () => {
    const store = makeStore();
    store.ingestMotionFrame(frame());
    store.ingestMovementRecord(movement());
    store.ingestCoachTip({
      id: 't1',
      code: 'critical_number',
      text: 'The script says 40 percent.',
      priority: 2,
      receivedAtMs: 2,
      stageEligible: true,
    });

    const exported = store.exportDiagnostics();
    expect(exported.redacted).toBe(true);
    expect(exported.sessionId).toBe('session-1');
    expect(exported.confidenceBand).toBe('strong');
    expect(exported.movements).toHaveLength(1);
    const serialized = JSON.stringify(exported);
    // Tip text is derived from script content, so it must not travel.
    expect(serialized).not.toContain('40 percent');
    expect(exported.timeline.every((entry) => !('detail' in entry))).toBe(true);
  });
});
