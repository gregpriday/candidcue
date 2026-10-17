/**
 * Voice session pipeline — microphone in, transcript events out.
 *
 *   mic → PcmCapture (24 kHz PCM16) → Rust on-device STT session
 *       → stt://event → transcript record + UI (alignment happens in Rust)
 *
 * This replaced a pipeline roughly four times its size, and almost everything
 * that went was machinery for deciding when a sentence had ended: a local
 * voice-activity detector, a noise-floor calibration, a speech gate, a commit
 * driver, and a manual buffer commit. The recogniser does its own endpointing
 * (sherpa's trailing-silence rules, in `cc_stt::local`), so a take now streams
 * unconditionally and the recogniser says where the utterances are.
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
import { frameHasSignal } from './audio/levelMeter';
import { AudioSendQueue } from './audio/send-queue';
import {
  encodePcm16,
  pushTranscriptionAudio,
  startTranscription,
  stopTranscription,
  STT_EVENT,
  type SttFrame,
} from './stt/local';

/**
 * The most audio held for a recogniser that is still loading: 4 s of 100 ms
 * frames.
 *
 * Bounded by the Rust session's own queue, `AUDIO_QUEUE_FRAMES` (50) in
 * `speech/session.rs`, not by memory. The backlog is pushed in one burst the
 * moment the session opens, and anything beyond that queue is dropped there
 * and reported to the presenter as a stall. Forty fits even if the worker has
 * not taken a single frame yet, with room left for live frames behind it.
 *
 * A load takes about 1.2 s and the worst the logs have recorded is 5.2 s, so
 * this is only ever reached in that tail. There the OLDEST frames go: the
 * recogniser gets a contiguous stream that runs up to the present rather than
 * an opening with a hole torn in it.
 */
export const PRE_ROLL_MAX_FRAMES = 40;

/**
 * Every pipeline's `start_transcription`, one at a time.
 *
 * Rust holds ONE recogniser session, and a start replaces whatever is running
 * (`SpeechEngine::start_stream`). A start that a stop or a hard pause has
 * overtaken is still in flight there — a cold load runs for seconds — and if
 * it landed after the take that followed it, it would abandon that take's
 * session for one nobody is reading (#289). Module scope rather than per
 * pipeline, because "Present again" builds a new pipeline while the old one's
 * load is still running. Waiting costs nothing: the next start would block on
 * the same load in Rust anyway.
 */
let transportQueue: Promise<void> = Promise.resolve();

function serialiseTransport(task: () => Promise<void>): Promise<void> {
  const run = transportQueue.then(task);
  transportQueue = run.catch(() => {});
  return run;
}

/** Timer seam so tests drive a virtual clock instead of waiting. */
export interface PipelineTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * §29.2 steps 1–2, as the *caller's* half of the start sequence.
 *
 * Each is a PRECONDITION CHECK rather than a second performance of the step:
 * flushing an already-flushed save is a no-op, and asking whether the compile
 * is current is cheap and idempotent. Either rejecting aborts the start before
 * the microphone is opened or a session is billed, and it lives here rather
 * than in the screen that happens to precede a take so a retake or a resume
 * gets the same ordering.
 */
export interface StartSequenceGate {
  /** §29.2 step 1 — the script's pending save must be on disk. */
  flushScriptSave(): Promise<void>;
  /** §29.2 step 2 — a current compile with no blocking diagnostics. */
  ensureCompiled(): Promise<void>;
}

/** One finalized transcript item. */
export interface FinalizedTranscriptItem {
  itemId: string;
  /** The ledger's local commit ordering. */
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
  /** §29.2 steps 1–2; optional only so a unit test can stand up a bare pipeline. */
  startSequence?: StartSequenceGate;
  /** §29.2 step 9 — transcript state above this layer goes too. */
  onResetTranscriptState?(): void;
  /**
   * Raw recogniser text, for the stage's transcript bar and the "did it hear
   * me" word count. NOT alignment input: the alignment engine is fed by Rust
   * directly from the same socket, so nothing on this path can starve it.
   */
  onTranscriptText(text: string, final: boolean): void;
  /** Final transcript lines for the Live transcript tail. */
  onTranscriptLine(line: string): void;
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
   * visible tail, which is NOT idempotent. A provider that re-sends a final
   * would otherwise show the line twice.
   */
  private readonly finalized = new Map<string, FinalizedTranscriptItem>();
  /** Monotonic commit ordering. */
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
   * Bumped by every teardown. Every operation that opens something reads it
   * before its FIRST await and re-checks it after each one, so a stop that
   * lands mid-start cannot be overtaken by the start it interrupted and leave
   * a microphone open on a session nobody asked for (#289).
   *
   * An attempt that finds it has moved owns nothing shared any more: `stop()`
   * or `hardPause()` already took down what was published, and a resume may
   * have opened its own since. It releases only the handles it is still
   * holding locally, and leaves every field alone.
   */
  private lifecycle = 0;
  /** The start in flight for the current lifecycle, so a second one joins it. */
  private starting: { epoch: number; done: Promise<void> } | null = null;
  /**
   * Orders microphone acquisitions, so a switch and a start (or two switches)
   * cannot both open the device and leave one stream with no owner.
   */
  private audioChain: Promise<void> = Promise.resolve();
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
  /** Wall time of the last PCM frame that carried anything, or 0. */
  private lastPcmSignalAtMs = 0;

  /**
   * Has the tap that feeds the recogniser carried signal lately?
   *
   * The window is generous on purpose: this is not a speech detector, it is a
   * check on whether the DEVICE is producing audio at all, and a presenter who
   * pauses for three seconds mid-paragraph has not unplugged their microphone.
   * `SilentInputDetector` already applies its own, much longer patience before
   * it declares anything; this only decides whether to believe it.
   */
  private pcmHeardRecently(): boolean {
    return this.lastPcmSignalAtMs > 0 && Date.now() - this.lastPcmSignalAtMs < 5000;
  }
  /**
   * Pushes Rust has acknowledged this session; traced, not merely counted.
   *
   * Counted when the call comes back, not when the frame is queued: a count of
   * frames merely queued went on climbing through a stall that delivered
   * nothing, and the trace said the take was fine while following had stopped.
   */
  private framesDelivered = 0;
  /**
   * Frames captured while `start()` waits for the recogniser, in order.
   *
   * Capture opens as soon as the microphone does, and `start_transcription`
   * can spend over a second loading the model before it returns a generation
   * to push to. The presenter is already talking by then, and those are the
   * words that place the first lock, so they are held here rather than
   * dropped and handed over the moment the session exists.
   *
   * Only while `holdingFrames` is set, which `start()` owns: a frame arriving
   * with no session for any other reason is still skipped, and still traced.
   */
  private preRoll: string[] = [];
  private holdingFrames = false;
  /** Oldest frames shed because the load outlasted `PRE_ROLL_MAX_FRAMES`. */
  private preRollShed = 0;
  /** True once this session has reached `connected` at least once. */
  private hasConnected = false;
  private deviceManager: MicrophoneDeviceManager | null = null;
  /** §28.2: a device chosen mid-session outranks `deps.deviceId`. */
  private deviceOverride: string | undefined;
  private stopDeviceWatch: (() => void) | null = null;
  private readonly timers: PipelineTimers;
  private readonly now: () => number;
  /**
   * Frames on their way to the open Rust session, one push at a time and in
   * order, with a bound — see `AudioSendQueue`. One per transport generation:
   * opened with the session in `start()`, disposed in `closeSession()`.
   */
  private sender: AudioSendQueue | null = null;

  constructor(private readonly deps: VoicePipelineDeps) {
    this.timers = deps.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    };
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * §29.2 start sequence. Billable streaming begins here.
   *
   * One start per lifecycle: a resume that arrives while this one is still
   * opening joins it rather than running a second acquire that would tear the
   * first one's capture down underneath it.
   */
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('SESSION_STOPPED'));
    if (this.starting?.epoch === this.lifecycle) return this.starting.done;
    const epoch = this.lifecycle;
    const done = this.openSession(epoch).finally(() => {
      if (this.starting?.done === done) this.starting = null;
    });
    this.starting = { epoch, done };
    return done;
  }

  private async openSession(epoch: number): Promise<void> {
    try {
      // Steps 1–2 first: nothing billable begins on a session whose script or
      // compile was not ready.
      if (this.deps.startSequence) {
        await this.deps.startSequence.flushScriptSave();
        this.assertCurrent(epoch);
        await this.deps.startSequence.ensureCompiled();
        this.assertCurrent(epoch);
      }
      // Step 4, passive: only an explicit `denied` stops the sequence. Plenty
      // of WebViews do not answer the query at all, and `getUserMedia`
      // resolves permission implicitly there.
      const permitted = await this.checkMicrophonePermission();
      this.assertCurrent(epoch);
      if (!permitted) throw new Error('MIC_PERMISSION_DENIED');

      traceBegin();
      trace('start', `sessionGeneration ${this.deps.sessionGeneration}`);
      this.running = true;
      this.paused = false;
      this.setConnectionState('reconnecting');
      // Before the microphone and before the session: a Tauri event is
      // delivered by evaluating JS in the target webview and is never queued,
      // so a frame emitted before this returns is lost outright.
      await this.subscribeToStt(epoch);

      await this.serialiseAudio(async () => {
        this.assertCurrent(epoch);
        const stream = await this.acquireMicrophone(epoch, this.preferredDeviceId);
        trace('microphone', 'stream acquired');

        /*
         * CAPTURE FIRST, THEN THE RECOGNISER (#257).
         *
         * `start_transcription` loads the model when it is not resident, which
         * takes over a second on the first take after launch and the first
         * after a model change. Capture used to wait for it, so the microphone
         * sat open for that second recording nothing, and the presenter's
         * opening words — the ones that place the first lock — were never
         * heard at all. The frames captured meanwhile are held (`preRoll`) and
         * handed over the moment the session has a generation to stamp them
         * with.
         */
        this.assertCurrent(epoch);
        this.audioOriginMs = this.now();
        this.holdingFrames = true;
        await this.startCapture(epoch, stream);
        trace('capture', `started at ${this.capture?.contextSampleRate ?? 0} Hz`);
      });

      await serialiseTransport(async () => {
        this.assertCurrent(epoch);
        const generation = await startTranscription();
        if (!this.isCurrent(epoch)) {
          // Closed here and never published. The take it was opened for has
          // ended, and assigning it would overwrite the generation of a
          // resume that has since opened its own.
          await this.closeTransport(generation);
          throw new Error('SESSION_STOPPED');
        }
        this.transportGeneration = generation;
        trace('session', `transport ${generation} on the bundled recogniser`);
        // In the same turn as the assignment above, with no await between
        // them: a frame captured after this point cannot be queued ahead of
        // the backlog it follows. Opened only past the epoch check above, so
        // an attempt a stop or hard pause overtook never builds a queue.
        this.openSender(generation);
        this.releasePreRoll();
      });
    } catch (err) {
      trace('start-failed', err instanceof Error ? err.message : 'unknown');
      /*
       * Whatever this attempt failed on, if the take moved on meanwhile the
       * answer is `SESSION_STOPPED`, which the store treats as a teardown
       * rather than a failure to report. Nothing shared is cleaned up here:
       * the stop or hard pause that superseded this attempt already did that,
       * and the fields may now belong to a resume.
       */
      if (!this.isCurrent(epoch)) throw new Error('SESSION_STOPPED');
      this.running = false;
      // Audio held for a session that will now never open belongs to nobody.
      this.dropPreRoll();
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
    // The busy-device retry alone can hold this open for 1.75 s, and a stop in
    // that window must not be followed by a new stream on a dead take (#289).
    const epoch = this.lifecycle;
    await this.serialiseAudio(async () => {
      this.assertCurrent(epoch);
      // Queued behind a start that has since failed: there is no take to
      // give a microphone to.
      if (!this.running) return;
      const stream = await this.acquireMicrophone(epoch, deviceId);
      await this.startCapture(epoch, stream);
    });
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
   * both the CPU saving and — because the recogniser endpoints on silence — the thing
   * that finalizes whatever sentence was in progress.
   */
  softPause(): void {
    if (this.paused) return;
    this.paused = true;
    /*
     * And what a loading recogniser was being saved, too.
     *
     * Those frames have not been sent, and once the load finishes they would
     * be — to a take the presenter has paused. Discarded rather than kept for
     * the resume: by then they are stale, and the recogniser would hear them
     * run straight on into whatever the presenter says next as one sentence.
     * Holding itself stays on, so a start still in progress keeps what it
     * hears after a resume.
     */
    this.discardHeld();
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
    this.running = false;
    this.dropPreRoll();
    this.setConnectionState('offline');
    // Both detach what they close before their first await, so a resume that
    // starts while this is still closing keeps everything it opens (#289).
    await Promise.all([this.closeSession(), this.teardownAudio()]);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.lifecycle += 1;
    this.dropPreRoll();
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

  /* ---------------------------------------------------------------------- */

  private isCurrent(epoch: number): boolean {
    return epoch === this.lifecycle;
  }

  private assertCurrent(epoch: number): void {
    if (!this.isCurrent(epoch)) throw new Error('SESSION_STOPPED');
  }

  /** Run `task` after every microphone acquisition queued before it. */
  private serialiseAudio(task: () => Promise<void>): Promise<void> {
    const run = this.audioChain.then(task);
    this.audioChain = run.catch(() => {});
    return run;
  }

  private async subscribeToStt(epoch: number): Promise<void> {
    if (this.unlistenStt) return;
    if (!isTauriRuntime()) return; // plain-browser dev: nothing to subscribe to
    /*
     * NOT swallowed. Inside Tauri, a failed subscription means the session
     * would open the microphone, stream audio, bill for it, and receive
     * nothing — the precise failure this rewrite exists to eliminate, arrived
     * at by a different route. Failing the start is the only honest outcome.
     */
    const { listen } = await import('@tauri-apps/api/event');
    this.assertCurrent(epoch);
    const unlisten = await listen<SttFrame>(STT_EVENT, (event) => {
      this.handleSttFrame(event.payload);
    });
    /*
     * A subscription that lands after `stop()` is nobody's: the stop already
     * ran its unlisten, and found nothing to call. One that lands beside
     * another (a resume that subscribed while this was pending) is surplus.
     * A hard pause keeps it, as it keeps the one a running take had.
     */
    if (this.stopped || this.unlistenStt) unlisten();
    else this.unlistenStt = unlisten;
    this.assertCurrent(epoch);
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
     * The transcript tail is not idempotent, so a provider that re-sends a
     * final would show the line twice.
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

  /**
   * Open the device and its level meter, and publish them.
   *
   * Nothing is published until the take is known to still want it. The stream
   * and the monitor stay local across every await, so a stop that lands inside
   * one (a permission prompt, the busy retry, the analyser graph) leaves this
   * holding the only reference — and this is what closes them.
   */
  private async acquireMicrophone(epoch: number, deviceId?: string): Promise<MediaStreamLike> {
    await this.teardownAudio();
    this.assertCurrent(epoch);
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
        /*
         * The only wait in the retry loop, so it is where a stop ends it: a
         * take that has been stopped must not ask for the device again.
         * Rejecting here abandons the loop with no stream open.
         */
        sleep: async (ms) => {
          await new Promise<void>((resolve) => {
            this.timers.setTimeout(resolve, ms);
          });
          this.assertCurrent(epoch);
        },
      },
    );
    if (!this.isCurrent(epoch)) {
      // Resolved for a take that has ended. The track is live — the system's
      // microphone indicator is on — and no one else has a reference to it.
      if (result.ok) releaseStream(result.stream);
      throw new Error('SESSION_STOPPED');
    }
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
    const stream = result.stream;

    const monitor = new MicrophoneMonitor({
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
    monitor.onLevel((snapshot) => {
      // A meter this take has replaced or released reports on nothing.
      if (this.monitor !== monitor) return;
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
      /*
       * Vetoed by the PCM tap. A dead input is a real fault worth holding for,
       * but only the tap that feeds the recogniser can say the input is dead —
       * and if it has carried signal recently, it is not.
       */
      if (code && this.pcmHeardRecently()) {
        trace(
          'input-monitor-disagrees',
          `level meter reports ${code} while the PCM tap is carrying signal — not holding`,
        );
        /*
         * RELEASING matters as much as not holding.
         *
         * The release path below lives in the `signalPresent` branch, which is
         * the analyser's opinion — and on a device where the analyser is the
         * thing that is broken, that branch never runs. So a hold taken before
         * the PCM tap opened (capture starts after the monitor) would stand for
         * the rest of the take with nothing able to lift it: the exact
         * unrecoverable state this veto exists to prevent, arrived at one
         * second later.
         */
        if (inputWasDead) {
          inputWasDead = false;
          this.deps.onInputRestored?.();
          this.setFollowingHold(false, null);
        }
        return;
      }
      if (code && !inputWasDead) {
        inputWasDead = true;
        this.deps.onInputDeviceLost?.(code);
        this.setFollowingHold(true, code);
      }
    });
    try {
      await monitor.start(stream);
      this.assertCurrent(epoch);
    } catch (err) {
      // A stop during the analyser's setup found no graph to close; the one
      // that has since been built is closed by this second stop.
      releaseStream(stream);
      await monitor.stop().catch(() => {});
      throw err;
    }
    this.activeStream = stream;
    this.monitor = monitor;

    // §5.3: fan the SAME capture out to any extra consumer, so every reader
    // shares one track and one clock.
    this.deps.onCaptureStream?.(stream);
    return stream;
  }

  /** Open the PCM tap and start forwarding frames to the Rust session. */
  private async startCapture(epoch: number, stream: MediaStreamLike): Promise<void> {
    const previous = this.capture;
    this.capture = null;
    await previous?.stop();
    this.assertCurrent(epoch);
    const capture: PcmCapture = new PcmCapture({
      onFrame: (samples) => {
        // A tap this take has replaced or released forwards nothing.
        if (capture === this.capture) this.forwardFrame(samples);
      },
    });
    try {
      await capture.start(stream);
      this.assertCurrent(epoch);
    } catch (err) {
      await capture.stop();
      throw err;
    }
    this.capture = capture;
  }

  /**
   * Forward one frame, in order, dropping nothing silently.
   *
   * Frames are queued rather than fired concurrently — see `sender`. A frame
   * the queue cannot deliver, because the push stalled or was refused, is
   * counted there and reported through `onAudioDropped`, as Rust reports its
   * own drops; nothing is thrown, because throwing out of an audio callback
   * would only tear down the capture graph mid-take.
   */
  private forwardFrame(samples: Float32Array): void {
    /*
     * The PCM tap is the ground truth about whether there is audio.
     *
     * There are two taps on one microphone: this one, which encodes the frames
     * the recogniser actually transcribes, and a separate AnalyserNode graph
     * (`MicrophoneMonitor`) that drives the level meter and the §28.6
     * dead-input detector. They can disagree, and on at least one real device —
     * a RODE NT-USB Mini on macOS — they do: the analyser reports pure silence
     * while this tap carries perfectly transcribable speech. Settings shows
     * both answers side by side, "No signal" above "Transcription is working".
     *
     * When they disagree the analyser used to win, and it held following for
     * the whole take. So the take heard the presenter, transcribed them,
     * aligned them, and refused to move the script — while the only readout
     * that could have explained it said the microphone was fine.
     *
     * Whatever is wrong with the analyser path on that device, this frame is
     * evidence that cannot be argued with: bytes on their way to the recogniser.
     */
    if (frameHasSignal(samples)) this.lastPcmSignalAtMs = Date.now();
    const generation = this.transportGeneration;
    if (generation === null && this.holdingFrames && !this.paused && !this.stopped) {
      this.holdFrame(encodePcm16(samples));
      return;
    }
    if (generation === null || this.paused || this.stopped) {
      // Silence with a cause is the thing worth naming: an unforwarded frame
      // is indistinguishable downstream from a presenter who said nothing.
      if (this.framesDelivered === 0 && !this.stopped) {
        trace('frame-skipped', this.frameSkipReason());
      }
      return;
    }
    this.sender?.enqueue(encodePcm16(samples));
  }

  /** A fresh queue for a session that has just opened, stamped with its generation. */
  private openSender(generation: number): void {
    this.sender?.dispose();
    this.sender = new AudioSendQueue({
      send: (chunk) => pushTranscriptionAudio(generation, chunk),
      onDelivered: () => {
        const delivered = (this.framesDelivered += 1);
        if (delivered === 1 || delivered % 50 === 0) {
          trace('audio', `${delivered} frames delivered (${delivered / 10}s)`);
        }
      },
      // Audio the recogniser will never hear, reported the way Rust reports
      // its own: from here the presenter cannot tell which side lost it.
      onDropped: (frames) => this.deps.onAudioDropped?.(frames),
      // A test's clock if it brought one; otherwise the queue's own monotonic
      // one, because a wall-clock step must not age fresh audio into a loss.
      now: this.deps.now,
    });
  }

  /** Keep one frame for the session `start()` is still opening. */
  private holdFrame(chunk: string): void {
    this.preRoll.push(chunk);
    if (this.preRoll.length > PRE_ROLL_MAX_FRAMES) {
      this.preRoll.shift();
      this.preRollShed += 1;
    }
  }

  /** Send the held frames to the session that now exists, oldest first. */
  private releasePreRoll(): void {
    const held = this.preRoll;
    const shed = this.preRollShed;
    this.dropPreRoll();
    trace(
      'pre-roll',
      `${held.length} frames held for the recogniser (${held.length / 10}s)` +
        (shed > 0 ? `, ${shed} oldest shed` : ''),
    );
    for (const chunk of held) this.sender?.enqueue(chunk);
    // Audio the recogniser will never hear, which is what this callback
    // reports whichever side of the IPC edge it was lost on.
    if (shed > 0) this.deps.onAudioDropped?.(shed);
  }

  /** Stop holding, and forget anything held. */
  private dropPreRoll(): void {
    this.holdingFrames = false;
    this.discardHeld();
  }

  private discardHeld(): void {
    this.preRoll = [];
    this.preRollShed = 0;
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
    // Before any await: a frame still waiting is for a session that is going,
    // and a push that never settles must not hold anything open behind it.
    this.sender?.dispose();
    this.sender = null;
    const generation = this.transportGeneration;
    this.transportGeneration = null;
    if (generation === null) return;
    await this.closeTransport(generation);
  }

  private async closeTransport(generation: number): Promise<void> {
    try {
      await stopTranscription(generation);
    } catch {
      // The session is going away regardless; a failure to say so politely is
      // not something the caller can act on.
    }
  }

  private async teardownAudio(): Promise<void> {
    // All three detached before the first await, so an acquisition that
    // begins while this is still closing cannot have its own collected.
    const capture = this.capture;
    const monitor = this.monitor;
    const stream = this.activeStream;
    this.capture = null;
    this.monitor = null;
    this.activeStream = null;
    try {
      await capture?.stop();
      await monitor?.stop();
    } finally {
      releaseStream(stream);
    }
  }
}
