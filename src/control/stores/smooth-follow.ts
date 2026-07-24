/**
 * SmoothFollowStore (companion §50.1) — the user-visible following state and
 * the controls that act on it.
 *
 * This store is the control window's single source of truth for "what is the
 * tracker doing, how sure is it, and what has quietly degraded". It is fed by
 * four producers and owns none of them:
 *
 *   tracking worker (Agent A)  ──SemanticMotionFrame──▶ ingestMotionFrame
 *   tracking worker (Agent A)  ──MovementDecisionRecord─▶ ingestMovementRecord
 *   stage frame loop (Agent B) ──StageMotionAck────────▶ ingestStageAck
 *   semantic sidecar (Agent C) ──assist status/tips────▶ ingestAssistStatus
 *
 * Everything is pure and injectable: `createSmoothFollowStore({ now, … })`
 * takes its clock and its side-effecting actions from the caller, so the whole
 * state machine is testable in node with no Svelte lifecycle, no timers, and
 * no Tauri runtime.
 *
 * Honesty rules (companion §3, §49):
 *  - confidence is banded, never shown as a percentage;
 *  - a degraded condition always produces visible, specific copy;
 *  - nothing here claims the engine knows where the presenter is when the
 *    frames say otherwise.
 */
import { derived, get, writable, type Readable } from 'svelte/store';
import type {
  IntelligenceMode,
  SemanticMotionFrame,
  StageMotionAck,
  TrackingBehavior,
  TrackingStateV2,
} from '../../shared/contracts';
import {
  budgetNoticeCopy,
  confidenceBand,
  describeMovement,
  FOLLOW_NOTICE_COPY,
  FOLLOW_STATE_LABELS,
  lunaUnavailableCopy,
  type ConfidenceBand,
  type FollowNoticeId,
  type FollowNoticeTone,
  type LunaOutageReason,
  type MovementDecisionRecord,
  type RuntimeBudgetId,
} from '../lib/follow-language';
import {
  coachingEnabled as coachingIsEnabled,
  defaultFollowingSettings,
  type CoachingDisplay,
  type FollowingSettings,
} from '../lib/follow-profiles';

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------- */

/** How the semantic sidecar is doing right now (§42.1 visibility, §58). */
export interface AssistStatus {
  /** What the user chose (§47.4). */
  configuredMode: IntelligenceMode;
  /** What is actually happening — may be downgraded by §58/§42.4. */
  effectiveMode: IntelligenceMode;
  state: 'off' | 'ready' | 'waiting' | 'backing_off' | 'unavailable' | 'limit_reached';
  /** Why assist stopped, when it has (§58). */
  reason: LunaOutageReason | null;
  /** Requests issued this session — an observed count, never a cap. */
  requestCount: number;
  /** Tokens reported by the API, where the response includes usage (§42.1). */
  tokensIn: number;
  tokensOut: number;
  /** When a backoff expects to retry, if the scheduler told us. */
  retryAtMs: number | null;
}

/** A coach tip surfaced in the control window (§43, §46). */
export interface CoachTipView {
  id: string;
  code: string;
  text: string;
  priority: number;
  receivedAtMs: number;
  /** Stage-eligible tips are also allowed on the stage strip (§46). */
  stageEligible: boolean;
}

/** A local candidate the user may accept when the tracker is lost (§48). */
export interface FollowCandidate {
  id: string;
  label: string;
  sectionTitle: string | null;
  tokenIndex: number;
  score: number;
}

/** One exceeded runtime budget (§63). */
export interface BudgetBreach {
  id: RuntimeBudgetId;
  observed: number;
  budget: number;
  unit: string;
  atMs: number;
}

/** A user-visible degraded-state notice (Part XI). */
export interface FollowNotice {
  id: FollowNoticeId;
  tone: FollowNoticeTone;
  title: string;
  detail: string;
  /** Present when the user can do something concrete about it. */
  action?: { id: 'rebuild_layout' | 'open_assist_settings'; label: string };
}

export type TranscriptFeedStatus = 'idle' | 'live' | 'interrupted' | 'low_confidence';

/** Kinds of entry in the §64 diagnostics timeline. */
export type FollowTimelineKind =
  | 'state'
  | 'movement'
  | 'motion'
  | 'assist'
  | 'coach'
  | 'budget'
  | 'notice'
  | 'action';

export interface FollowTimelineEntry {
  /** Monotonic within a session; also the svelte keyed-each key. */
  seq: number;
  atMs: number;
  /** Session-relative time when a frame has given us one. */
  sessionTimeMs: number | null;
  kind: FollowTimelineKind;
  summary: string;
  detail?: string;
  /** Present on `movement` entries — the §65 record verbatim. */
  record?: MovementDecisionRecord;
}

export interface SmoothFollowState {
  sessionId: string | null;
  active: boolean;
  /** True once a motion frame has arrived — the UI must not fake liveness. */
  receivingFrames: boolean;
  lastFrameAtMs: number | null;

  state: TrackingStateV2;
  behavior: TrackingBehavior;
  confidence: number | null;
  band: ConfidenceBand;
  paceWordsPerMinute: number | null;

  sectionId: string;
  blockId: string;
  sentenceId: string;
  tokenIndex: number;
  estimatedUnit: number;
  committedUnit: number;
  revision: number;
  epoch: number;
  layoutGeneration: number;
  motionProfileId: string;

  /** §48 — following can be paused without pausing the session. */
  followingPaused: boolean;

  assist: AssistStatus;
  coaching: { display: CoachingDisplay; enabled: boolean; lastTip: CoachTipView | null };
  motion: {
    controllerState: string;
    droppedFrameCountWindow: number;
    /** target − actual at the last ack; a diagnostics figure, not a promise. */
    trackingErrorPx: number | null;
    degraded: boolean;
    lastAckAtMs: number | null;
  };
  transcript: { status: TranscriptFeedStatus; detail: string | null };
  lineMap: { valid: boolean; generation: number; detail: string | null };
  budgets: BudgetBreach[];
  candidates: FollowCandidate[];

  lastMovement: MovementDecisionRecord | null;
  lastTransitionReason: string | null;
  movements: MovementDecisionRecord[];
  timeline: FollowTimelineEntry[];

  notices: FollowNotice[];
  counts: { frames: number; movements: number; reanchors: number; acks: number };
}

export interface SmoothFollowStoreOptions {
  now?: () => number;
  /** §64 ring buffer bound. Bounded by construction — never grows. */
  timelineCapacity?: number;
  /** §65 ring buffer bound. */
  movementCapacity?: number;
  /**
   * Dropped frames within one ack window before §61 is reported. A display
   * threshold only — the stage owns the real degradation policy.
   */
  frameDropThreshold?: number;
  actions?: Partial<FollowActions>;
}

/**
 * Side effects the store delegates rather than performs. The session store
 * supplies the real implementations via `configureFollowActions`, which keeps
 * this module free of imports from the session/voice layers (and free of
 * cycles).
 */
export interface FollowActions {
  /** Manual nudge in whole sentences; negative moves back (§48). */
  nudge(deltaSentences: number): void;
  /** "Re-find me here" — re-anchor around the current position (§48). */
  reAnchor(): void;
  /** Accept one of the offered local candidates when lost (§48). */
  acceptCandidate(candidate: FollowCandidate): void;
  /** Pause/resume automatic following without touching the session (§48). */
  setFollowingPaused(paused: boolean): void;
  /** Persist an assist-mode quick switch (§47.4). */
  setIntelligenceMode(mode: IntelligenceMode): void;
  /** Persist a coaching display change (§47.6). */
  setCoachingDisplay(display: CoachingDisplay): void;
  /** Ask the stage to rebuild its line map after §62. */
  rebuildStageLayout(): void;
}

const NO_ACTIONS: FollowActions = {
  nudge: () => {},
  reAnchor: () => {},
  acceptCandidate: () => {},
  setFollowingPaused: () => {},
  setIntelligenceMode: () => {},
  setCoachingDisplay: () => {},
  rebuildStageLayout: () => {},
};

function initialAssist(mode: IntelligenceMode): AssistStatus {
  return {
    configuredMode: mode,
    effectiveMode: mode,
    state: mode === 'local_only' ? 'off' : 'ready',
    reason: null,
    requestCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    retryAtMs: null,
  };
}

function initialState(following: FollowingSettings): SmoothFollowState {
  return {
    sessionId: null,
    active: false,
    receivingFrames: false,
    lastFrameAtMs: null,
    state: 'acquiring',
    behavior: 'acquire',
    confidence: null,
    band: 'unknown',
    paceWordsPerMinute: null,
    sectionId: '',
    blockId: '',
    sentenceId: '',
    tokenIndex: 0,
    estimatedUnit: 0,
    committedUnit: 0,
    revision: 0,
    epoch: 0,
    layoutGeneration: 0,
    motionProfileId: following.motionProfileId,
    followingPaused: false,
    assist: initialAssist(following.intelligenceMode),
    coaching: {
      display: following.coachingDisplay,
      enabled: coachingIsEnabled(following.coachingDisplay),
      lastTip: null,
    },
    motion: {
      controllerState: 'idle',
      droppedFrameCountWindow: 0,
      trackingErrorPx: null,
      degraded: false,
      lastAckAtMs: null,
    },
    transcript: { status: 'idle', detail: null },
    lineMap: { valid: true, generation: 0, detail: null },
    budgets: [],
    candidates: [],
    lastMovement: null,
    lastTransitionReason: null,
    movements: [],
    timeline: [],
    notices: [],
    counts: { frames: 0, movements: 0, reanchors: 0, acks: 0 },
  };
}

/* ---------------------------------------------------------------------------
 * Pure derivations (exported for tests)
 * ------------------------------------------------------------------------- */

/**
 * The Part XI degraded-state matrix, most serious first. Every condition the
 * engine can be in has exactly one honest notice; nothing is silent.
 */
export function deriveNotices(state: SmoothFollowState): FollowNotice[] {
  const notices: FollowNotice[] = [];

  // §62 invalid line map — motion is held, so this outranks everything else.
  if (!state.lineMap.valid) {
    const copy = FOLLOW_NOTICE_COPY.invalid_line_map;
    notices.push({
      id: 'invalid_line_map',
      tone: copy.tone,
      title: copy.title,
      detail: state.lineMap.detail ? `${copy.detail} (${state.lineMap.detail})` : copy.detail,
      action: { id: 'rebuild_layout', label: 'Rebuild stage layout' },
    });
  }

  // §59 transcription interruption.
  if (state.transcript.status === 'interrupted') {
    const copy = FOLLOW_NOTICE_COPY.transcription_interrupted;
    notices.push({
      id: 'transcription_interrupted',
      tone: copy.tone,
      title: copy.title,
      detail: state.transcript.detail ? `${copy.detail} (${state.transcript.detail})` : copy.detail,
    });
  }

  // §61 frame-performance degradation.
  if (state.motion.degraded) {
    const copy = FOLLOW_NOTICE_COPY.frame_performance;
    notices.push({
      id: 'frame_performance',
      tone: copy.tone,
      title: copy.title,
      detail: `${copy.detail} Dropped frames in the last stage report: ${state.motion.droppedFrameCountWindow}.`,
    });
  }

  // §60 low transcript confidence.
  if (state.transcript.status === 'low_confidence') {
    const copy = FOLLOW_NOTICE_COPY.low_transcript_confidence;
    notices.push({
      id: 'low_transcript_confidence',
      tone: copy.tone,
      title: copy.title,
      detail: state.transcript.detail ? `${copy.detail} (${state.transcript.detail})` : copy.detail,
    });
  }

  // §58 / §42.4 Luna unavailable, backing off, or capped.
  if (
    state.assist.reason !== null &&
    (state.assist.state === 'unavailable' ||
      state.assist.state === 'backing_off' ||
      state.assist.state === 'limit_reached')
  ) {
    const copy = lunaUnavailableCopy(state.assist.reason);
    notices.push({
      id: 'luna_unavailable',
      tone: copy.tone,
      title: copy.title,
      detail: copy.detail,
      action: { id: 'open_assist_settings', label: 'Assist settings' },
    });
  }

  // §63 runtime budgets — quiet, informational.
  if (state.budgets.length > 0) {
    const copy = budgetNoticeCopy(state.budgets);
    notices.push({
      id: 'budget_exceeded',
      tone: copy.tone,
      title: copy.title,
      detail: copy.detail,
    });
  }

  return notices;
}

/**
 * Spoken units are a weighted word-like coordinate (§6), so unit velocity is
 * an approximation of words per minute — reported as such, and only while the
 * engine is actually moving with usable confidence.
 */
export function paceFromFrame(frame: SemanticMotionFrame): number | null {
  const moving =
    frame.state === 'following' ||
    frame.state === 'catching_up' ||
    frame.state === 'coasting';
  if (!moving) return null;
  if (!Number.isFinite(frame.velocityUnitsPerSecond) || frame.velocityUnitsPerSecond <= 0) {
    return null;
  }
  if (frame.confidence < 0.35) return null;
  return frame.velocityUnitsPerSecond * 60;
}

/* ---------------------------------------------------------------------------
 * Store
 * ------------------------------------------------------------------------- */

export interface SmoothFollowStore extends Readable<SmoothFollowState> {
  /* --- lifecycle --- */
  beginSession(sessionId: string, following?: FollowingSettings): void;
  endSession(): void;
  reset(): void;
  applyFollowingSettings(following: FollowingSettings): void;
  setActions(actions: Partial<FollowActions>): void;

  /* --- producers --- */
  ingestMotionFrame(frame: SemanticMotionFrame): void;
  ingestMovementRecord(record: MovementDecisionRecord): void;
  ingestStageAck(ack: StageMotionAck): void;
  ingestAssistStatus(patch: Partial<AssistStatus>): void;
  ingestCoachTip(tip: CoachTipView): void;
  setCandidates(candidates: FollowCandidate[]): void;
  reportTranscriptStatus(status: TranscriptFeedStatus, detail?: string | null): void;
  reportLineMapInvalid(detail: string): void;
  reportLineMapRebuilt(generation: number): void;
  reportBudgetBreach(breach: Omit<BudgetBreach, 'atMs'> & { atMs?: number }): void;
  clearBudget(id: RuntimeBudgetId): void;

  /* --- user actions (§48) --- */
  nudge(direction: 'back' | 'forward'): void;
  reAnchorHere(): void;
  acceptCandidate(candidateId: string): void;
  toggleFollowingPaused(): void;
  setFollowingPaused(paused: boolean): void;
  chooseIntelligenceMode(mode: IntelligenceMode): void;
  setCoachingDisplay(display: CoachingDisplay): void;
  setCoachingEnabled(enabled: boolean): void;
  /** §62 recovery: ask the stage to rebuild its line map. */
  requestLayoutRebuild(): void;

  /* --- diagnostics --- */
  exportDiagnostics(): FollowDiagnosticsExport;
  snapshot(): SmoothFollowState;
}

/** Redacted support payload (§57.3, §64: "text is redacted by default"). */
export interface FollowDiagnosticsExport {
  kind: 'candidcue.follow-diagnostics';
  version: 1;
  redacted: true;
  exportedAtMs: number;
  sessionId: string | null;
  motionProfileId: string;
  state: TrackingStateV2;
  behavior: TrackingBehavior;
  confidenceBand: ConfidenceBand;
  assist: AssistStatus;
  motion: SmoothFollowState['motion'];
  transcript: SmoothFollowState['transcript'];
  lineMap: SmoothFollowState['lineMap'];
  budgets: BudgetBreach[];
  notices: Array<{ id: FollowNoticeId; title: string }>;
  counts: SmoothFollowState['counts'];
  movements: MovementDecisionRecord[];
  timeline: Array<Omit<FollowTimelineEntry, 'record'>>;
}

export function createSmoothFollowStore(
  options: SmoothFollowStoreOptions = {},
): SmoothFollowStore {
  const now = options.now ?? (() => Date.now());
  const timelineCapacity = Math.max(1, options.timelineCapacity ?? 200);
  const movementCapacity = Math.max(1, options.movementCapacity ?? 60);
  const frameDropThreshold = Math.max(1, options.frameDropThreshold ?? 3);

  let following = defaultFollowingSettings();
  let actions: FollowActions = { ...NO_ACTIONS, ...(options.actions ?? {}) };
  let seq = 0;
  let sessionStartedAtMs: number | null = null;

  const store = writable<SmoothFollowState>(initialState(following));

  function push(
    state: SmoothFollowState,
    kind: FollowTimelineKind,
    summary: string,
    detail?: string,
    record?: MovementDecisionRecord,
  ): FollowTimelineEntry[] {
    seq += 1;
    const atMs = now();
    const entry: FollowTimelineEntry = {
      seq,
      atMs,
      sessionTimeMs: sessionStartedAtMs === null ? null : atMs - sessionStartedAtMs,
      kind,
      summary,
      ...(detail === undefined ? {} : { detail }),
      ...(record === undefined ? {} : { record }),
    };
    const next = [...state.timeline, entry];
    return next.length > timelineCapacity ? next.slice(next.length - timelineCapacity) : next;
  }

  /** Every mutation funnels through here so notices are always consistent. */
  function update(mutate: (state: SmoothFollowState) => SmoothFollowState): void {
    store.update((current) => {
      const next = mutate(current);
      const notices = deriveNotices(next);
      return sameNotices(next.notices, notices) ? next : { ...next, notices };
    });
  }

  function setFollowingPaused(paused: boolean): void {
    actions.setFollowingPaused(paused);
    update((s) => ({
      ...s,
      followingPaused: paused,
      timeline: push(s, 'action', paused ? 'Following paused' : 'Following resumed'),
    }));
  }

  function setCoachingDisplay(display: CoachingDisplay): void {
    actions.setCoachingDisplay(display);
    update((s) => ({
      ...s,
      coaching: {
        display,
        enabled: coachingIsEnabled(display),
        lastTip: coachingIsEnabled(display) ? s.coaching.lastTip : null,
      },
      timeline: push(s, 'coach', `Coaching display: ${display}`),
    }));
  }

  return {
    subscribe: store.subscribe,

    beginSession(sessionId, sessionFollowing) {
      if (sessionFollowing) following = sessionFollowing;
      seq = 0;
      sessionStartedAtMs = now();
      const base = initialState(following);
      store.set({ ...base, sessionId, active: true });
      update((s) => ({
        ...s,
        timeline: push(s, 'state', 'Session started', `Motion profile ${s.motionProfileId}`),
      }));
    },

    endSession() {
      update((s) => ({
        ...s,
        active: false,
        receivingFrames: false,
        candidates: [],
        timeline: push(s, 'state', 'Session ended'),
      }));
    },

    reset() {
      seq = 0;
      sessionStartedAtMs = null;
      store.set(initialState(following));
    },

    applyFollowingSettings(next) {
      following = next;
      update((s) => {
        const modeChanged = s.assist.configuredMode !== next.intelligenceMode;
        return {
          ...s,
          motionProfileId: next.motionProfileId,
          coaching: {
            display: next.coachingDisplay,
            enabled: coachingIsEnabled(next.coachingDisplay),
            lastTip: coachingIsEnabled(next.coachingDisplay) ? s.coaching.lastTip : null,
          },
          assist: modeChanged
            ? {
                ...initialAssist(next.intelligenceMode),
                requestCount: s.assist.requestCount,
                tokensIn: s.assist.tokensIn,
                tokensOut: s.assist.tokensOut,
              }
            : s.assist,
          timeline: modeChanged
            ? push(s, 'assist', `Intelligent assist set to ${next.intelligenceMode}`)
            : s.timeline,
        };
      });
    },

    setActions(next) {
      actions = { ...actions, ...next };
    },

    ingestMotionFrame(frame) {
      update((s) => {
        if (s.sessionId !== null && frame.sessionId !== s.sessionId) return s;
        if (frame.revision < s.revision && frame.epoch <= s.epoch) return s;
        const stateChanged = frame.state !== s.state;
        const behaviorChanged = frame.behavior !== s.behavior;
        const timeline = stateChanged
          ? push(
              s,
              'state',
              `${FOLLOW_STATE_LABELS[s.state]} → ${FOLLOW_STATE_LABELS[frame.state]}`,
              `behavior ${frame.behavior}, confidence ${frame.confidence.toFixed(2)}`,
            )
          : s.timeline;
        return {
          ...s,
          receivingFrames: true,
          lastFrameAtMs: now(),
          state: frame.state,
          behavior: frame.behavior,
          confidence: frame.confidence,
          band: confidenceBand(frame.confidence),
          paceWordsPerMinute: paceFromFrame(frame),
          sectionId: frame.sectionId,
          blockId: frame.blockId,
          sentenceId: frame.sentenceId,
          tokenIndex: frame.tokenIndex,
          estimatedUnit: frame.estimatedUnit,
          committedUnit: frame.committedUnit,
          revision: frame.revision,
          epoch: frame.epoch,
          layoutGeneration: frame.layoutGeneration,
          motionProfileId: frame.motionProfileId || s.motionProfileId,
          // A frame that is following again clears a "lost" candidate offer.
          candidates: frame.state === 'lost_local' ? s.candidates : [],
          counts: { ...s.counts, frames: s.counts.frames + 1 },
          timeline:
            behaviorChanged && !stateChanged
              ? push(s, 'state', `Behavior: ${frame.behavior}`)
              : timeline,
        };
      });
    },

    ingestMovementRecord(record) {
      update((s) => {
        const explanation = describeMovement(record);
        const movements = [...s.movements, record];
        return {
          ...s,
          lastMovement: record,
          lastTransitionReason: explanation.headline,
          movements:
            movements.length > movementCapacity
              ? movements.slice(movements.length - movementCapacity)
              : movements,
          counts: {
            ...s.counts,
            movements: s.counts.movements + 1,
            reanchors:
              record.visualDisposition === 'reanchor'
                ? s.counts.reanchors + 1
                : s.counts.reanchors,
          },
          timeline: push(s, 'movement', explanation.headline, explanation.detail, record),
        };
      });
    },

    ingestStageAck(ack) {
      update((s) => {
        if (s.sessionId !== null && ack.sessionId !== s.sessionId) return s;
        const degraded =
          ack.droppedFrameCountWindow >= frameDropThreshold ||
          ack.controllerState.includes('degraded');
        const becameDegraded = degraded && !s.motion.degraded;
        const recovered = !degraded && s.motion.degraded;
        return {
          ...s,
          motion: {
            controllerState: ack.controllerState,
            droppedFrameCountWindow: ack.droppedFrameCountWindow,
            trackingErrorPx: Math.round((ack.targetScrollPx - ack.actualScrollPx) * 10) / 10,
            degraded,
            lastAckAtMs: now(),
          },
          layoutGeneration: ack.layoutGeneration,
          counts: { ...s.counts, acks: s.counts.acks + 1 },
          timeline: becameDegraded
            ? push(
                s,
                'motion',
                'Stage reported dropped frames',
                `${ack.droppedFrameCountWindow} dropped in the last window; controller ${ack.controllerState}`,
              )
            : recovered
              ? push(s, 'motion', 'Stage frame rate recovered')
              : s.timeline,
        };
      });
    },

    ingestAssistStatus(patch) {
      update((s) => {
        const assist: AssistStatus = { ...s.assist, ...patch };
        const changed = assist.state !== s.assist.state || assist.reason !== s.assist.reason;
        return {
          ...s,
          assist,
          timeline: changed
            ? push(
                s,
                'assist',
                `Assist ${assist.state.replace('_', ' ')}`,
                assist.reason ? `reason: ${assist.reason}` : undefined,
              )
            : s.timeline,
        };
      });
    },

    ingestCoachTip(tip) {
      update((s) => {
        if (!s.coaching.enabled) return s;
        return {
          ...s,
          coaching: { ...s.coaching, lastTip: tip },
          timeline: push(s, 'coach', `Tip: ${tip.code}`, tip.text),
        };
      });
    },

    setCandidates(candidates) {
      update((s) => ({ ...s, candidates }));
    },

    reportTranscriptStatus(status, detail = null) {
      update((s) => {
        if (s.transcript.status === status && s.transcript.detail === detail) return s;
        return {
          ...s,
          transcript: { status, detail },
          timeline: push(s, 'notice', `Transcript feed: ${status}`, detail ?? undefined),
        };
      });
    },

    reportLineMapInvalid(detail) {
      update((s) =>
        s.lineMap.valid === false && s.lineMap.detail === detail
          ? s
          : {
              ...s,
              lineMap: { ...s.lineMap, valid: false, detail },
              timeline: push(s, 'notice', 'Stage line map invalid', detail),
            },
      );
    },

    reportLineMapRebuilt(generation) {
      update((s) => ({
        ...s,
        lineMap: { valid: true, generation, detail: null },
        layoutGeneration: generation,
        timeline: s.lineMap.valid
          ? s.timeline
          : push(s, 'notice', `Stage line map rebuilt (generation ${generation})`),
      }));
    },

    reportBudgetBreach(breach) {
      update((s) => {
        const entry: BudgetBreach = { ...breach, atMs: breach.atMs ?? now() };
        const budgets = [...s.budgets.filter((b) => b.id !== entry.id), entry];
        return {
          ...s,
          budgets,
          timeline: push(
            s,
            'budget',
            `Over budget: ${entry.id}`,
            `${entry.observed}${entry.unit} against ${entry.budget}${entry.unit}`,
          ),
        };
      });
    },

    clearBudget(id) {
      update((s) =>
        s.budgets.some((b) => b.id === id)
          ? { ...s, budgets: s.budgets.filter((b) => b.id !== id) }
          : s,
      );
    },

    /* ----------------------------------------------------------- actions */

    nudge(direction) {
      const delta = direction === 'forward' ? 1 : -1;
      actions.nudge(delta);
      update((s) => ({
        ...s,
        timeline: push(
          s,
          'action',
          direction === 'forward' ? 'Nudged forward one sentence' : 'Nudged back one sentence',
        ),
      }));
    },

    reAnchorHere() {
      actions.reAnchor();
      update((s) => ({ ...s, timeline: push(s, 'action', 'Re-find me here') }));
    },

    acceptCandidate(candidateId) {
      const state = get(store);
      const candidate = state.candidates.find((c) => c.id === candidateId);
      if (!candidate) return;
      actions.acceptCandidate(candidate);
      update((s) => ({
        ...s,
        candidates: [],
        timeline: push(s, 'action', `Started from “${candidate.label}”`),
      }));
    },

    toggleFollowingPaused() {
      setFollowingPaused(!get(store).followingPaused);
    },

    setFollowingPaused,

    chooseIntelligenceMode(mode) {
      actions.setIntelligenceMode(mode);
      update((s) => ({
        ...s,
        assist: {
          ...initialAssist(mode),
          requestCount: s.assist.requestCount,
          tokensIn: s.assist.tokensIn,
          tokensOut: s.assist.tokensOut,
        },
        timeline: push(s, 'assist', `Intelligent assist set to ${mode}`),
      }));
    },

    setCoachingDisplay,

    setCoachingEnabled(enabled) {
      const current = get(store).coaching.display;
      setCoachingDisplay(enabled ? (current === 'off' ? 'control' : current) : 'off');
    },

    requestLayoutRebuild() {
      actions.rebuildStageLayout();
      update((s) => ({ ...s, timeline: push(s, 'action', 'Requested a stage layout rebuild') }));
    },

    exportDiagnostics() {
      const s = get(store);
      return {
        kind: 'candidcue.follow-diagnostics',
        version: 1,
        redacted: true,
        exportedAtMs: now(),
        sessionId: s.sessionId,
        motionProfileId: s.motionProfileId,
        state: s.state,
        behavior: s.behavior,
        confidenceBand: s.band,
        assist: s.assist,
        motion: s.motion,
        transcript: s.transcript,
        lineMap: s.lineMap,
        budgets: s.budgets,
        notices: s.notices.map((n) => ({ id: n.id, title: n.title })),
        counts: s.counts,
        movements: s.movements,
        // Timeline summaries can quote a coach tip, and tips are derived from
        // script text — so the export carries structure only (§57.3).
        timeline: s.timeline.map(({ record: _record, detail: _detail, ...rest }) => rest),
      };
    },

    snapshot() {
      return get(store);
    },
  };
}

function sameNotices(a: FollowNotice[], b: FollowNotice[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((notice, i) => notice.id === b[i]?.id && notice.detail === b[i]?.detail);
}

/* ---------------------------------------------------------------------------
 * Singleton used by the control UI
 * ------------------------------------------------------------------------- */

export const smoothFollow = createSmoothFollowStore();

/** Wire the real side effects (called by the session store on start). */
export function configureFollowActions(actions: Partial<FollowActions>): void {
  smoothFollow.setActions(actions);
}

/** Short status line for the Live header — plain language only (§48). */
export const followStatusLabel = derived(smoothFollow, (s): string => {
  if (s.followingPaused) return 'Following paused — the text stays put';
  if (!s.receivingFrames) return 'Ready to follow';
  return FOLLOW_STATE_LABELS[s.state];
});

/** The most serious current notice, or null when everything is nominal. */
export const followTopNotice = derived(
  smoothFollow,
  (s): FollowNotice | null => s.notices[0] ?? null,
);
