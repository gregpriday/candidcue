/**
 * Live-session service — owns session identity and the tracking feed the Live
 * screen consumes (TrackingSnapshot from the shared contracts).
 *
 * The real feed will be wired to the tracking worker + realtime transport at
 * integration time; the driver below is a MOCK (clearly marked) that walks
 * the compiled sentences so the Live screen is complete and reviewable.
 * Integration replaces `createTrackingDriver`'s internals only — the
 * interface is the contract the UI depends on.
 */
import type { SentenceUnit, TrackingSnapshot, TrackingState } from '../../shared/contracts';

export interface TrackingDriverOptions {
  sessionId: string;
  scriptId: string;
  sentences: SentenceUnit[];
  /** Total spoken tokens (fallback range when sentences are unavailable). */
  totalTokens: number;
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
}

export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `session-${Date.now().toString(36)}`;
}

/* ============================================================================
 * MOCK TRACKING DRIVER — awaiting tracking-worker + realtime integration.
 * Emits contract-correct TrackingSnapshot values by walking the compiled
 * sentence list on a timer, with occasional "holding" wobbles so the
 * confidence UI exercises every state.
 * ========================================================================== */

const FALLBACK_LINES = [
  'Speak naturally and the stage follows along.',
  'CandidCue keeps your place while you talk.',
  'Pause any time — the script simply waits.',
];

export function createTrackingDriver(options: TrackingDriverOptions): TrackingDriver {
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
      sessionGeneration: 1,
      stageGeneration: 1,
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
  };
}
