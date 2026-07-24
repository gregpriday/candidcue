/**
 * §12.2 control-side driver for the coaching subsystem.
 *
 * The orchestrator (`shared/coaching/integration`) is pure and injected: it
 * cannot open a microphone, read a store, or touch the DOM. This module is the
 * thing the spec's §5.2 note describes as "the session store's job" — it
 *
 *   - constructs the orchestrator from the persisted {@link CoachingSettings};
 *   - fans the *already-open* capture stream a third time, into the coaching
 *     worklet, and pumps `handleFrame` from it (§5.3);
 *   - feeds finalized transcript from the voice pipeline (fillers + pace);
 *   - pushes {@link CoachingHostState} — visibility, mirror, alignment
 *     confidence, script progress, and the §9.4/§14.8 sentence-cursor facts —
 *     every tracking tick;
 *   - forwards each published {@link CoachRailState} to an injected sink, which
 *     the session store points at the stage transport.
 *
 * ---------------------------------------------------------------------------
 * ADVISORY ONLY (§2.1) AND FAILURE-ISOLATED (§5.2)
 * ---------------------------------------------------------------------------
 * There is no return path from anything here into motion: the only output is a
 * `CoachRailState` to the sink. Every entry point is wrapped so a throw in the
 * coaching subsystem can never propagate into the caller's session loop — a
 * dead coaching process must leave the scroll running.
 *
 * ---------------------------------------------------------------------------
 * ONE CLOCK (§5.4)
 * ---------------------------------------------------------------------------
 * The orchestrator's only clock is {@link CoachingAnalyzerHandle.currentTimeMs},
 * the analysis `AudioContext`'s time — the same hardware clock the worklet
 * stamps frames from. Transcript items arrive stamped in wall-clock ms from the
 * ledger, which is a different scale entirely; feeding those in raw would jam
 * the orchestrator's monotonic clock to `Date.now()` and make every subsequent
 * frame look ancient. So transcript evidence is re-stamped onto the audio clock
 * at arrival: the finalized text describes audio that ended ~now, and the rail
 * is time-relative, so an approximate-but-monotonic audio stamp is correct
 * where a precise wall stamp would be actively wrong.
 */
import type {
  CoachRailState,
  CoachingSettings,
  ScriptProgress,
} from '../../shared/contracts/coaching';
import type { CompiledScript } from '../../shared/contracts';
import { CoachingOrchestrator } from '../../shared/coaching/integration';
import type {
  AudioClock,
  CoachingHostState,
  CoachingLaneFailure,
  ScriptDirectiveMap,
} from '../../shared/coaching/integration';
import {
  FIRST_TAKE_PASS_ORDINAL,
  applyCoachFrontMatter,
  authoredSpanWindow,
  buildAuthoredSpans,
  initialHostState,
  normalizeTakePassOrdinal,
  parseTakePassId,
  resolveScriptDirectives,
  takePassIdFor,
} from '../../shared/coaching/integration';
import { STRICT_FILLER_FORMS } from '../../shared/coaching/disfluency/filler-lexicon';
import { DEFAULT_PACE_PROFILE } from '../../shared/coaching/pace/pace-analyzer';
import type { CoachObserverTransport } from '../../shared/coaching/coach/luna-observer';
import type {
  AuthoredSpanContext,
  RealtimeTranscriptItem,
} from '../../shared/coaching/disfluency/types';
import type { SpokenSegment, SpokenWord } from '../../shared/coaching/pace/token-timing';
import type { RingBufferClearReason } from '../../shared/coaching/audio/ring-buffer';
import type { AudioFrameFeatures } from '../../shared/contracts/coaching';
import {
  startCoachingAnalyzer,
  type CoachingAnalyzerHandle,
  type CoachingAnalyzerNotice,
} from './coaching-analyzer';
import type { MediaStreamLike } from './audio';

/** §22. The bounded authored-sentence window carried on the host state. */
type AuthoredSpanWindow = CoachingHostState['authoredSpans'];

/**
 * §14.8. How long an observed sentence boundary keeps a pace tip eligible, ms.
 *
 * §14.8 asks for "at least one sentence boundary has passed" alongside "pace
 * has remained above the fast threshold for at least 6 seconds". The two
 * clauses describe the *same* stretch of delivery: the point is that the
 * sustained reading spanned a boundary rather than being one long clause taken
 * at a gallop. So the window is the tip's own persistence requirement, read off
 * the profile the pace lane actually runs with rather than restated as a
 * number here — a boundary older than the evidence window is not part of the
 * evidence the tip rests on.
 *
 * Deliberately *not* a latch that stays set for the rest of the take: that
 * would make the gate read "not the very first sentence", which is a gate in
 * name only.
 */
const BOUNDARY_EVIDENCE_WINDOW_MS = Math.max(
  DEFAULT_PACE_PROFILE.fastTipPersistenceMs,
  DEFAULT_PACE_PROFILE.slowTipPersistenceMs,
);

/**
 * §9.4. How far into a sentence still counts as a low-load moment: "during the
 * first third of a new sentence", which also covers "immediately after a
 * sentence boundary" — the cursor's first token of a sentence is both.
 */
const SAFE_MOMENT_SENTENCE_FRACTION = 1 / 3;

/** A finalized transcript item, in the shape the voice pipeline already emits. */
export interface CoachingTranscriptItem {
  itemId: string;
  commitSequence: number;
  transcript: string;
  turnStart?: boolean;
}

/** Live tracking facts the orchestrator cannot compute (§5.4, §14.10). */
export interface CoachingTrackingState {
  tokenIndex: number;
  alignmentConfidence: number;
  reacquiring: boolean;
  commandActive: boolean;
  /** Authored span the presenter is on, or `null`. Never a token id (§26.5). */
  activeScriptSpanId: string | null;
  /**
   * §5.4. The tracking engine's semantic epoch — bumped by a command jump, a
   * retake, or a re-anchor.
   *
   * This is what makes §23.1's staleness rules fireable at all: without it the
   * orchestrator's epoch never moves, so an in-flight Luna answer computed
   * against the pre-jump position can still be applied after the jump, and a
   * candidate queued before it can still become a tip.
   */
  trackingEpoch: number;
}

export interface CoachingSessionDeps {
  sessionId: string;
  settings: CoachingSettings;
  compiled: CompiledScript | null;
  /**
   * §22. The script this take is reading, and the stored revision it was
   * compiled from — both fields of the outbound `LunaCoachRequest`.
   *
   * The compiled document is the authority for the id and is preferred when it
   * is present; this is the fallback for the browser-dev path where nothing
   * compiled. There is no fallback for the revision: a `CompiledScript` does
   * not carry one, so it is handed down or it is unknown (0).
   */
  scriptId?: string;
  scriptRevision?: number;
  /** The capture stream the pipeline already owns (§5.3). Never acquired here. */
  stream: MediaStreamLike;
  /**
   * §36.3. The pass ordinal this session starts on. Defaults to the first.
   *
   * An *ordinal*, not an id: the id is minted from it by
   * {@link takePassIdFor}, the one authoritative scheme, so the coaching lane
   * and the take history cannot name the same pass differently.
   */
  initialPassOrdinal?: number;
  /**
   * @deprecated Supply {@link initialPassOrdinal} instead.
   *
   * The take-pass *id* at session start. Retained so the session store's
   * existing call site keeps compiling; the ordinal is recovered from it and
   * the id is re-minted, so a foreign scheme cannot enter through here. An
   * unparseable value falls back to the first pass rather than being adopted.
   */
  takePassId?: string;
  /** §27. Each published rail snapshot. The store points this at the stage. */
  publish: (state: CoachRailState) => void;
  /** §20.3. A budgeted Luna transport, or omit for local-only coaching. */
  lunaTransport?: CoachObserverTransport;
  lunaMode?: 'standard' | 'enhanced';
  /** §20.3. Vetoes every Luna call — the session's shared semantic budget. */
  isBudgetExhausted?: () => boolean;
  /** §5.2. Reported when a lane throws, disabled or not. */
  onLaneFailure?: (failure: CoachingLaneFailure) => void;
  /** Analyzer watchdog / keep-alive escalations, surfaced for diagnostics. */
  onAnalyzerNotice?: (notice: CoachingAnalyzerNotice) => void;
  /**
   * §12.6: PCM retained only for the Precision transcription modes. Derived
   * from the settings by default.
   */
  retainPcm?: boolean;
  /** Injected for tests; defaults to the real Web Audio analyzer. */
  startAnalyzer?: typeof startCoachingAnalyzer;
}

/**
 * §9.4/§14.8. Sentence id → inclusive spoken-token range, from the compiler.
 *
 * `null` compiled script yields an empty map, which reads as "no sentence
 * geometry": no safe moment is ever claimed, rather than one being guessed.
 */
function buildSentenceRanges(
  compiled: CompiledScript | null | undefined,
): ReadonlyMap<string, { start: number; end: number }> {
  const ranges = new Map<string, { start: number; end: number }>();
  for (const sentence of compiled?.sentences ?? []) {
    ranges.set(sentence.id, {
      start: sentence.startTokenIndex,
      end: sentence.endTokenIndex,
    });
  }
  return ranges;
}

/**
 * §36.3. The pass ordinal this controller starts on.
 *
 * `initialPassOrdinal` is the supported input. The deprecated `takePassId` is
 * accepted only so the store's existing call site compiles, and even then only
 * its *ordinal* is taken — an id in some other scheme cannot be adopted, it
 * falls back to the first pass.
 */
function initialPassOrdinal(deps: CoachingSessionDeps): number {
  if (deps.initialPassOrdinal !== undefined) {
    return normalizeTakePassOrdinal(deps.initialPassOrdinal);
  }
  if (deps.takePassId === undefined) return FIRST_TAKE_PASS_ORDINAL;
  return parseTakePassId(deps.takePassId)?.passOrdinal ?? FIRST_TAKE_PASS_ORDINAL;
}

/**
 * Owns the orchestrator, the analyzer graph, and the host-state feed for one
 * live session. Constructed at session start and disposed on stop.
 */
export class CoachingSessionController {
  private readonly orchestrator: CoachingOrchestrator;
  private readonly deps: CoachingSessionDeps;
  private analyzer: CoachingAnalyzerHandle | null = null;
  private analyzerNowMs = 0;
  private disposed = false;
  private started = false;
  /** §14.10 unit total, from the compiled script. */
  private readonly totalUnits: number;
  /** Last cursor token index, so a transcript item anchors to the live line. */
  private lastTokenIndex = 0;
  /** §19.4 authored directives, resolved to span ids by the compiler. */
  private readonly directives: ScriptDirectiveMap;
  /** §19.5. The persisted settings with the script's front matter applied. */
  private readonly settings: CoachingSettings;
  /**
   * §9.4/§14.8. Authored sentence id → its inclusive spoken-token range.
   *
   * The tracking snapshot reports the sentence the cursor is in and the token
   * index inside it; the *shape* of that sentence is a fact of the compiled
   * script, so it is read once here rather than asked of the engine.
   */
  private readonly sentenceRanges: ReadonlyMap<string, { start: number; end: number }>;
  /** The sentence the cursor was in at the previous snapshot, or `null`. */
  private previousSentenceId: string | null = null;
  /** Audio-clock time of the last boundary the presenter actually crossed. */
  private boundaryCrossedAtMs: number | null = null;
  /** §17.9. Forward sentence boundaries crossed this take pass. */
  private completedSentences = 0;
  /** The epoch the previous snapshot was read under (§5.4). */
  private lastTrackingEpoch = 0;
  /** §36.3. The pass ordinal this controller is currently on. */
  private passOrdinal: number;
  /**
   * §20.4/§22. One authored span per sentence of the compiled script.
   *
   * Built once — the script does not move, only the cursor does — so the
   * per-snapshot cost of §22 is a three-element slice.
   */
  private readonly authoredSpans: ReturnType<typeof buildAuthoredSpans>;
  /** The span id the last `authoredSpans` window was pushed for. */
  private lastAuthoredSpanId: string | null = null;

  constructor(deps: CoachingSessionDeps) {
    this.deps = deps;
    this.totalUnits = deps.compiled?.spokenTokens.length ?? 0;
    this.sentenceRanges = buildSentenceRanges(deps.compiled);

    // §19.5 first, then §19.4: an authored pace directive is judged against the
    // band the session will actually run with, which the front matter may have
    // just moved.
    this.settings = applyCoachFrontMatter(deps.settings, deps.compiled?.coaching?.frontMatter);
    this.directives = resolveScriptDirectives(deps.compiled?.coaching, this.settings);

    const audioClock: AudioClock = { nowMs: () => this.analyzerNowMs };
    /*
     * B3. `initialHostState`'s first parameter is `scriptId`, and this used to
     * hand it `deps.sessionId` — so `CoachingHostState.scriptId` was the
     * SESSION id, and it went out that way in every `LunaCoachRequest`
     * alongside a `scriptRevision` that never moved off its initial 0.
     *
     * Nothing on this side reads either field, which is why it survived: the
     * local lanes key off `sessionId` and `trackingEpoch`. They are read on the
     * wire, where a request that names the session as its script cannot be
     * correlated with the script it is actually about.
     */
    const scriptId = deps.compiled?.scriptId ?? deps.scriptId ?? '';
    this.passOrdinal = initialPassOrdinal(deps);
    this.authoredSpans = buildAuthoredSpans(
      deps.compiled,
      this.directives.coachingDisabledSpanIds,
    );
    const host: CoachingHostState = {
      ...initialHostState(scriptId, takePassIdFor(deps.sessionId, this.passOrdinal)),
      scriptRevision: deps.scriptRevision ?? 0,
      // §19.4: the disabled set is a property of the script, not of the cursor,
      // so it is pushed once and never recomputed per frame.
      coachingDisabledSpanIds: this.directives.coachingDisabledSpanIds,
      // §11: the token → line map is a fact of the compiled script; without it
      // there are no gutter marks.
      ...(deps.compiled ? { lineForToken: this.buildLineForToken(deps.compiled) } : {}),
    };

    this.orchestrator = new CoachingOrchestrator({
      sessionId: deps.sessionId,
      audioClock,
      settings: this.settings,
      host,
      publish: (state) => this.forward(state),
      ...(deps.lunaTransport ? { lunaTransport: deps.lunaTransport } : {}),
      ...(deps.lunaMode ? { lunaMode: deps.lunaMode } : {}),
      ...(deps.isBudgetExhausted ? { isBudgetExhausted: deps.isBudgetExhausted } : {}),
      ...(deps.onLaneFailure ? { onLaneFailure: deps.onLaneFailure } : {}),
    });
  }

  /**
   * Attach the analyzer and begin pumping frames. A failure to attach is a lost
   * audio lane, never a session failure (§5.2): the promise resolves either way
   * and the caller keeps running.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const startAnalyzer = this.deps.startAnalyzer ?? startCoachingAnalyzer;
    try {
      this.analyzer = await startAnalyzer({
        stream: this.deps.stream,
        retainPcm: this.deps.retainPcm ?? this.retainPcmFromSettings(),
        onFrames: (frames) => this.handleFrames(frames),
        ...(this.deps.onAnalyzerNotice ? { onNotice: this.deps.onAnalyzerNotice } : {}),
      });
      if (this.disposed) {
        // Session stopped while the graph was building.
        await this.analyzer.close();
        this.analyzer = null;
      }
    } catch {
      // The rail simply runs without the audio lane; transcript-driven filler
      // and pace coaching are untouched because they never pass through here.
      this.analyzer = null;
    }
  }

  /** §5.4. The audio clock the whole subsystem shares, ms. */
  audioTimeMs(): number {
    return this.analyzerNowMs;
  }

  private retainPcmFromSettings(): boolean {
    // Deliberately the *persisted* setting, not the front-matter overlay: §19.5
    // may not switch on a mode that spends the user's API budget.
    return this.deps.settings.precisionTranscriptionMode !== 'off';
  }

  /**
   * §19.4. The authored suppressions in force at the presenter's current span.
   *
   * Recomputed per tracking snapshot rather than cached, because the span is
   * the only thing that moves — the sets themselves are fixed for the script.
   */
  private spanDirectives(spanId: string | null): {
    authoredFastSection: boolean;
    suppressSlowTip: boolean;
    suppressVarietyCoaching: boolean;
  } {
    if (spanId === null) {
      return {
        authoredFastSection: false,
        suppressSlowTip: false,
        suppressVarietyCoaching: false,
      };
    }
    return {
      authoredFastSection: this.directives.authoredFastSpanIds.has(spanId),
      suppressSlowTip: this.directives.suppressSlowTipSpanIds.has(spanId),
      suppressVarietyCoaching: this.directives.suppressVarietySpanIds.has(spanId),
    };
  }

  /**
   * §9.4 / §14.8 / §17.9. The three facts that fall out of watching the
   * alignment cursor move through the script's sentences.
   *
   * The tracking engine reports which sentence the cursor is in, not that a
   * boundary went past; "a boundary passed" is the *transition* between two
   * snapshots, and it is only real when the presenter actually read across it:
   *
   * - both sides must be known sentences. Acquiring the cursor for the first
   *   time, or losing it, is not a boundary;
   * - the cursor must have moved **forward**. A sentence change with the cursor
   *   standing still or going backwards is a re-anchor, not delivery;
   * - the engine must not be reacquiring, and the epoch must not have moved. A
   *   command jump, a retake, or a re-anchor relocates the cursor across any
   *   number of boundaries the presenter never spoke, and §5.4 says evidence
   *   taken across that seam describes a different performance.
   *
   * The last clause is what keeps §14.8 honest in the direction that matters:
   * the boundary at the end of the sentence the presenter is *currently in* has
   * not been crossed yet, and nothing here reports it as though it had.
   */
  private observeSentenceCursor(tracking: CoachingTrackingState): {
    safeMoment: boolean;
    sentenceBoundaryPassed: boolean;
    completedSentences: number;
  } {
    const spanId = tracking.activeScriptSpanId;
    const nowMs = this.analyzerNowMs;

    const epochMoved = tracking.trackingEpoch !== this.lastTrackingEpoch;
    this.lastTrackingEpoch = tracking.trackingEpoch;
    if (epochMoved) this.boundaryCrossedAtMs = null;

    const crossed =
      !epochMoved &&
      !tracking.reacquiring &&
      spanId !== null &&
      this.previousSentenceId !== null &&
      spanId !== this.previousSentenceId &&
      tracking.tokenIndex > this.lastTokenIndex;
    if (crossed) {
      this.boundaryCrossedAtMs = nowMs;
      this.completedSentences += 1;
    }
    this.previousSentenceId = spanId;

    return {
      safeMoment: !tracking.reacquiring && this.inOpeningThird(spanId, tracking.tokenIndex),
      sentenceBoundaryPassed:
        this.boundaryCrossedAtMs !== null &&
        nowMs - this.boundaryCrossedAtMs <= BOUNDARY_EVIDENCE_WINDOW_MS,
      completedSentences: this.completedSentences,
    };
  }

  /**
   * §9.4 second bullet. Whether the cursor sits in the opening third of its
   * sentence — the low-load moment a tip is allowed to land in.
   *
   * A sentence the compiled script does not know, or a cursor outside the
   * sentence it claims to be in, is not a safe moment: §9.4 is an assertion
   * about where the presenter is, and we would be guessing.
   */
  private inOpeningThird(spanId: string | null, tokenIndex: number): boolean {
    if (spanId === null) return false;
    const range = this.sentenceRanges.get(spanId);
    if (range === undefined) return false;
    const length = range.end - range.start + 1;
    if (length <= 0) return false;
    const offset = tokenIndex - range.start;
    if (offset < 0 || offset >= length) return false;
    return offset < Math.max(1, Math.ceil(length * SAFE_MOMENT_SENTENCE_FRACTION));
  }

  private handleFrames(frames: AudioFrameFeatures[]): void {
    if (this.disposed) return;
    for (const frame of frames) {
      if (frame.audioTimeMs > this.analyzerNowMs) this.analyzerNowMs = frame.audioTimeMs;
      try {
        this.orchestrator.handleFrame(frame);
      } catch {
        /* §5.2: a defect in the frame path must not stop the session. */
      }
    }
  }

  /**
   * Push the live tracking facts every snapshot. Cheap and idempotent — the
   * orchestrator diffs the patch and only touches a lane when the relevant
   * field actually changed.
   */
  setTrackingState(tracking: CoachingTrackingState): void {
    if (this.disposed) return;
    const cursor = this.observeSentenceCursor(tracking);
    this.lastTokenIndex = tracking.tokenIndex;
    const scriptProgress = this.scriptProgressFrom(tracking);
    try {
      this.orchestrator.setHostState({
        alignmentConfidence: tracking.alignmentConfidence,
        reacquiring: tracking.reacquiring,
        commandActive: tracking.commandActive,
        activeScriptSpanId: tracking.activeScriptSpanId,
        // §9.4 / §14.8 / §17.9. Everything the cursor's sentence tells us.
        ...cursor,
        // §19.4. The authored suppressions for the span the presenter is on.
        ...this.spanDirectives(tracking.activeScriptSpanId),
        // §5.4/§20.5. The real epoch, pushed every snapshot. Safe to propagate
        // now that the disfluency lane distinguishes a jump from a new take
        // pass: an epoch change drops queued and in-flight coaching state and
        // leaves the presenter's cumulative filler total standing.
        trackingEpoch: tracking.trackingEpoch,
        // §20.4/§22. The 1–3 authored sentences around the cursor. Recomputed
        // only when the presenter actually moved to a different sentence: the
        // window is a function of the span alone, and pushing an identical
        // array every snapshot would churn the host state 50 times a second.
        ...this.authoredSpanPatch(tracking.activeScriptSpanId),
        ...(scriptProgress ? { scriptProgress } : { scriptProgress: null }),
      });
      // Drive the schedule so a silent stretch still ages tips and publishes.
      this.orchestrator.tick();
    } catch {
      /* §5.2 */
    }
  }

  /**
   * §20.4/§22. The authored-span window for `spanId`, or nothing when the
   * cursor has not left the sentence it was already in.
   */
  private authoredSpanPatch(spanId: string | null): { authoredSpans?: AuthoredSpanWindow } {
    if (spanId === this.lastAuthoredSpanId) return {};
    this.lastAuthoredSpanId = spanId;
    return { authoredSpans: authoredSpanWindow(this.authoredSpans, spanId) };
  }

  /** §7.1 / §27. Rail visibility and mirror state, pushed from the stage settings. */
  setDisplayState(patch: {
    visible?: boolean;
    mirrored?: boolean;
    reducedMotion?: boolean;
  }): void {
    if (this.disposed) return;
    try {
      this.orchestrator.setHostState(patch);
    } catch {
      /* §5.2 */
    }
  }

  /**
   * §16.1/§14.2. A finalized transcript item, re-stamped onto the audio clock.
   *
   * Feeds both the disfluency lane (filler detection on the live transcript,
   * the Basic-mode path) and the pace lane (WPM). Provisional text is
   * deliberately not forwarded from here: §16.1 forbids it from producing a
   * visible tick, and the cheapest guarantee is to never build one.
   */
  noteFinalTranscript(item: CoachingTranscriptItem): void {
    if (this.disposed) return;
    const text = item.transcript.trim();
    if (text.length === 0) return;
    const nowMs = this.analyzerNowMs;
    const words = text.split(/\s+/u).filter((w) => w.length > 0);
    if (words.length === 0) return;
    // Estimate the item's audio span backward from now at a nominal reading
    // rate. Only the *ordering* and the audio-clock scale matter to the rail.
    const estimatedMs = Math.max(200, words.length * 300);
    const audioStartMs = Math.max(0, nowMs - estimatedMs);
    const audioEndMs = nowMs;

    const authored = this.authoredContext(item);
    const realtimeItem: RealtimeTranscriptItem = {
      itemId: item.itemId,
      commitSequence: item.commitSequence,
      audioStartMs,
      audioEndMs,
      text,
      ...(item.turnStart ? { turnStart: true } : {}),
    };
    const segment = this.segmentFrom(item, words, audioStartMs, audioEndMs, authored);

    try {
      this.orchestrator.noteFinalTranscript(realtimeItem, authored);
      this.orchestrator.noteTranscriptSegment(segment);
    } catch {
      /* §5.2 */
    }
  }

  private segmentFrom(
    item: CoachingTranscriptItem,
    words: string[],
    audioStartMs: number,
    audioEndMs: number,
    authored: AuthoredSpanContext,
  ): SpokenSegment {
    const spokenWords: SpokenWord[] = words.map((word) => ({
      text: word.toLowerCase(),
      excluded: false,
      confirmedFiller: false,
      repetition: false,
      ...(authored.scriptAnchorTokenId ? { scriptSpanId: authored.spanId } : {}),
    }));
    return {
      segmentId: item.itemId,
      words: spokenWords,
      audioStartMs,
      audioEndMs,
      final: true,
      commitSequence: item.commitSequence,
      takePassId: this.orchestrator.hostState().takePassId,
      confidence: this.orchestrator.hostState().alignmentConfidence,
    };
  }

  /**
   * The authored material aligned to a transcript item. `text` is `''` unless
   * the alignment is trustworthy: that makes every "absent from authored text"
   * insertion test fail closed, which is exactly what §16.1 wants when we do
   * not actually have the authored comparison in hand.
   */
  private authoredContext(_item: CoachingTranscriptItem): AuthoredSpanContext {
    const host = this.orchestrator.hostState();
    const trustworthy = host.alignmentConfidence >= 0.5;
    const spanId = host.activeScriptSpanId;
    return {
      spanId,
      // The cursor token drives gutter-mark anchoring; `lineForToken` maps the
      // stringified index back to a sentence-line. `null` when the cursor is
      // not trustworthy, so §11.2's "never invent a position" holds.
      scriptAnchorTokenId: trustworthy ? String(this.lastTokenIndex) : null,
      text: '',
      alignmentUnreliable: !trustworthy,
      // §19.4. `cc:coach off` stops the disfluency lane from producing an event
      // at all, rather than producing one and hiding it — an event that exists
      // reaches the post-take report, and the author said not here.
      ...(spanId !== null && this.directives.coachingDisabledSpanIds.has(spanId)
        ? { coachingDisabled: true }
        : {}),
      // §15.5 / §19.4. `cc:filler intentional` marks every vocalized filler in
      // the passage as authored delivery.
      ...(spanId !== null && this.directives.intentionalFillerSpanIds.has(spanId)
        ? { intentionalForms: STRICT_FILLER_FORMS }
        : {}),
    };
  }

  /**
   * §11.3/§36.3. Start a new take pass. Nothing crosses the boundary.
   *
   * Called from the take-history boundary in the session store with the same
   * `passOrdinal` the §36.3 row is opened with — the two lanes advance from one
   * number, and the id each of them ends up holding comes from the one
   * {@link takePassIdFor}. This is the caller `beginTakePass` never had: the
   * coaching lane used to keep counting into pass 1 for the whole session while
   * the take history opened pass 2, 3, 4.
   *
   * This is deliberately **not** driven by the tracking epoch. An epoch bump is
   * a *position* jump inside one take (command jump, re-anchor, automatic
   * retake); it invalidates position-sensitive state but leaves the presenter's
   * cumulative filler total standing, and `setHostState` already routes it to
   * the narrow reset. Only a real new pass reaches here.
   */
  beginTakePass(passOrdinal: number): void {
    if (this.disposed) return;
    // §11.3. The sentence history is take-pass state: the boundaries of the
    // previous pass were crossed in a performance this one does not inherit.
    this.previousSentenceId = null;
    this.boundaryCrossedAtMs = null;
    this.completedSentences = 0;
    // Kept in step with the id the orchestrator will mint, so the reported
    // ordinal and the stamped id can never describe different passes.
    this.passOrdinal = normalizeTakePassOrdinal(passOrdinal);
    try {
      this.orchestrator.beginTakePass(this.passOrdinal, this.analyzerNowMs);
      this.analyzer?.reset();
    } catch {
      /* §5.2 */
    }
  }

  /** §36.3. The pass ordinal this controller is on. */
  currentPassOrdinal(): number {
    return this.passOrdinal;
  }

  /** The take ended: run a last aggregation, clear the glass, drop retained PCM. */
  endTake(reason: RingBufferClearReason = 'take_end'): void {
    if (this.disposed) return;
    try {
      this.orchestrator.endTake();
    } catch {
      /* §5.2 */
    }
    try {
      this.analyzer?.clearBuffer(reason);
    } catch {
      /* §5.2 */
    }
  }

  /** §12.7. Microphone device loss, which outranks every acoustic reading. */
  setMicrophoneDisconnected(disconnected: boolean): void {
    if (this.disposed) return;
    try {
      this.orchestrator.noteMicrophoneDisconnected(disconnected);
    } catch {
      /* §5.2 */
    }
  }

  /** §25.1. The realtime transcription path itself is degraded. */
  setTranscriptionDegraded(degraded: boolean): void {
    if (this.disposed) return;
    try {
      this.orchestrator.noteTranscriptionDegraded(degraded);
    } catch {
      /* §5.2 */
    }
  }

  /** The most recent rail snapshot, or `null`. For diagnostics and tests. */
  lastRailState(): CoachRailState | null {
    return this.orchestrator.lastRailState();
  }

  /**
   * Diagnostics and test seam: the host state the orchestrator is reading.
   *
   * Read-only, and mirrors the orchestrator's own `hostState()`. Most of what
   * this module pushes in is observable on the published rail; `trackingEpoch`
   * is not, and "did the epoch actually reach the orchestrator" is the one
   * question a §23.1 staleness bug turns on.
   */
  hostState(): Readonly<CoachingHostState> {
    return this.orchestrator.hostState();
  }

  /**
   * Diagnostics and test seam: everything the orchestrator measured this pass,
   * including the candidates currently alive in the registry.
   *
   * §6.1/§6.5 keep analysing while publishing nothing, so the rail is not a
   * complete account of what the subsystem did — and "was this candidate
   * refused at the door" (§19.4) is invisible on the rail by construction,
   * because a refused candidate is precisely one that never shows.
   */
  telemetry(): ReturnType<CoachingOrchestrator['telemetry']> {
    return this.orchestrator.telemetry();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const analyzer = this.analyzer;
    this.analyzer = null;
    if (analyzer) {
      try {
        await analyzer.close();
      } catch {
        /* already torn down */
      }
    }
  }

  private forward(state: CoachRailState): void {
    if (this.disposed) return;
    // The orchestrator already swallows a throwing sink; this is the second
    // fence, so a stage-transport failure is contained here too (§5.2).
    try {
      this.deps.publish(state);
    } catch {
      /* the stage transport's problem, not the subsystem's */
    }
  }

  /**
   * §14.10. A target-duration projection needs the alignment cursor and the
   * total unit count. The engine owns the cursor; the compiled script owns the
   * total. A cursor the engine cannot trust yields no projection at all, which
   * is §14.10's explicit rule: a twitching projection is worse than none.
   */
  private scriptProgressFrom(tracking: CoachingTrackingState): ScriptProgress | null {
    if (this.totalUnits === 0) return null;
    const cursor = Math.max(0, Math.min(this.totalUnits, tracking.tokenIndex));
    return {
      cursorUnitIndex: cursor,
      totalUnits: this.totalUnits,
      remainingSpokenWordEquivalents: Math.max(0, this.totalUnits - cursor),
      confidence: tracking.alignmentConfidence,
      observedAtMs: this.analyzerNowMs,
      // The epoch this cursor belongs to is the one it was read under, not the
      // one the orchestrator happens to still be holding (§14.10, §5.4).
      trackingEpoch: tracking.trackingEpoch,
      reacquiring: tracking.reacquiring,
    };
  }

  /**
   * §11. Authored token id → line key. The cursor's `scriptAnchorTokenId` is a
   * stringified spoken-token index; a "line" is the sentence the token belongs
   * to, so two tokens in one sentence collapse to a single gutter mark. An id
   * that does not resolve to a token is returned unchanged — it becomes its own
   * line, which never merges two real lines by accident.
   */
  private buildLineForToken(compiled: CompiledScript): (tokenId: string) => string {
    const tokens = compiled.spokenTokens;
    return (tokenId: string): string => {
      const index = Number.parseInt(tokenId, 10);
      if (!Number.isFinite(index)) return tokenId;
      const token = tokens[index];
      return token ? token.sentenceId : tokenId;
    };
  }
}
