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
 *     confidence, script progress — every tracking tick;
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
} from '../../shared/coaching/integration';
import { initialHostState } from '../../shared/coaching/integration';
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
  /** The capture stream the pipeline already owns (§5.3). Never acquired here. */
  stream: MediaStreamLike;
  /** The take pass id at session start. */
  takePassId: string;
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

  constructor(deps: CoachingSessionDeps) {
    this.deps = deps;
    this.totalUnits = deps.compiled?.spokenTokens.length ?? 0;

    const audioClock: AudioClock = { nowMs: () => this.analyzerNowMs };
    const host: CoachingHostState = {
      ...initialHostState(deps.sessionId, deps.takePassId),
      // §11: the token → line map is a fact of the compiled script; without it
      // there are no gutter marks.
      ...(deps.compiled ? { lineForToken: this.buildLineForToken(deps.compiled) } : {}),
    };

    this.orchestrator = new CoachingOrchestrator({
      sessionId: deps.sessionId,
      audioClock,
      settings: deps.settings,
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
    return this.deps.settings.precisionTranscriptionMode !== 'off';
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
    this.lastTokenIndex = tracking.tokenIndex;
    const scriptProgress = this.scriptProgressFrom(tracking);
    try {
      this.orchestrator.setHostState({
        alignmentConfidence: tracking.alignmentConfidence,
        reacquiring: tracking.reacquiring,
        commandActive: tracking.commandActive,
        activeScriptSpanId: tracking.activeScriptSpanId,
        // §5.4/§20.5. The real epoch, pushed every snapshot. Safe to propagate
        // now that the disfluency lane distinguishes a jump from a new take
        // pass: an epoch change drops queued and in-flight coaching state and
        // leaves the presenter's cumulative filler total standing.
        trackingEpoch: tracking.trackingEpoch,
        ...(scriptProgress ? { scriptProgress } : { scriptProgress: null }),
      });
      // Drive the schedule so a silent stretch still ages tips and publishes.
      this.orchestrator.tick();
    } catch {
      /* §5.2 */
    }
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
    return {
      spanId: host.activeScriptSpanId,
      // The cursor token drives gutter-mark anchoring; `lineForToken` maps the
      // stringified index back to a sentence-line. `null` when the cursor is
      // not trustworthy, so §11.2's "never invent a position" holds.
      scriptAnchorTokenId: trustworthy ? String(this.lastTokenIndex) : null,
      text: '',
      alignmentUnreliable: !trustworthy,
    };
  }

  /** §11.3. Start a new take pass. Nothing crosses the boundary. */
  beginTakePass(takePassId: string): void {
    if (this.disposed) return;
    try {
      this.orchestrator.beginTakePass(takePassId, this.analyzerNowMs);
      this.analyzer?.reset();
    } catch {
      /* §5.2 */
    }
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
