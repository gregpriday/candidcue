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
import { ALIGNMENT_RELOCATIONS } from '../../shared/contracts';
import {
  reacquireAlignment,
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
  /**
   * "Re-find me here" — the follower is wrong and the reader is somewhere in
   * the visible range.
   *
   * Deliberately NOT `moveToToken(confirmedToken)`, which is what this used to
   * be: that asks the engine to look exactly where it is already looking, which
   * is the one place it is demonstrably not finding the reader. See
   * `Engine::reacquire`.
   */
  reacquire(): void;
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
   *
   * What the gate holds back is the VOICE. A `manualAnchor` is the engine's
   * answer to a move the operator made — a sentence step, a section jump, a
   * hand scroll — and it passes whether or not following is on. Dropping it
   * here is what made ⌥→ dead while paused: the engine moved, the glass and
   * the take's ending did not, and `currentSentenceIndex` kept counting from
   * the stale snapshot, so every press aimed at the same sentence. Following
   * off is the state a presenter picks to drive the script by hand, which
   * made it the worst place for those keys to stop working.
   */
  let prompting = false;

  const stopSnapshots = subscribeAlignmentSnapshots((snapshot) => {
    if (disposed) return;
    if (!prompting && snapshot.decision !== 'manualAnchor') return;
    if (snapshot.sessionGeneration !== generation) return;
    const previous = lastSnapshot;
    lastSnapshot = snapshot;
    // Every committed advance, once. This is the line that distinguishes "the
    // aligner is following" from "the stage is coasting on pace".
    // A relocation names its decision, as its own line: a forward jump moves
    // `observed` and may leave `confirmed` where it was, so riding the
    // confirmed line below would miss it. The one time a take ran away — 636
    // tokens forward on two partials — the trace showed the landing and
    // nothing about how it got there, and the reason had to be reconstructed
    // from the script.
    if (ALIGNMENT_RELOCATIONS.has(snapshot.decision)) {
      trace(
        'relocation',
        `${snapshot.decision} to token ${snapshot.observedToken.toFixed(1)} ` +
          `confidence ${snapshot.confidence.toFixed(2)}`,
      );
    } else if (
      snapshot.decision === 'holdOffScreen' &&
      previous?.decision !== 'holdOffScreen'
    ) {
      // The leash refused a place the words fit. Logged once per streak, with
      // where it would have gone, so a held display can be told apart from a
      // silent one after the fact. Independent of the state line: the first
      // refusal usually IS the moment following turns to holding.
      const at = snapshot.suggestionToken === null ? '?' : snapshot.suggestionToken.toFixed(0);
      trace('leash', `held: the words fit near token ${at}, which is off the glass`);
    }
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

  /*
   * The engine is installed asynchronously, and positions must wait for it.
   *
   * `start_alignment` awaits a database-backed language lookup before it
   * installs the engine, while `set_alignment_position` returns `Ok(())`
   * whether or not there is a session to position — it simply does nothing when
   * there is not. So a `moveTo` issued in the same tick as the driver was built
   * reached Rust, reported success, and was dropped on the floor.
   *
   * That was invisible until takes could start somewhere other than the top:
   * the opening anchor is issued immediately, so a take asked to begin at a
   * section left the aligner searching from token zero while the glass showed
   * the section — and the most likely outcome is a confident relocation
   * BACKWARDS to a similar-sounding opening.
   *
   * Every `moveTo` waits on this, not just the opening one: an operator who
   * steps a sentence in the first moments of a take had the same race.
   */
  const alignmentReady = startAlignment(generation, compiled).catch((error) => {
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
    // `disposed` is re-checked after the wait: the take can end between a move
    // being asked for and the engine being ready to hear it.
    void alignmentReady
      .then(() => (disposed ? undefined : setAlignmentPosition(tokenIndex)))
      .catch(() => {
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
    reacquire() {
      void reacquireAlignment().catch(() => {
        // A reacquisition that cannot reach Rust leaves the engine exactly as
        // it was, which is the state the presenter was complaining about —
        // but it is not worth a dialog mid-take, and the toast has already
        // said "re-finding your place".
      });
    },
    dispose() {
      disposed = true;
      prompting = false;
      stopSnapshots();
      /*
       * STOP AFTER THE START HAS FINISHED, NOT DURING IT.
       *
       * `start_alignment` awaits a database-backed language lookup and then
       * installs the engine unconditionally. A stop issued while that is still
       * in flight can run FIRST, after which the old startup installs its
       * engine into an app that has no take — an orphan that the next take then
       * finds already there, or that overwrites the next take's own.
       *
       * Waiting costs nothing here: the take is already over, snapshots are
       * already unsubscribed, and `stopAlignment` is idempotent. The `.catch`
       * on `alignmentReady` means a failed start resolves rather than rejects,
       * so this always runs.
       */
      void alignmentReady.then(() => stopAlignment()).catch(() => {});
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
  'Speaking Glass keeps your place while you talk.',
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
  leadMarginTokens: 1.2,
  leadEaseMs: 450,
  leadHoldMs: 0,
  leadDecayMs: 1200,
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
    reacquire() {
      /*
       * The mock mirrors the REAL behaviour, which is the point of it being a
       * separate method at all: a reacquisition goes to `searching` and holds,
       * it does not assert a lock. A mock that emitted `following` at 0.95
       * here would be stronger than production, and a mock being stronger than
       * production is exactly what hid the conflict branch in the editor.
       */
      emit('searching', 'noEvidence', 0);
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
