/**
 * Live-session alignment driver — the seam between the session store and the
 * Rust alignment engine.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT ANY MORE
 * ---------------------------------------------------------------------------
 * This used to host a deterministic aligner in a Web Worker, feed it
 * provider-neutral transcript events, and receive positions back. All of that
 * moved to Rust, beside the socket that produces the transcripts and the audio
 * clock the engine's timing is calibrated against. What remains is a thin
 * lifecycle object: start, stop, move, and a subscription.
 *
 * Two implementations share one interface:
 *  - the REAL driver talks to `cc_align::Engine` through `services/alignment`;
 *  - a MOCK driver (timer-driven) covers environments with no Tauri runtime —
 *    node unit tests and plain browser dev — so the Live screen stays fully
 *    exercisable without a microphone or an API key.
 */
import type { AlignmentSnapshot, CompiledScript, SentenceUnit } from '../../shared/contracts';
import {
  setAlignmentPosition,
  startAlignment,
  stopAlignment,
  subscribeAlignmentSnapshots,
} from './alignment';
import { trace } from './audio-trace';

export interface TrackingDriverOptions {
  sessionId: string;
  scriptId: string;
  sentences: SentenceUnit[];
  /** Total spoken tokens (fallback range when sentences are unavailable). */
  totalTokens: number;
  /** Full compile result; required for the real engine-backed driver. */
  compiled?: CompiledScript | null;
  /**
   * The transcription generation this alignment belongs to. Rust rejects any
   * transcript frame whose generation differs, which is what keeps the tail of
   * a stopped take out of the next one.
   */
  sessionGeneration?: number;
  onSnapshot(snapshot: AlignmentSnapshot): void;
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
  /** Explicit "I am here", in fractional token space. */
  moveToToken(tokenIndex: number): void;
}

export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `session-${Date.now().toString(36)}`;
}

/* ============================================================================
 * Engine-backed driver (the real pipeline)
 * ========================================================================== */

export function createEngineTrackingDriver(options: TrackingDriverOptions): TrackingDriver {
  const compiled = options.compiled;
  if (!compiled) throw new Error('the alignment driver needs a compiled script');
  const sentences = compiled.sentences;
  const generation = options.sessionGeneration ?? 1;
  let lastSnapshot: AlignmentSnapshot | null = null;
  let disposed = false;
  /**
   * §9.1 — hold position until the user explicitly starts prompting.
   *
   * The engine has no pause: it is a pure function of the frames it is given,
   * so pausing means not giving it any. Gating on this side rather than asking
   * Rust for a pause switch keeps the engine's contract as small as it is
   * honest — there is no state in it that a "paused" flag could describe.
   */
  let prompting = false;

  const stopSnapshots = subscribeAlignmentSnapshots((snapshot) => {
    if (disposed || !prompting) return;
    if (snapshot.sessionGeneration !== generation) return;
    const previous = lastSnapshot;
    lastSnapshot = snapshot;
    // Every committed advance, once. This is the line that distinguishes "the
    // aligner is following" from "the stage is coasting on pace".
    if (previous?.confirmedToken !== snapshot.confirmedToken) {
      trace(
        'confirmed',
        `token ${snapshot.confirmedToken.toFixed(1)} state ${snapshot.state} ` +
          `confidence ${snapshot.confidence.toFixed(2)}`,
      );
    } else if (previous?.state !== snapshot.state) {
      trace('state', `${previous?.state ?? 'none'} → ${snapshot.state}`);
    }
    options.onSnapshot(snapshot);
  });

  void startAlignment(generation, compiled).catch((error) => {
    // A take with no alignment still records and still shows the script; it
    // simply does not follow. Failing the whole take here would be worse.
    console.warn('alignment failed to start', error);
  });

  function currentSentenceIndex(): number {
    if (!lastSnapshot) return 0;
    const token = lastSnapshot.confirmedToken;
    let best = 0;
    sentences.forEach((s, i) => {
      if (s.startTokenIndex <= token) best = i;
    });
    return best;
  }

  function moveTo(tokenIndex: number): void {
    if (disposed) return;
    trace('align-cmd', `move to token ${tokenIndex}`);
    void setAlignmentPosition(tokenIndex).catch(() => {
      // The move did not land. The presenter will see the display stay where
      // it was, which is the honest outcome — better than a UI that claims a
      // position the engine never adopted.
    });
  }

  return {
    start() {
      prompting = true;
      trace('align-cmd', 'start prompting');
    },
    pause() {
      prompting = false;
      trace('align-cmd', 'pause');
    },
    resume() {
      prompting = true;
      trace('align-cmd', 'resume');
    },
    moveSentences(delta: number) {
      if (sentences.length === 0) return;
      const index = Math.max(0, Math.min(sentences.length - 1, currentSentenceIndex() + delta));
      const target = sentences[index];
      if (target) moveTo(target.startTokenIndex);
    },
    restartParagraph() {
      const sentence = sentences[currentSentenceIndex()];
      if (!sentence) return;
      const first = sentences.find((s) => s.blockId === sentence.blockId) ?? sentence;
      moveTo(first.startTokenIndex);
    },
    moveToToken(tokenIndex: number) {
      moveTo(tokenIndex);
    },
    dispose() {
      disposed = true;
      prompting = false;
      stopSnapshots();
      void stopAlignment().catch(() => {});
    },
  };
}

/**
 * Factory used by the session store: the real engine driver whenever a
 * compiled script exists and the runtime can reach Rust, the mock otherwise.
 */
export function createTrackingDriver(options: TrackingDriverOptions): TrackingDriver {
  if (options.compiled) return createEngineTrackingDriver(options);
  return createMockTrackingDriver(options);
}

/* ============================================================================
 * MOCK DRIVER — used where there is no Rust to talk to (node unit tests,
 * browser dev, manual/fixed modes). Emits contract-correct AlignmentSnapshots
 * by walking the compiled sentence list on a timer, with occasional "holding"
 * wobbles so the confidence UI exercises every state.
 * ========================================================================== */

const FALLBACK_LINES = [
  'Speak naturally and the stage follows along.',
  'CandidCue keeps your place while you talk.',
  'Pause any time — the script simply waits.',
];

export function createMockTrackingDriver(options: TrackingDriverOptions): TrackingDriver {
  const { sentences, onSnapshot, onTranscript } = options;
  const totalTokens = Math.max(options.totalTokens, 1);
  const generation = options.sessionGeneration ?? 1;
  let seq = 0;
  let sentenceIndex = 0;
  let paused = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tick = 0;
  let audioMs = 0;

  function currentSentence(): SentenceUnit | undefined {
    return sentences[Math.min(sentenceIndex, sentences.length - 1)];
  }

  function emit(state: AlignmentSnapshot['state'], decision: AlignmentSnapshot['decision'], confidence: number): void {
    seq += 1;
    const sentence = currentSentence();
    const token = sentence
      ? sentence.startTokenIndex
      : Math.min(totalTokens - 1, Math.round((sentenceIndex / 40) * totalTokens));
    onSnapshot({
      sessionGeneration: generation,
      seq,
      state,
      decision,
      confirmedToken: Math.max(0, token - 2),
      observedToken: token,
      // Only a following mock claims a rate; anything else would have the
      // stage extrapolating through a hold, which is the exact behaviour the
      // real engine is careful never to produce.
      rateTokensPerSecond: state === 'following' ? 2.5 : 0,
      evidenceAudioMs: audioMs,
      atAudioMs: audioMs,
      maxPredictionMs: 900,
  pauseOnsetMs: 1800,
  leadFloorMs: 550,
  maxLeadTokens: 2.5,
  displayLimitToken: totalTokens,
      confidence,
      suggestionToken: null,
      scriptLenTokens: totalTokens,
      observedAtom: token,
      confirmedAtom: Math.max(0, token - 2),
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
    audioMs += 1600;
    // Every sixth tick, wobble into a brief "holding" to exercise the UI.
    if (tick % 6 === 5) {
      emit('holding', 'holdLowEvidence', 0.42);
      return;
    }
    const limit = sentences.length > 0 ? sentences.length - 1 : 39;
    if (sentenceIndex < limit) sentenceIndex += 1;
    onTranscript(transcriptLine());
    emit('following', 'localConfirmed', 0.86);
  }

  return {
    start() {
      emit('following', 'localObserved', 0.9);
      timer = setInterval(step, 1600);
    },
    pause() {
      paused = true;
      emit('holding', 'holdLowEvidence', 1);
    },
    resume() {
      paused = false;
      emit('following', 'localObserved', 0.85);
    },
    moveSentences(delta: number) {
      const limit = sentences.length > 0 ? sentences.length - 1 : 39;
      sentenceIndex = Math.max(0, Math.min(limit, sentenceIndex + delta));
      emit('following', 'manualAnchor', 0.95);
    },
    restartParagraph() {
      sentenceIndex = Math.max(0, sentenceIndex - 2);
      emit('following', 'manualAnchor', 0.95);
    },
    moveToToken(tokenIndex: number) {
      let best = 0;
      sentences.forEach((s, i) => {
        if (s.startTokenIndex <= tokenIndex) best = i;
      });
      sentenceIndex = best;
      emit('following', 'manualAnchor', 0.95);
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
