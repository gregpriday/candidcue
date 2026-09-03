/**
 * SmoothFollowStore (companion §50.1) — the user-visible following state and
 * the controls that act on it.
 *
 * This store is the control window's single source of truth for "what is the
 * aligner doing, how sure is it, and what has quietly degraded". It is fed by
 * two producers and owns neither:
 *
 *   Rust alignment engine  ──AlignmentSnapshot──▶ ingestSnapshot
 *   stage frame loop       ──StageMotionAck─────▶ ingestStageAck
 *
 * The movement timeline is DERIVED here from consecutive snapshots rather than
 * reported: the engine states where the reader is, and "it moved from here to
 * there" is a fact about two of those statements. Deriving it is what lets the
 * engine's contract stay as small as it is.
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
  AlignmentDecision,
  AlignmentSnapshot,
  StageMotionAck,
  StageMotionState,
} from '../../shared/contracts';
import { ALIGNMENT_RELOCATIONS } from '../../shared/contracts';
import {
  budgetNoticeCopy,
  confidenceBand,
  describeMovement,
  FOLLOW_NOTICE_COPY,
  FOLLOW_STATE_LABELS,
  type ConfidenceBand,
  type FollowNoticeId,
  type FollowNoticeTone,
  type MovementDecisionRecord,
  type RuntimeBudgetId,
} from '../lib/follow-language';
import { defaultFollowingSettings, type FollowingSettings } from '../lib/follow-profiles';

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------- */

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
  action?: { id: 'rebuild_layout'; label: string };
}

export type TranscriptFeedStatus = 'idle' | 'live' | 'interrupted' | 'low_confidence';

/** Kinds of entry in the §64 diagnostics timeline. */
export type FollowTimelineKind =
  | 'state'
  | 'movement'
  | 'motion'
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

  state: StageMotionState;
  decision: AlignmentDecision;
  confidence: number | null;
  band: ConfidenceBand;
  paceWordsPerMinute: number | null;

  /**
   * A distant candidate the engine has NOT accepted — "possible match below".
   * The UI may offer it; it must never be acted on automatically.
   */
  suggestionToken: number | null;
  observedToken: number;
  confirmedToken: number;
  /** Snapshot sequence number, monotone within a session. */
  seq: number;
  /**
   * The alignment session snapshots must be stamped with, or null before one
   * exists. Null rather than a numeric sentinel because the generation is
   * ASSIGNED BY RUST: control adopts whatever it is given, and a number here
   * would be control inventing one.
   */
  sessionGeneration: number | null;
  layoutGeneration: number;
  motionProfileId: string;

  /** §48 — following can be paused without pausing the session. */
  followingPaused: boolean;

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
  /** "Set my place" — re-anchor around the current position (§48). */
  reAnchor(): void;
  /** Accept one of the offered local candidates when lost (§48). */
  acceptCandidate(candidate: FollowCandidate): void;
  /**
   * Pause/resume automatic following without touching the session (§48).
   *
   * `deliberate` separates a decision from a symptom, and the stage is why it
   * has to. Somebody switching following off is a MODE, and the glass says so
   * in words with a lit control beside them; transcription going untrustworthy
   * (`onFollowingHold`) is a fault, and the hold ladder and the audio readout
   * already word that one properly. They arrive at this action by the same
   * road and mean opposite things — one is "I am driving now", the other is "I
   * cannot hear you" — so a stage told only that following stopped would blame
   * the presenter for the microphone.
   */
  setFollowingPaused(paused: boolean, deliberate?: boolean): void;
  /** Ask the stage to rebuild its line map after §62. */
  rebuildStageLayout(): void;
}

const NO_ACTIONS: FollowActions = {
  nudge: () => {},
  reAnchor: () => {},
  acceptCandidate: () => {},
  setFollowingPaused: () => {},
  rebuildStageLayout: () => {},
};

function initialState(following: FollowingSettings): SmoothFollowState {
  return {
    sessionId: null,
    active: false,
    receivingFrames: false,
    lastFrameAtMs: null,
    state: 'searching',
    decision: 'noEvidence',
    confidence: null,
    band: 'unknown',
    paceWordsPerMinute: null,
    suggestionToken: null,
    observedToken: 0,
    confirmedToken: 0,
    seq: 0,
    sessionGeneration: null,
    layoutGeneration: 0,
    motionProfileId: following.motionProfileId,
    followingPaused: false,
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
 * Approximate words per minute from a snapshot's reading rate.
 *
 * A token is a word, so the conversion is just a factor of sixty. It is
 * reported only while the engine is genuinely following: the rate is zeroed in
 * every other state, and a "0 wpm" readout during a deliberate hold would
 * describe the presenter as having stopped speaking when they have not.
 */
export function paceFromSnapshot(snapshot: AlignmentSnapshot): number | null {
  if (snapshot.state !== 'following') return null;
  if (!Number.isFinite(snapshot.rateTokensPerSecond) || snapshot.rateTokensPerSecond <= 0) {
    return null;
  }
  if (snapshot.confidence < 0.35) return null;
  return snapshot.rateTokensPerSecond * 60;
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
  /**
   * One alignment snapshot. Derives the movement timeline internally, so
   * callers hand over exactly what Rust published and nothing more.
   */
  ingestSnapshot(snapshot: AlignmentSnapshot): void;
  ingestStageAck(ack: StageMotionAck): void;
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
  /** `deliberate` is false only for an automatic hold; see `FollowActions`. */
  setFollowingPaused(paused: boolean, deliberate?: boolean): void;
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
  state: StageMotionState;
  decision: AlignmentDecision;
  confidenceBand: ConfidenceBand;
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

  /**
   * Whether the presenter/operator switched following off, as opposed to the
   * transcript going untrustworthy underneath them.
   *
   * Kept HERE, in the one function every road into pausing goes through, rather
   * than only in the session store's action. Guarding at the action alone let
   * this store's own `followingPaused` drift out of step with what the action
   * actually did: an automatic release over a deliberate pause left the driver
   * paused (correctly) and this store saying "resumed", so the Live panel
   * offered "Pause following" over a take that was already paused and the first
   * click did nothing visible.
   */
  let userPaused = false;

  function setFollowingPaused(paused: boolean, deliberate = true): void {
    if (deliberate) {
      userPaused = paused;
    } else if (!paused && userPaused) {
      /*
       * An automatic release may not overrule a deliberate pause.
       *
       * "The transcript is trustworthy again" is not permission to start moving
       * a script the presenter has taken off automatic control. Only the
       * release direction is guarded — an automatic hold engaging over a
       * deliberate pause is harmless, following having already stopped.
       */
      return;
    }
    actions.setFollowingPaused(paused, deliberate);
    update((s) => ({
      ...s,
      followingPaused: paused,
      /*
       * The reported STATE has to change too, not only the flag.
       *
       * Nothing is being followed while following is paused, and the engine
       * cannot say so — it is not told about the pause, and would go on
       * reporting `following` from the last snapshot it produced. A panel
       * reading that state would describe a document that is tracking the
       * presenter's voice while it sits perfectly still.
       *
       * Resuming drops back to `searching`: the next snapshot will say what is
       * actually true, and until it arrives the honest answer is that the
       * position is being re-acquired rather than already known.
       */
      state: paused ? 'paused' : s.state === 'paused' ? 'searching' : s.state,
      timeline: push(s, 'action', paused ? 'Following paused' : 'Following resumed'),
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
      update((s) => ({ ...s, motionProfileId: next.motionProfileId }));
    },

    setActions(next) {
      actions = { ...actions, ...next };
    },

    ingestSnapshot(snapshot) {
      update((s) => {
        if (
          s.sessionGeneration !== null &&
          snapshot.sessionGeneration !== s.sessionGeneration
        ) {
          return s;
        }
        // `seq` is monotone within a session, so anything not strictly newer is
        // a duplicate or a reordered delivery — a past this store has already
        // moved through.
        if (snapshot.seq <= s.seq && s.seq !== 0) return s;

        const stateChanged = snapshot.state !== s.state;
        let timeline = stateChanged
          ? push(
              s,
              'state',
              `${FOLLOW_STATE_LABELS[s.state]} → ${FOLLOW_STATE_LABELS[snapshot.state]}`,
              `${snapshot.decision}, confidence ${snapshot.confidence.toFixed(2)}`,
            )
          : s.timeline;

        /*
         * A movement worth recording.
         *
         * Not every snapshot is: a steady advance at good confidence is not a
         * decision anybody needs explained, and recording each one would flood
         * the ring buffer and bury the entries that matter. What counts is an
         * accepted discontinuity, a state change, or evidence going soft.
         */
        const movedTokens = Math.abs(snapshot.observedToken - s.observedToken);
        const nontrivial =
          ALIGNMENT_RELOCATIONS.has(snapshot.decision) ||
          snapshot.decision === 'jumpPending' ||
          // A place the words fit that the leash refused to go to. The display
          // did not move, and that is exactly the decision worth explaining.
          snapshot.decision === 'holdOffScreen' ||
          stateChanged ||
          snapshot.confidence < 0.6;

        let movements = s.movements;
        let lastMovement = s.lastMovement;
        let lastTransitionReason = s.lastTransitionReason;
        let reanchors = s.counts.reanchors;

        if (nontrivial) {
          const record: MovementDecisionRecord = {
            seq: snapshot.seq,
            audioMs: snapshot.atAudioMs,
            fromToken: s.observedToken,
            toToken: snapshot.observedToken,
            decision: snapshot.decision,
            stateBefore: s.state,
            stateAfter: snapshot.state,
            confidence: snapshot.confidence,
          };
          const explanation = describeMovement(record);
          lastMovement = record;
          lastTransitionReason = explanation.headline;
          const next = [...movements, record];
          movements =
            next.length > movementCapacity
              ? next.slice(next.length - movementCapacity)
              : next;
          if (ALIGNMENT_RELOCATIONS.has(snapshot.decision) && movedTokens > 0) {
            reanchors += 1;
          }
          timeline = push(
            { ...s, timeline },
            'movement',
            explanation.headline,
            explanation.detail,
            record,
          );
        }

        return {
          ...s,
          receivingFrames: true,
          lastFrameAtMs: now(),
          state: snapshot.state,
          decision: snapshot.decision,
          confidence: snapshot.confidence,
          band: confidenceBand(snapshot.confidence),
          paceWordsPerMinute: paceFromSnapshot(snapshot),
          suggestionToken: snapshot.suggestionToken,
          observedToken: snapshot.observedToken,
          confirmedToken: snapshot.confirmedToken,
          seq: snapshot.seq,
          sessionGeneration: snapshot.sessionGeneration,
          // A snapshot that is following again clears a stale "resume here?"
          // offer, so the affordance never outlives the doubt that raised it.
          candidates: snapshot.state === 'following' ? [] : s.candidates,
          counts: {
            ...s.counts,
            frames: s.counts.frames + 1,
            movements: nontrivial ? s.counts.movements + 1 : s.counts.movements,
            reanchors,
          },
          movements,
          lastMovement,
          lastTransitionReason,
          timeline,
        };
      });
    },

    ingestStageAck(ack) {
      update((s) => {
        // Correlated by GENERATION: the stage knows which alignment session
        // it is following and nothing about session UUIDs, so that is the only
        // identity it can honestly stamp on a report.
        if (s.sessionGeneration !== null && ack.sessionGeneration !== s.sessionGeneration) {
          return s;
        }
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
          direction === 'forward' ? 'Next sentence' : 'Previous sentence',
        ),
      }));
    },

    reAnchorHere() {
      actions.reAnchor();
      update((s) => ({ ...s, timeline: push(s, 'action', 'Set my place') }));
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
        decision: s.decision,
        confidenceBand: s.band,
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
