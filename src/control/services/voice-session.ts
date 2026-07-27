/**
 * Voice session pipeline — microphone in, transcript events out.
 *
 *   mic → PcmCapture (24 kHz PCM16) → Rust Inworld session
 *       → stt://event → transcript record + UI (alignment happens in Rust)
 *
 * This replaced a pipeline roughly four times its size, and almost everything
 * that went was machinery for deciding when a sentence had ended: a local
 * voice-activity detector, a noise-floor calibration, a speech gate, a commit
 * driver, and a manual `input_audio_buffer.commit`. Inworld endpoints
 * server-side, so a take now streams unconditionally and the provider says
 * where the utterances are.
 *
 * That is not a simplification for its own sake. Every one of those mechanisms
 * was a way to hold a completely healthy connection open and transcribe
 * nothing — a calibration that measured the presenter's own voice set the gate
 * above every word they subsequently said, and the session reported "words
 * heard: 0" over a socket in perfect health. None of them can fail that way now
 * because none of them exist.
 *
 * The local level meter survives, but only as a meter: it drives the "is it
 * hearing me" readout and the §28.6 dead-input detector. Nothing it decides can
 * stop audio reaching the recogniser.
 */
import type { AudioLevelSnapshot, CompiledScript } from '../../shared/contracts';
import { alignTokensFor, type AlignToken } from './alignment';
import { DEFAULT_SOFT_PAUSE_AUTO_DISCONNECT_MS } from './audio/defaults';
import { isTauriRuntime } from './ipc';
import { trace, traceBegin } from './audio-trace';
import {
  createAnalyserGraph,
  MicrophoneDeviceManager,
  MicrophoneMonitor,
  queryMicrophonePermission,
  releaseStream,
  requestMicrophoneAccess,
  SilentInputDetector,
  vadConfigForSensitivity,
  type MediaStreamLike,
} from './audio';
import { PcmCapture } from './audio/capture';
import {
  encodePcm16,
  pushTranscriptionAudio,
  startTranscription,
  stopTranscription,
  sttSessionOptions,
  STT_EVENT,
  type SttFrame,
} from './stt/inworld';

/** Timer seam so tests drive a virtual clock instead of waiting. */
export interface PipelineTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * §29.2 steps 1–3, as the *caller's* half of the start sequence.
 *
 * Each is a PRECONDITION CHECK rather than a second performance of the step:
 * flushing an already-flushed save is a no-op, and asking whether the compile
 * is current and the stage has acked is cheap and idempotent. Any of them
 * rejecting aborts the start before the microphone is opened or a session is
 * billed, and it lives here rather than in the screen that happens to precede
 * a take so a retake or a resume gets the same ordering.
 */
export interface StartSequenceGate {
  /** §29.2 step 1 — the script's pending save must be on disk. */
  flushScriptSave(): Promise<void>;
  /** §29.2 step 2 — a current compile with no blocking diagnostics. */
  ensureCompiled(): Promise<void>;
  /** §29.2 step 3 — the stage has hydrated and reported its layout ready. */
  awaitStageAck(): Promise<void>;
}

/** One finalized transcript item, ready for §36.2 retention. */
export interface FinalizedTranscriptItem {
  itemId: string;
  /** The ledger's local commit ordering — the row's uniqueness key in SQLite. */
  commitSequence: number;
  audioStartMs?: number;
  audioEndMs?: number;
  transcript: string;
}

export type ConnectionState = 'connected' | 'reconnecting' | 'offline';

export interface VoicePipelineDeps {
  sessionId: string;
  sessionGeneration: number;
  compiled: CompiledScript;
  /** BCP-47 locale for the recogniser, e.g. `en-US`. */
  language?: string;
  /** Inworld model id; omitted uses the backend default. */
  modelId?: string;
  deviceId?: string;
  /**
   * §28.3 capture processing — the user's Settings → Audio toggles, applied to
   * the one `getUserMedia` call the app makes.
   */
  audioProcessing?: {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
  /**
   * §28.4 "Local voice-detection sensitivity", 0–1 with 0.5 = the A.6 defaults.
   *
   * Meter-only now. It moves the threshold at which the UI says the microphone
   * can hear you and at which the dead-input detector gives up; it does not
   * gate a single byte of audio, because the recogniser does its own
   * endpointing and gating on top of that only loses words.
   */
  vadSensitivity?: number;
  /** Auto-disconnect after this long soft-paused (A.6). */
  softPauseAutoDisconnectMs?: number;
  /** §29.2 steps 1–3; optional only so a unit test can stand up a bare pipeline. */
  startSequence?: StartSequenceGate;
  /** §29.2 step 9 — transcript state above this layer goes too. */
  onResetTranscriptState?(): void;
  /** Finalized transcript items, for retention and the visible tail. */
  /**
   * Raw recogniser text, for the stage's transcript bar and the "did it hear
   * me" word count. NOT alignment input: the alignment engine is fed by Rust
   * directly from the same socket, so nothing on this path can starve it.
   */
  onTranscriptText(text: string, final: boolean): void;
  /** Final transcript lines for the Live transcript tail. */
  onTranscriptLine(line: string): void;
  /**
   * §36.2 retention feed: one finalized item with its commit ordering and audio
   * window. Text only — never audio. Separate from `onTranscriptLine` because
   * the tail is a four-line affordance and this is the durable record.
   */
  onTranscriptItem?(item: FinalizedTranscriptItem): void;
  onConnectionState(state: ConnectionState): void;
  /**
   * Following must visibly stop while transcription is untrustworthy — a
   * reconnect in progress, or dead input.
   */
  onFollowingHold?(held: boolean, reason: string | null): void;
  /** §28.6: the input device is gone; the user must pick another. */
  onInputDeviceLost?(code: string): void;
  /** §28.6: audio is flowing again — the counterpart to `onInputDeviceLost`. */
  onInputRestored?(): void;
  /**
   * §28.2: the pinned device was busy, so the system default was opened.
   *
   * Reported rather than absorbed. A take that quietly runs on the built-in
   * microphone when the user chose an interface is a take whose audio is not
   * what they think it is, and the only place that can be corrected is a screen
   * that has been told.
   */
  onInputFellBackToDefault?(): void;
  /** A session-level provider failure ended or interrupted the session. */
  onSessionFailure?(code: string, fatal: boolean): void;
  /** M3: soft pause will auto-disconnect in `msRemaining` (A.6). */
  onPauseWarning?(msRemaining: number): void;
  /**
   * Audio was captured but could not be forwarded — a reconnect in flight, or
   * a wedged socket. Surfaced rather than swallowed: silently dropped frames
   * are the difference between "the presenter said nothing" and "we threw away
   * what they said", and those look identical downstream.
   */
  onAudioDropped?(frames: number): void;
  /**
   * §5.3 single-capture fan-out. The one place in the app that opens the
   * microphone hands the resulting stream to any additional consumer, so no
   * second `getUserMedia` is ever issued.
   */
  onCaptureStream?(stream: MediaStreamLike): void;
  /**
   * Every level frame, unfiltered — the stage's voice pill draws from these.
   *
   * The same fan-out rule as `onCaptureStream` and for the same reason: an
   * indicator that opened its own capture to draw a waveform would contend with
   * the take's stream, and `services/audio/ownership.ts` measures that at 9.8
   * seconds to acquire against 908 ms uncontended. One microphone, one owner,
   * and everything else reads what the owner already has.
   *
   * Unlike `onInputDeviceLost` this fires on every frame rather than on a
   * transition, because its consumer is a waveform: a signal reported only when
   * it changes category cannot be drawn.
   */
  onLevel?(snapshot: AudioLevelSnapshot): void;
  /**
   * The device is about to be asked for — fired immediately before
   * `getUserMedia`, and again for every reacquisition (a device switch, a
   * resume from a hard pause).
   *
   * Exists so a consumer waiting on audio can time out against the ATTEMPT
   * rather than against the start of the take. Everything before this line —
   * the §29.2 gate, the permission query, the socket subscription — is time in
   * which no capture has been tried, and "no audio" measured from before the
   * request was made says something false about the microphone.
   */
  onCaptureAttempt?(): void;
  timers?: PipelineTimers;
  now?: () => number;
}

export class VoiceSessionPipeline {
  /**
   * Finalized utterances this session, by item id.
   *
   * All that survives of what used to be a full transcript ledger. Alignment
   * has its own, in Rust; what is still needed here is idempotence for the
   * things that are NOT idempotent — the retained transcript, the visible tail
   * and the word count. A provider that re-sends a final would otherwise show
   * the line twice and inflate "words heard" past what was said.
   */
  private readonly finalized = new Map<string, FinalizedTranscriptItem>();
  /** Monotonic commit ordering — the retained row's uniqueness key. */
  private commitSequence = 0;
  /** Audio-clock start of each open utterance, by item id. */
  private readonly itemStarts = new Map<string, number>();

  private monitor: MicrophoneMonitor | null = null;
  private capture: PcmCapture | null = null;
  private activeStream: MediaStreamLike | null = null;
  /**
   * Generation of the RUST session; `null` when none is open.
   *
   * Deliberately not the session generation. Rust mints its own per socket and
   * the two diverge the moment anything else opens a stream first — the
   * Preflight microphone test does exactly that. This one filters late frames
   * at the IPC edge; `deps.sessionGeneration` is what the ledger and the
   * aligner are keyed on.
   */
  private transportGeneration: number | null = null;
  /**
   * Control-window time at which the current capture began, so Rust's
   * zero-based audio clock can be expressed on the same clock as
   * `receivedAtMs`.
   */
  private audioOriginMs = 0;
  /**
   * Bumped by every teardown. Any `await` inside `start()` re-checks it, so a
   * stop that lands mid-start cannot be overtaken by the start it interrupted
   * and leave a microphone open on a session nobody asked for.
   */
  private lifecycle = 0;
  private unlistenStt: (() => void) | null = null;
  private stopped = false;
  private running = false;
  /**
   * True while soft-paused: audio is captured and deliberately not sent.
   *
   * A hard pause sets this too. It used not to, so `resume()` returned at its
   * first line and the caller went on to report a live microphone over a
   * session that had been torn down — the Live screen's "resume by click"
   * promise, silently unkept.
   */
  private paused = false;
  private pauseTimer: unknown | null = null;
  private lastConnectionState: ConnectionState | null = null;
  private following = true;

  /** §28.6 sustained no-signal detection on the captured stream. */
  private readonly silentInput = new SilentInputDetector();
  /** Frames handed to Rust this session; traced, not merely counted. */
  private framesSent = 0;
  /** True once this session has reached `connected` at least once. */
  private hasConnected = false;
  private deviceManager: MicrophoneDeviceManager | null = null;
  /** §28.2: a device chosen mid-session outranks `deps.deviceId`. */
  private deviceOverride: string | undefined;
  private stopDeviceWatch: (() => void) | null = null;
  private readonly timers: PipelineTimers;
  private readonly now: () => number;
  /**
   * Serializes `stt_audio` calls.
   *
   * Tauri dispatches invocations concurrently, so frames fired without awaiting
   * the previous one can reach Rust out of order — and audio delivered out of
   * order is not "slightly wrong", it is a transcript of a sentence with its
   * syllables shuffled. Chaining costs nothing at ten frames a second.
   */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VoicePipelineDeps) {
    this.timers = deps.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    };
    this.now = deps.now ?? (() => Date.now());
  }

  /** §29.2 start sequence. Billable streaming begins here. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('SESSION_STOPPED');
    // Steps 1–3 first: nothing billable begins on a session whose script,
    // compile or stage was not ready.
    if (this.deps.startSequence) {
      await this.deps.startSequence.flushScriptSave();
      await this.deps.startSequence.ensureCompiled();
      await this.deps.startSequence.awaitStageAck();
    }
    // Step 4, passive: only an explicit `denied` stops the sequence. Plenty of
    // WebViews do not answer the query at all, and `getUserMedia` resolves
    // permission implicitly there.
    if (!(await this.checkMicrophonePermission())) {
      throw new Error('MIC_PERMISSION_DENIED');
    }

    const epoch = this.lifecycle;
    traceBegin();
    trace('start', `sessionGeneration ${this.deps.sessionGeneration}`);
    this.running = true;
    this.paused = false;
    this.setConnectionState('reconnecting');
    // Before the microphone and before the session: a Tauri event is delivered
    // by evaluating JS in the target webview and is never queued, so a frame
    // emitted before this returns is lost outright.
    await this.subscribeToStt();

    try {
      // Every continuation re-checks the epoch. Without it a `stop()` that
      // lands between two awaits is overtaken by the start it interrupted, and
      // the take ends holding an open microphone and a billing socket.
      if (epoch !== this.lifecycle) throw new Error('SESSION_STOPPED');
      const stream = await this.acquireMicrophone(this.preferredDeviceId);
      trace('microphone', 'stream acquired');

      if (epoch !== this.lifecycle) throw new Error('SESSION_STOPPED');
      this.audioOriginMs = this.now();
      const options = this.sessionOptions();
      this.transportGeneration = await startTranscription(options);
      trace(
        'session',
        `transport ${this.transportGeneration} model ${options.modelId ?? 'default'} ` +
          `lang ${options.language ?? 'default'}`,
      );

      if (epoch !== this.lifecycle) throw new Error('SESSION_STOPPED');
      await this.startCapture(stream);
      trace('capture', `started at ${this.capture?.contextSampleRate ?? 0} Hz`);
    } catch (err) {
      trace('start-failed', err instanceof Error ? err.message : 'unknown');
      this.running = false;
      // A session opened and then abandoned bills for audio nobody is reading,
      // so it is closed on every failure after it exists — including the one
      // where capture is what failed.
      await this.closeSession();
      await this.teardownAudio();
      this.unlistenStt?.();
      this.unlistenStt = null;
      throw err;
    }
    this.watchDevices();
  }

  /**
   * §28.2 mid-session input change — the recovery for a microphone unplugged
   * mid-take.
   *
   * The chosen id becomes this pipeline's device for everything after, not just
   * this one swap: re-opening the device that just vanished would put the take
   * straight back into the hold it was rescued from.
   */
  async switchMicrophone(deviceId: string): Promise<void> {
    this.deviceOverride = deviceId;
    if (!this.running) return;
    const stream = await this.acquireMicrophone(deviceId);
    await this.startCapture(stream);
    try {
      this.deviceManager?.select({ mode: 'specific', deviceId });
    } catch {
      // Enumeration is a nicety; the capture swap already succeeded.
    }
  }

  /**
   * Stop sending audio without closing the session.
   *
   * The socket stays open so resuming is instant, but the frames stop, which is
   * both the cost saving and — because Inworld endpoints on silence — the thing
   * that finalizes whatever sentence was in progress.
   */
  softPause(): void {
    if (this.paused) return;
    this.paused = true;
    this.armPauseTimer();
  }

  /**
   * Come back from either kind of pause.
   *
   * A soft pause only stopped the frames, so resuming is a flag. A hard pause
   * (or the auto-disconnect firing while soft-paused) released the microphone
   * and the socket, so resuming has to rebuild both — and must not resolve
   * until it has, because the caller reports the session live the moment this
   * returns.
   */
  async resume(): Promise<void> {
    if (this.stopped || !this.paused) return;
    this.clearPauseTimer();

    const needsCapture = this.capture === null || this.activeStream === null;
    if (needsCapture || this.transportGeneration === null) {
      // `start()` owns the whole acquire → open → capture sequence, including
      // its epoch checks; duplicating it here is how the two drift apart.
      this.paused = false;
      this.stopped = false;
      await this.start();
      return;
    }
    this.paused = false;
  }

  /**
   * Release the microphone and the socket entirely, and stay resumable.
   *
   * `paused` is set here as well as in `softPause`, which is the difference
   * between "resume works" and a screen that says the microphone is live over
   * a session that no longer exists: `resume()` returns at its first line for
   * anything it does not consider paused.
   */
  async hardPause(): Promise<void> {
    this.clearPauseTimer();
    this.paused = true;
    this.lifecycle += 1;
    await this.closeSession();
    await this.teardownAudio();
    this.running = false;
    this.setConnectionState('offline');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.lifecycle += 1;
    this.clearPauseTimer();
    this.stopDeviceWatch?.();
    this.stopDeviceWatch = null;
    try {
      await this.closeSession();
    } finally {
      await this.teardownAudio();
      this.unlistenStt?.();
      this.unlistenStt = null;
      this.setConnectionState('offline');
    }
  }

  /**
   * The session options for this take — the same builder the Preflight
   * microphone test uses, which is what stops the two drifting.
   */
  /** Why `forwardFrame` declined to send, in words. */
  private frameSkipReason(): string {
    if (this.transportGeneration === null) return 'no session open';
    if (this.paused) return 'paused';
    return 'stopped';
  }

  /**
   * The take's spoken tokens, projected once.
   *
   * Once because the script cannot change mid-take, and because `start()` may
   * run more than once for one script — a soft-pause disconnect and resume
   * re-opens the session, and rebuilding a five-thousand-token list to say the
   * same thing again is work nobody asked for. Rust's own reconnects never
   * come back through here at all: it holds the config for the life of the
   * session and re-sends it itself.
   */
  private vocabularyTokens: AlignToken[] | null = null;

  private sessionOptions(): ReturnType<typeof sttSessionOptions> {
    this.vocabularyTokens ??= alignTokensFor(this.deps.compiled);
    return sttSessionOptions(
      {
        ...(this.deps.modelId !== undefined ? { transcriptionModel: this.deps.modelId } : {}),
        ...(this.deps.language !== undefined ? { language: this.deps.language } : {}),
      },
      this.vocabularyTokens,
    );
  }

  /* ---------------------------------------------------------------------- */

  private async subscribeToStt(): Promise<void> {
    if (this.unlistenStt) return;
    if (!isTauriRuntime()) return; // plain-browser dev: nothing to subscribe to
    /*
     * NOT swallowed. Inside Tauri, a failed subscription means the session
     * would open the microphone, stream audio, bill for it, and receive
     * nothing — the precise failure this rewrite exists to eliminate, arrived
     * at by a different route. Failing the start is the only honest outcome.
     */
    const { listen } = await import('@tauri-apps/api/event');
    this.unlistenStt = await listen<SttFrame>(STT_EVENT, (event) => {
      this.handleSttFrame(event.payload);
    });
  }

  /**
   * Turn one Rust frame into ledger + tracking + UI effects.
   *
   * Exposed for tests: this is where a protocol change would first show up, and
   * driving it directly is the difference between a test that proves the
   * mapping and one that proves a mock was called.
   */
  handleSttFrame(frame: SttFrame): void {
    trace(
      `rx:${frame.kind}`,
      frame.kind === 'transport'
        ? frame.state
        : frame.kind === 'failed'
          ? `${frame.code} recoverable=${frame.recoverable}`
          : frame.kind === 'audioDropped'
            ? `${frame.frames} frames`
            : `gen ${frame.generation} item ${'itemId' in frame ? frame.itemId : '?'}` +
              ('text' in frame ? ` words ${frame.text.trim().split(/\s+/).length}` : ''),
    );
    // A frame from a session that has ended is not an error — it is a late
    // arrival from a take that is over, and applying it would put the previous
    // take's words into this one's ledger.
    if (this.transportGeneration !== null && frame.generation !== this.transportGeneration) {
      trace('rx-dropped', `generation ${frame.generation} != ${this.transportGeneration}`);
      return;
    }

    if (frame.kind === 'audioDropped') {
      this.deps.onAudioDropped?.(frame.frames);
      return;
    }

    if (frame.kind === 'transport') {
      this.setConnectionState(
        frame.state === 'connected'
          ? 'connected'
          : frame.state === 'closed'
            ? 'offline'
            : 'reconnecting',
      );
      /*
       * `connecting` is not a degradation on the way in.
       *
       * It is the FIRST frame every healthy session emits, before a byte of
       * audio has been sent — and treating it as a hold once paused following
       * at +68 ms on every single take, so the words arrived and the cursor
       * never moved: "words heard 28, script followed 0 of 26".
       *
       * After a session HAS connected, `connecting` means a reconnect, and
       * holding is then exactly right — following on a dead transport is the
       * stage drifting on a stale estimate while the presenter talks.
       */
      const opening = frame.state === 'connecting' && !this.hasConnected;
      if (frame.state === 'connected') this.hasConnected = true;
      this.setFollowingHold(!opening && frame.state !== 'connected', `transport_${frame.state}`);
      return;
    }

    if (frame.kind === 'failed') {
      // `recoverable: false` is a key problem, not a network problem: the
      // supervisor has already given up, so the UI must say so instead of
      // showing a reconnect that will never happen.
      this.setConnectionState(frame.recoverable ? 'reconnecting' : 'offline');
      this.deps.onSessionFailure?.(frame.code, !frame.recoverable);
      return;
    }

    if (frame.kind === 'itemStarted') {
      this.itemStarts.set(frame.itemId, frame.audioStartMs);
      return;
    }

    if (frame.kind === 'partial') {
      this.deps.onTranscriptText(frame.text, false);
      return;
    }

    // Final.
    this.deps.onTranscriptText(frame.text, true);
    const text = frame.text.trim();
    if (text.length === 0) return;
    /*
     * Side effects follow FIRST FINALIZATION, not arrival.
     *
     * The transcript tail, the retained record and the word count are not
     * idempotent, so a provider that re-sends a final would show the line
     * twice and inflate "words heard" past what was said.
     */
    if (this.finalized.has(frame.itemId)) {
      trace('final-duplicate', `item ${frame.itemId}`);
      return;
    }
    const item: FinalizedTranscriptItem = {
      itemId: frame.itemId,
      commitSequence: this.commitSequence++,
      audioStartMs: this.itemStarts.get(frame.itemId) ?? frame.audioEndMs,
      audioEndMs: frame.audioEndMs,
      transcript: text,
    };
    this.finalized.set(frame.itemId, item);
    this.itemStarts.delete(frame.itemId);
    this.deps.onTranscriptLine(text);
    this.deps.onTranscriptItem?.(item);
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.lastConnectionState === state) return;
    this.lastConnectionState = state;
    this.deps.onConnectionState(state);
  }

  private setFollowingHold(held: boolean, reason: string | null): void {
    if (this.following === !held) return;
    this.following = !held;
    this.deps.onFollowingHold?.(held, held ? reason : null);
  }

  /**
   * §28.1/§29.2 step 4 precondition. Passive only: `queryMicrophonePermission`
   * uses the Permissions API and never calls `getUserMedia`, so this cannot
   * raise the OS prompt.
   */
  private async checkMicrophonePermission(): Promise<boolean> {
    const permissions = (globalThis as { navigator?: { permissions?: unknown } }).navigator
      ?.permissions;
    if (!permissions) return true;
    const state = await queryMicrophonePermission(
      permissions as Parameters<typeof queryMicrophonePermission>[0],
    );
    return state !== 'denied';
  }

  private get preferredDeviceId(): string | undefined {
    return this.deviceOverride ?? this.deps.deviceId;
  }

  private async acquireMicrophone(deviceId?: string): Promise<MediaStreamLike> {
    await this.teardownAudio();
    const mediaDevices = navigator.mediaDevices as unknown as Parameters<
      typeof requestMicrophoneAccess
    >[0];
    /*
     * The take is the most contended `getUserMedia` in the app: it opens the
     * device immediately after the Preflight meter let go of it, and macOS does
     * not free an input the instant `track.stop()` returns (see
     * `audio/permissions.ts`). The retry is what turns "sometimes voice
     * tracking is unavailable" into a start that waits a few hundred
     * milliseconds and then works.
     */
    this.deps.onCaptureAttempt?.();
    const result = await requestMicrophoneAccess(
      mediaDevices,
      {
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(this.deps.audioProcessing ?? {}),
      },
      {
        onRetry: (attempt, code, delayMs) =>
          trace('microphone-busy', `attempt ${attempt} failed (${code}) — retrying in ${delayMs}ms`),
        /*
         * Only the take may fall back to the system default, and only after the
         * pinned device has been busy for the best part of two seconds.
         * Presenting from the built-in microphone beats not presenting — and it
         * is announced (`onInputFellBackToDefault`), so it is a choice the
         * presenter can undo rather than a substitution they never learn about.
         */
        allowDefaultFallback: true,
      },
    );
    if (!result.ok) {
      trace('microphone-failed', `${result.code} after ${result.attempts} attempts`);
      throw new Error(result.code);
    }
    if (result.attempts > 1) {
      trace('microphone', `acquired on attempt ${result.attempts}`);
    }
    if (result.fellBackToDefault) {
      // The user picked a device and did not get it. That is theirs to know:
      // §28.2 makes which input is in use a visible fact, not an internal one.
      trace('microphone', 'pinned device was busy — fell back to the system default');
      this.deps.onInputFellBackToDefault?.();
    }
    this.activeStream = result.stream;

    this.monitor = new MicrophoneMonitor({
      createGraph: createAnalyserGraph,
      ...(this.deps.vadSensitivity === undefined
        ? {}
        : { vadConfig: vadConfigForSensitivity(this.deps.vadSensitivity) }),
    });
    this.silentInput.reset();
    // §28.6. A dead input holds following; audio coming back releases it.
    // Reported only on the TRANSITION, because `onLevel` fires several times a
    // second and "the microphone is back" is not news forty times over.
    let inputWasDead = false;
    this.monitor.onLevel((snapshot) => {
      /*
       * First, and outside the dead-input logic below: the pill has to keep
       * drawing through a silent stretch — that IS the reading — so it must not
       * be fed from a branch that returns early once signal is present.
       */
      this.deps.onLevel?.(snapshot);
      if (snapshot.signalPresent) {
        this.silentInput.reset();
        if (inputWasDead) {
          inputWasDead = false;
          this.deps.onInputRestored?.();
          // The hold has to come off here. Without it the toast says following
          // has resumed while the follow store stays paused — the screen and
          // the stage disagreeing about whether the take is live.
          this.setFollowingHold(false, null);
        }
        return;
      }
      const code = this.silentInput.observe(snapshot);
      if (code && !inputWasDead) {
        inputWasDead = true;
        this.deps.onInputDeviceLost?.(code);
        this.setFollowingHold(true, code);
      }
    });
    await this.monitor.start(result.stream);

    // §5.3: fan the SAME capture out to any extra consumer, so every reader
    // shares one track and one clock.
    this.deps.onCaptureStream?.(result.stream);
    return result.stream;
  }

  /** Open the PCM tap and start forwarding frames to the Rust session. */
  private async startCapture(stream: MediaStreamLike): Promise<void> {
    await this.capture?.stop();
    this.capture = new PcmCapture({
      onFrame: (samples) => this.forwardFrame(samples),
    });
    await this.capture.start(stream);
  }

  /**
   * Forward one frame, in order, dropping nothing silently.
   *
   * Frames are chained rather than fired concurrently — see `sendChain`. A
   * rejected push is swallowed here because the Rust session reports its own
   * drops as `audioDropped`, which counts them; throwing out of an audio
   * callback would only tear down the capture graph mid-take.
   */
  private forwardFrame(samples: Float32Array): void {
    const generation = this.transportGeneration;
    if (generation === null || this.paused || this.stopped) {
      // Silence with a cause is the thing worth naming: an unforwarded frame
      // is indistinguishable downstream from a presenter who said nothing.
      if (this.framesSent === 0 && !this.stopped) trace('frame-skipped', this.frameSkipReason());
      return;
    }
    this.framesSent += 1;
    if (this.framesSent === 1 || this.framesSent % 50 === 0) {
      trace('audio', `${this.framesSent} frames sent (${this.framesSent / 10}s)`);
    }
    const chunk = encodePcm16(samples);
    this.sendChain = this.sendChain
      .then(() => pushTranscriptionAudio(generation, chunk))
      .catch(() => {});
  }

  /**
   * §28.6: watch `devicechange` so an unplugged or replaced input is noticed
   * even when the track itself does not end — macOS default-device switches in
   * particular.
   */
  private watchDevices(): void {
    if (this.stopDeviceWatch) return;
    const media = (globalThis as { navigator?: { mediaDevices?: unknown } }).navigator
      ?.mediaDevices;
    if (!media) return;
    try {
      this.deviceManager ??= new MicrophoneDeviceManager(
        media as ConstructorParameters<typeof MicrophoneDeviceManager>[0],
      );
      // Seed the baseline so the first diff is meaningful, then watch.
      void this.deviceManager.listInputs().catch(() => {});
      const pinned = this.preferredDeviceId;
      if (pinned) this.deviceManager.select({ mode: 'specific', deviceId: pinned });
      this.stopDeviceWatch = this.deviceManager.onDeviceChange((report) => {
        if (report.selectedDeviceLost) this.deps.onInputDeviceLost?.('MIC_DEVICE_LOST');
      });
    } catch {
      // Device enumeration is unavailable; track-level detection still applies.
    }
  }

  private armPauseTimer(): void {
    this.clearPauseTimer();
    const after = this.deps.softPauseAutoDisconnectMs ?? DEFAULT_SOFT_PAUSE_AUTO_DISCONNECT_MS;
    if (after <= 0) return;
    this.pauseTimer = this.timers.setTimeout(() => {
      this.pauseTimer = null;
      if (!this.paused || this.stopped) return;
      this.deps.onPauseWarning?.(0);
      void this.closeSession();
    }, after);
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer === null) return;
    this.timers.clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  /** Close the Rust session, letting the last utterance finalize. */
  private async closeSession(): Promise<void> {
    const generation = this.transportGeneration;
    this.transportGeneration = null;
    if (generation === null) return;
    try {
      await stopTranscription(generation);
    } catch {
      // The session is going away regardless; a failure to say so politely is
      // not something the caller can act on.
    }
  }

  private async teardownAudio(): Promise<void> {
    const capture = this.capture;
    this.capture = null;
    await capture?.stop();

    const monitor = this.monitor;
    this.monitor = null;
    if (monitor) await monitor.stop();

    releaseStream(this.activeStream);
    this.activeStream = null;
  }
}
