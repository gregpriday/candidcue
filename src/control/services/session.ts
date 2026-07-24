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
import type { CompiledScript, SentenceUnit, TrackingSnapshot, TrackingState } from '../../shared/contracts';
import { buildTrackingDocument, type TranscriptEvent } from '../../shared/tracking/types';
import type { TrackingProfile } from '../../shared/tracking/profile';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../../shared/tracking/worker-protocol';

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
  onSnapshot(snapshot: TrackingSnapshot): void;
  onTranscript(line: string): void;
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
    } else if (data.type === 'error') {
      console.warn(`tracking worker: ${data.code} — ${data.message}`);
    }
    // state_change is folded into snapshots; diagnostics are dev-only.
  });

  post({
    type: 'initialize',
    document: buildTrackingDocument(compiled),
    profile: options.profile ?? {},
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
