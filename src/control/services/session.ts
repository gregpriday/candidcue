/**
 * Live-session tracking driver — owns the seam between the session store and
 * the tracking worker (src/workers/tracking.worker.ts, protocol in
 * src/shared/tracking/worker-protocol.ts).
 *
 * Two implementations share one interface:
 *  - the REAL driver hosts the deterministic alignment engine in a Web
 *    Worker, initialized with buildTrackingDocument(compiledScript) and fed
 *    provider-neutral TranscriptEvents from the realtime layer;
 *  - a MOCK driver (timer-driven) remains for environments without Worker
 *    support (node unit tests, degraded browser dev) and for manual/fixed
 *    modes in the plain browser.
 */
import type {
  CompiledScript,
  SemanticMotionFrame,
  SentenceUnit,
  TrackingSnapshot,
  TrackingState,
} from '../../shared/contracts';
import type { MovementDecisionRecord } from '../../shared/tracking/decision-log';
import type { SemanticAssistEvidence } from '../../shared/tracking/semantic-assist';
import type { AssistSchedulingContext } from '../../shared/semantic';
import {
  buildTrackingDocument,
  type AlignmentDiagnostic,
  type TranscriptEvent,
} from '../../shared/tracking/types';
import type { TrackingProfile } from '../../shared/tracking/profile';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../../shared/tracking/worker-protocol';
import {
  defaultFollowingSettings,
  resolveFollowProfile,
  type FollowingSettings,
} from '../lib/follow-profiles';
import { getSettingsSnapshot } from '../stores/settings';

export interface TrackingDriverOptions {
  sessionId: string;
  scriptId: string;
  sentences: SentenceUnit[];
  /** Total spoken tokens (fallback range when sentences are unavailable). */
  totalTokens: number;
  /** Full compile result; required for the real worker-backed driver. */
  compiled?: CompiledScript | null;
  sessionGeneration?: number;
  stageGeneration?: number;
  profile?: Partial<TrackingProfile>;
  /**
   * §47 follow settings for this session, resolved here into the §55
   * `SmoothFollowProfile` the tracking worker's engine runs on.
   *
   * This is the SAME resolution the stage envelope performs
   * (`buildStageEnvelope` → `resolveFollowProfile`), through the same single
   * authority, because the two are two halves of one behaviour: the worker owns
   * prediction horizons, lead seconds and `catchUpMultiplier`, the stage owns
   * the motion limits those predictions are rendered through. Resolving them
   * from different settings is split-brain following — Calm limits on the glass
   * driven by Responsive horizons underneath, with nothing on either side able
   * to detect it.
   *
   * Omitted falls back to the saved settings (see `sessionFollowingSettings`),
   * never to a hardcoded default, so a caller that has not been taught to pass
   * it still gets the user's chosen feel rather than silently reverting.
   */
  following?: FollowingSettings;
  onSnapshot(snapshot: TrackingSnapshot): void;
  onTranscript(line: string): void;
  /**
   * Alignment decisions, for the control-side "why did it move?" record
   * (companion §65). Optional: the mock driver emits a reduced form and a
   * caller that does not care simply omits it.
   */
  onDiagnostic?(diagnostic: AlignmentDiagnostic): void;
  /** Companion §26.1 motion frames — the worker's v2 output. */
  onMotionFrame?(frame: SemanticMotionFrame): void;
  /** Companion §65 records straight from the engine's decision log. */
  onMovementRecord?(record: MovementDecisionRecord): void;
  /**
   * Companion §37.1 — the post-section-gate candidate set the Luna sidecar
   * schedules against. Emitted at ~2 Hz on finalized evidence only.
   */
  onSemanticContext?(context: AssistSchedulingContext): void;
}

export interface TrackingDriver {
  start(): void;
  pause(): void;
  resume(): void;
  /** Move by whole sentences (negative = back). */
  moveSentences(delta: number): void;
  restartParagraph(): void;
  dispose(): void;
  /** Real-pipeline surface; no-ops on the mock driver. */
  feedTranscript(event: TranscriptEvent): void;
  maskItems(itemIds: string[]): void;
  releaseItems(itemIds: string[]): void;
  setCommandPending(pending: boolean): void;
  moveToToken(tokenIndex: number, movement: 'manual' | 'command'): void;
  /**
   * Companion §40 — bounded, already fused + validated sidecar evidence. The
   * beam re-clamps it and re-checks epoch, TTL, source items and candidate
   * membership, so this can never be the sole authority for a move.
   */
  applySemanticAssist(evidence: SemanticAssistEvidence): void;
  /**
   * Companion §7.2 — close the layout-generation loop.
   *
   * The stage owns the counter: it bumps a LOCAL generation on every real
   * layout change and stamps its `StageMotionAck`s with it. The worker stamps
   * every `SemanticMotionFrame` with whatever generation it was last told, and
   * the stage's receiver rejects frames whose generation differs from its own.
   * Without this message the worker's generation is frozen at its initial value
   * for the whole session, so every frame is stale by construction and survives
   * only through the receiver's stale-layout tolerance — the gate is running
   * permanently on its own escape hatch. Control is the only party that hears
   * both sides, so control is the only party that can close the loop.
   */
  setLayoutGeneration(generation: number): void;
}

export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `session-${Date.now().toString(36)}`;
}

/* ============================================================================
 * Worker-backed driver (the real pipeline)
 * ========================================================================== */

/** Minimal worker surface so tests can inject a fake. */
export interface TrackingWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

type TrackingWorkerFactory = () => TrackingWorkerLike;

const defaultWorkerFactory: TrackingWorkerFactory = () =>
  new Worker(new URL('../../workers/tracking.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as TrackingWorkerLike;

let workerFactory: TrackingWorkerFactory | null = null;

/** Inject a fake tracking worker in unit tests. Pass null to restore. */
export function setTrackingWorkerFactoryForTesting(factory: TrackingWorkerFactory | null): void {
  workerFactory = factory;
}

function workerAvailable(): boolean {
  return workerFactory !== null || typeof Worker !== 'undefined';
}

/**
 * The §47 settings this session's tracking worker should run on.
 *
 * Prefers what the caller passed; otherwise reads the loaded settings snapshot,
 * which is exactly what the live-session caller resolves from. Reading it
 * defensively (the store may be unloaded in browser dev, in a unit test, or
 * outside Tauri) keeps a settings failure from being able to stop a take —
 * consistent with how every other consumer of this snapshot behaves.
 */
function sessionFollowingSettings(explicit?: FollowingSettings): FollowingSettings {
  if (explicit) return explicit;
  try {
    return getSettingsSnapshot().following ?? defaultFollowingSettings();
  } catch {
    return defaultFollowingSettings();
  }
}

export function createWorkerTrackingDriver(options: TrackingDriverOptions): TrackingDriver {
  const compiled = options.compiled;
  if (!compiled) throw new Error('worker tracking driver needs a compiled script');
  const worker = (workerFactory ?? defaultWorkerFactory)();
  const sentences = compiled.sentences;
  let lastSnapshot: TrackingSnapshot | null = null;
  let disposed = false;

  const post = (message: TrackingWorkerInbound) => {
    if (!disposed) worker.postMessage(message);
  };

  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as TrackingWorkerOutbound | null;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    if (data.type === 'snapshot') {
      lastSnapshot = data.snapshot;
      options.onSnapshot(data.snapshot);
    } else if (data.type === 'semantic_frame') {
      options.onMotionFrame?.(data.frame);
    } else if (data.type === 'movement_decision') {
      options.onMovementRecord?.(data.record);
    } else if (data.type === 'semantic_context') {
      options.onSemanticContext?.(data.context);
    } else if (data.type === 'diagnostic') {
      options.onDiagnostic?.(data.diagnostic);
    } else if (data.type === 'error') {
      console.warn(`tracking worker: ${data.code} — ${data.message}`);
    }
    // state_change is folded into snapshots.
  });

  post({
    type: 'initialize',
    // §33.5: the aligner must know which token ranges came from
    // `:::literal-command` blocks so reading a wake phrase aloud from inside
    // one is never treated as an address to the app.
    document: buildTrackingDocument(compiled, compiled.literalCommandRanges),
    profile: options.profile ?? {},
    // §47.1/§55: the user's Follow feel and voice lead, resolved through the
    // same authority the stage envelope uses. A profile this build cannot
    // interpret is rejected whole by `resolveSmoothFollowProfile` inside the
    // engine, so a bad one degrades to the default instead of half-applying.
    smoothProfile: resolveFollowProfile(sessionFollowingSettings(options.following)),
    session: {
      sessionId: options.sessionId,
      sessionGeneration: options.sessionGeneration ?? 1,
      stageGeneration: options.stageGeneration ?? 1,
    },
    nowMs: Date.now(),
  });
  // Hold position until the user explicitly starts prompting (§9.1).
  post({ type: 'pause', nowMs: Date.now() });

  function currentSentenceIndex(): number {
    if (!lastSnapshot) return 0;
    const bySentence = sentences.findIndex((s) => s.id === lastSnapshot?.sentenceId);
    if (bySentence >= 0) return bySentence;
    const token = lastSnapshot.tokenIndex;
    let best = 0;
    sentences.forEach((s, i) => {
      if (s.startTokenIndex <= token) best = i;
    });
    return best;
  }

  return {
    start() {
      post({ type: 'resume', nowMs: Date.now() });
    },
    pause() {
      post({ type: 'pause', nowMs: Date.now() });
    },
    resume() {
      post({ type: 'resume', nowMs: Date.now() });
    },
    moveSentences(delta: number) {
      if (sentences.length === 0) return;
      const index = Math.max(0, Math.min(sentences.length - 1, currentSentenceIndex() + delta));
      const target = sentences[index];
      if (target) post({ type: 'move_to_token', tokenIndex: target.startTokenIndex, movement: 'manual', nowMs: Date.now() });
    },
    restartParagraph() {
      const sentence = sentences[currentSentenceIndex()];
      if (!sentence) return;
      const first = sentences.find((s) => s.blockId === sentence.blockId) ?? sentence;
      post({ type: 'move_to_token', tokenIndex: first.startTokenIndex, movement: 'manual', nowMs: Date.now() });
    },
    dispose() {
      disposed = true;
      worker.terminate();
    },
    feedTranscript(event: TranscriptEvent) {
      post({ type: 'transcript_event', event });
    },
    maskItems(itemIds: string[]) {
      if (itemIds.length > 0) post({ type: 'mask_items', itemIds });
    },
    releaseItems(itemIds: string[]) {
      if (itemIds.length > 0) post({ type: 'release_items', itemIds });
    },
    setCommandPending(pending: boolean) {
      post({ type: 'set_command_pending', pending, nowMs: Date.now() });
    },
    moveToToken(tokenIndex: number, movement: 'manual' | 'command') {
      post({ type: 'move_to_token', tokenIndex, movement, nowMs: Date.now() });
    },
    applySemanticAssist(evidence: SemanticAssistEvidence) {
      post({ type: 'semantic_assist', evidence });
    },
    setLayoutGeneration(generation: number) {
      if (!Number.isInteger(generation) || generation < 0) return;
      post({ type: 'set_layout_generation', generation, nowMs: Date.now() });
    },
  };
}

/**
 * Factory used by the session store: the real worker driver whenever a
 * compiled script and Worker support exist, the mock otherwise.
 */
export function createTrackingDriver(options: TrackingDriverOptions): TrackingDriver {
  if (options.compiled && workerAvailable()) return createWorkerTrackingDriver(options);
  return createMockTrackingDriver(options);
}

/* ============================================================================
 * MOCK TRACKING DRIVER — used where Web Workers are unavailable (node unit
 * tests) so the Live screen and store semantics stay fully exercisable.
 * Emits contract-correct TrackingSnapshot values by walking the compiled
 * sentence list on a timer, with occasional "holding" wobbles so the
 * confidence UI exercises every state.
 * ========================================================================== */

const FALLBACK_LINES = [
  'Speak naturally and the stage follows along.',
  'CandidCue keeps your place while you talk.',
  'Pause any time — the script simply waits.',
];

export function createMockTrackingDriver(options: TrackingDriverOptions): TrackingDriver {
  const { sessionId, scriptId, sentences, onSnapshot, onTranscript } = options;
  const totalTokens = Math.max(options.totalTokens, 1);
  let revision = 0;
  let sentenceIndex = 0;
  let paused = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tick = 0;

  function currentSentence(): SentenceUnit | undefined {
    return sentences[Math.min(sentenceIndex, sentences.length - 1)];
  }

  function emit(state: TrackingState, movement: TrackingSnapshot['movement'], confidence: number): void {
    revision += 1;
    const sentence = currentSentence();
    const tokenIndex = sentence
      ? sentence.startTokenIndex
      : Math.min(totalTokens - 1, Math.round((sentenceIndex / 40) * totalTokens));
    options.onDiagnostic?.({
      revision,
      reason: `mock:${movement}`,
      state,
      movement,
      cursorTokenIndex: tokenIndex,
      committedTokenIndex: Math.max(0, tokenIndex - 2),
      confidence,
      margin: confidence / 2,
      candidates: [],
      generatedAtMs: Date.now(),
    });
    onSnapshot({
      schemaVersion: 1,
      revision,
      sessionId,
      sessionGeneration: options.sessionGeneration ?? 1,
      stageGeneration: options.stageGeneration ?? 1,
      scriptId,
      tokenIndex,
      committedTokenIndex: Math.max(0, tokenIndex - 2),
      blockId: sentence?.blockId ?? `mock-block-${Math.floor(sentenceIndex / 3)}`,
      sentenceId: sentence?.id ?? `mock-sentence-${sentenceIndex}`,
      confidence,
      state,
      provisional: state !== 'following',
      movement,
      sourceItemIds: [],
      generatedAtMs: Date.now(),
    });
  }

  function transcriptLine(): string {
    const sentence = currentSentence();
    if (sentence?.normalizedText) return sentence.normalizedText;
    return FALLBACK_LINES[sentenceIndex % FALLBACK_LINES.length] ?? '';
  }

  function step(): void {
    if (paused) return;
    tick += 1;
    // Every sixth tick, wobble into a brief "holding" to exercise the UI.
    if (tick % 6 === 5) {
      emit('holding', 'hold', 0.42 + Math.random() * 0.1);
      return;
    }
    const limit = sentences.length > 0 ? sentences.length - 1 : 39;
    if (sentenceIndex < limit) sentenceIndex += 1;
    onTranscript(transcriptLine());
    emit('following', 'advance', 0.78 + Math.random() * 0.18);
  }

  return {
    start() {
      emit('following', 'hold', 0.9);
      timer = setInterval(step, 1600);
    },
    pause() {
      paused = true;
      emit('paused', 'hold', 1);
    },
    resume() {
      paused = false;
      emit('following', 'hold', 0.85);
    },
    moveSentences(delta: number) {
      const limit = sentences.length > 0 ? sentences.length - 1 : 39;
      sentenceIndex = Math.max(0, Math.min(limit, sentenceIndex + delta));
      emit(paused ? 'paused' : 'following', 'manual', 0.95);
    },
    restartParagraph() {
      sentenceIndex = Math.max(0, sentenceIndex - 2);
      emit(paused ? 'paused' : 'following', 'retake', 0.95);
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    feedTranscript() {},
    maskItems() {},
    releaseItems() {},
    setCommandPending() {},
    applySemanticAssist() {},
    // The mock emits no semantic frames of its own; the store's v1 bridge is
    // what carries the generation on this path.
    setLayoutGeneration() {},
    moveToToken(tokenIndex: number) {
      let best = 0;
      sentences.forEach((s, i) => {
        if (s.startTokenIndex <= tokenIndex) best = i;
      });
      sentenceIndex = best;
      emit(paused ? 'paused' : 'following', 'manual', 0.95);
    },
  };
}
