/**
 * Voice session pipeline — binds the audio package (mic + local VAD), the
 * realtime transcription transport (WebRTC → OpenAI), the transcript ledger,
 * and the command router into the live tracking flow (spec §29, §30, §33).
 *
 *   mic → WebRtcTranscriptionTransport → TranscriptEvent
 *        → TranscriptLedger (+ tracking worker via onTrackingEvent)
 *        → CommandRouter (wake gate → mask → validate → execute)
 *
 * Luna fallback: `interpret_command` is invoked when the router requests it;
 * a NOT_IMPLEMENTED rejection degrades gracefully to deterministic-only
 * parsing (the candidate resolves as unknown).
 */
import type {
  RealtimeState,
  TranscriptEvent as TransportEvent,
  TranscriptionConfig,
  CompiledScript,
  ValidatedCommand,
} from '../../shared/contracts';
import {
  CommandRouter,
  DEFAULT_COMMAND_BOUNDS,
  type CommandObservation,
  type CommandSettings,
} from '../../shared/commands';
import { decideExecution, type ExecutionState } from '../../shared/commands/schema';
import { TranscriptLedger } from '../../shared/tracking/ledger';
import type { TranscriptEvent as TrackingEvent } from '../../shared/tracking/types';
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
import {
  ManualCommitDriver,
  RealtimeSessionController,
  WebRtcTranscriptionTransport,
  type TransportTimers,
} from './realtime';
import { ipcInvoke } from './ipc';
import { getModelCapabilities, UNKNOWN_CAPABILITIES } from './capabilities';
import { vocabularyPromptFor } from './vocabulary';
import type { ModelCapabilities } from './capabilities';

/**
 * §33.11: how often `CommandRouter.tick` is driven. The router's time-based
 * expiry (`expireLuna`) otherwise only runs when new transcript arrives, which
 * is precisely what does NOT happen while the aligner is frozen in
 * COMMAND_PENDING waiting for a Luna handoff that never returns.
 *
 * 250 ms is well inside the 3 s hard timeout and costs nothing measurable — the
 * tick is a single comparison unless something is actually pending.
 */
export const COMMAND_TICK_INTERVAL_MS = 250;

/**
 * §29.2 steps 1–3, as the *caller's* half of the start sequence.
 *
 * `RealtimeSessionController` has always had hooks for these three and the only
 * production caller supplied none of them. The steps did happen — in
 * `Preflight.svelte`, before `startLiveSession` — so the behaviour was right by
 * accident, and an accident is exactly the problem: a controller cannot enforce
 * an ordering it does not own, so a retake, a resumed session or a second entry
 * point would get none of it. The controller also re-runs `start()` on every
 * resume-after-sleep and hard-pause recovery, where Preflight is long gone.
 *
 * Each of these is therefore a PRECONDITION CHECK, not a second performance of
 * the step. Flushing an already-flushed save is a no-op; asking whether the
 * compile is current and the stage has acked is cheap and idempotent; and any
 * of them rejecting aborts the start before the transport is touched, so nothing
 * billable begins on a session that was not ready.
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

export interface VoicePipelineDeps {
  sessionId: string;
  sessionGeneration: number;
  compiled: CompiledScript;
  config: TranscriptionConfig;
  commandSettings?: Partial<CommandSettings>;
  /** Voice-command listening toggle (§14.2 D); alignment still runs. */
  commandsEnabled?: boolean;
  deviceId?: string;
  /**
   * §28.3 capture processing. These are the user's Settings → Audio toggles;
   * without them here the settings were persisted and then ignored by every
   * `getUserMedia` call in the app.
   */
  audioProcessing?: {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
  /**
   * §28.4 Settings → Audio "Local voice-detection sensitivity", 0–1 with 0.5 =
   * the A.6 defaults. Persisted since the setting shipped and read by nothing:
   * every session ran on the constants regardless of what the slider said.
   *
   * It moves the speech THRESHOLD only. See `vadConfigForSensitivity` for why
   * the commit cadence is deliberately not on the slider — this VAD's turn
   * boundaries are the Realtime commit cue, so they are latency and money, not
   * just detection.
   */
  vadSensitivity?: number;
  /**
   * §29.2 steps 1–3. Supplied by the session store for every real take; the
   * type stays optional only so a unit test can stand up a bare pipeline
   * without a script store, a compiler and a stage window behind it.
   */
  startSequence?: StartSequenceGate;
  /**
   * §29.2 step 9 — the controller is clearing transcript state, so the alignment
   * cursor and any transcript the session store is holding go with it. The
   * pipeline resets what it owns (router, commit driver, silence detector)
   * unconditionally; this is the part that lives above it.
   */
  onResetTranscriptState?(): void;
  getCursorTokenIndex(): number;
  getPosition(): { blockId: string; sentenceId: string; tokenIndex: number };
  getScrollMode(): 'voice' | 'manual' | 'fixed';
  /** Reconciled transcript events destined for the tracking worker. */
  onTrackingEvent(event: TrackingEvent): void;
  /** Command-consumed items to exclude from alignment (§33.4). */
  onMaskItems(itemIds: string[]): void;
  /**
   * §33.4 tail: the phrase turned out to be authored script, so items an
   * earlier `pending` masked must go BACK to the aligner. Without this binding
   * a spurious wake permanently excludes the sentence the presenter was
   * reading and the engine's masked-item set only ever grows.
   */
  onReleaseItems(itemIds: string[]): void;
  onCommandPending(pending: boolean): void;
  executeCommand(command: ValidatedCommand): void;
  onUnknownCommand(message: string): void;
  /**
   * H8: live execution context for the §33.9 confirmation policy. Without it
   * `decideExecution` cannot tell a safe jump from a stop mid-take.
   */
  getExecutionState?(): ExecutionState;
  /**
   * H8: present a confirmation and resolve true when the user confirms.
   * When omitted, a command requiring confirmation is NOT executed — refusing
   * is always safer than acting on an ambiguous target mid-take.
   */
  confirmCommand?(command: ValidatedCommand, reason: string): Promise<boolean>;
  /** H8: a command was refused by the execution policy. */
  onCommandRejected?(command: ValidatedCommand, reason: string): void;
  /**
   * §5.3 single-capture fan-out. The one place in the app that opens the
   * microphone hands the resulting stream to any additional consumer — today
   * the coaching analyzer — so no second `getUserMedia` is ever issued. Invoked
   * each time a capture is (re)acquired; the same live `MediaStreamTrack` the
   * WebRTC peer connection and the level meter received is passed through.
   */
  onCaptureStream?(stream: MediaStreamLike): void;
  /** Final transcript lines for the Live transcript tail. */
  onTranscriptLine(line: string): void;
  /**
   * §36.2 retention feed: one finalized item, with the ledger's commit
   * ordering and audio window attached. Text only — never audio.
   *
   * Separate from `onTranscriptLine` on purpose: the tail is a four-line UI
   * affordance, this is the durable record, and the record needs the commit
   * sequence that makes `UNIQUE(session_id, commit_sequence)` meaningful.
   */
  onTranscriptItem?(item: FinalizedTranscriptItem): void;
  onConnectionState(state: 'connected' | 'reconnecting' | 'offline'): void;
  onRealtimeState?(state: RealtimeState): void;
  /**
   * H5: following must visibly stop while transcription is untrustworthy —
   * dead input, no transcripts despite audio, or a reconnect in progress.
   */
  onFollowingHold?(held: boolean, reason: string | null): void;
  /** H5: the input device is gone; the user must pick another (§28.6). */
  onInputDeviceLost?(code: string): void;
  /**
   * §28.6: audio is flowing from the input again — the track unmuted, or the
   * device was plugged back in. The counterpart to `onInputDeviceLost`, so the
   * UI can stop saying the microphone is gone without the user doing anything.
   * Without it a recovered input left the Live screen reading "Mic lost" for
   * the rest of the take.
   */
  onInputRestored?(): void;
  /** H1: a session-level provider failure ended or interrupted the session. */
  onSessionFailure?(code: string, fatal: boolean): void;
  /** M3: soft pause will auto-disconnect in `msRemaining` (A.6). */
  onPauseWarning?(msRemaining: number): void;
  /**
   * Timer seam. Every deadline this pipeline owns — the Luna hard timeout and
   * the §33.11 router tick — goes through it, so tests drive a virtual clock
   * instead of waiting in real time. Defaults to the host timers.
   */
  timers?: TransportTimers;
  /** Clock seam, paired with `timers`. Defaults to `Date.now`. */
  now?: () => number;
}

export class VoiceSessionPipeline {
  readonly ledger = new TranscriptLedger();
  readonly router: CommandRouter;
  readonly controller: RealtimeSessionController;
  private readonly transport: WebRtcTranscriptionTransport;
  private readonly commitDriver: ManualCommitDriver;
  private monitor: MicrophoneMonitor | null = null;
  private activeStream: MediaStreamLike | null = null;
  /**
   * §29.2 step 8: true between the controller's `startVad` and its `stopVad`.
   * A re-acquisition inside that window restarts the VAD itself; one outside it
   * (the very first connect) waits for the controller, which is what makes the
   * step the controller's rather than the transport's.
   */
  private vadRequested = false;
  private commandPending = false;
  private stopped = false;
  /** H5: sustained no-signal detection on the captured stream (§28.6). */
  private readonly silentInput = new SilentInputDetector();
  /** H5: `devicechange` watcher for unplug / default-device changes. */
  private deviceManager: MicrophoneDeviceManager | null = null;
  /** §28.2: the device chosen mid-session, which outranks `deps.deviceId`. */
  private deviceOverride: string | undefined;
  private stopDeviceWatch: (() => void) | null = null;
  private readonly timers: TransportTimers;
  private readonly now: () => number;
  /** §33.11 router tick handle; non-null exactly while the ticker is armed. */
  private commandTickTimer: unknown | null = null;
  /** True once `start()` ran, so the ticker survives an idle stretch. */
  private running = false;
  /**
   * §27.8 model capability registry, resolved at `start()`. Defaults to
   * everything-off so an unreached registry can never be mistaken for
   * "supported" — an unknown capability must fail closed.
   */
  private capabilities: ModelCapabilities = UNKNOWN_CAPABILITIES;

  constructor(private readonly deps: VoicePipelineDeps) {
    this.timers = deps.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    };
    this.now = deps.now ?? (() => Date.now());
    this.ledger.setSessionGeneration(deps.sessionGeneration);
    this.router = new CommandRouter(
      {
        ledger: this.ledger,
        parseContext: { navigationTargets: deps.compiled.navigationTargets },
        scriptTokens: deps.compiled.spokenTokens,
        // §33.5: `:::literal-command` ranges are the authored, deterministic
        // half of command suppression — without them the only protection is
        // heuristic collision scoring.
        literalCommandRanges: deps.compiled.literalCommandRanges,
        getCursorTokenIndex: deps.getCursorTokenIndex,
        getContextRevision: () => deps.getCursorTokenIndex(),
        getScrollMode: deps.getScrollMode,
        getPosition: deps.getPosition,
        outline: flattenOutline(deps.compiled),
        bounds: DEFAULT_COMMAND_BOUNDS,
      },
      deps.commandSettings,
    );

    this.transport = new WebRtcTranscriptionTransport({
      invoke: ipcInvoke,
      acquireMicrophone: (deviceId) => this.acquireMicrophone(deviceId ?? this.preferredDeviceId),
      // §26.5 vocabulary boost. The transport has always had this injection
      // point and nothing ever filled it, so every unusual name in every
      // script was transcribed unassisted.
      //
      // The dep must be synchronous, so this reads the capability registry
      // fetched during `start()` rather than awaiting one here. Until that
      // resolves — and today in every case, because §26.1 says the realtime
      // model does not accept prompt steering — it returns `undefined`. The
      // point of wiring it is that a capability flag now decides, rather than
      // an absent call site.
      getVocabularyPrompt: () =>
        vocabularyPromptFor(
          deps.compiled.scriptId,
          deps.compiled.sourceHash,
          this.capabilities,
          deps.config.model,
        ),
    });
    this.commitDriver = new ManualCommitDriver({
      sendCommit: (reason) => this.transport.commit(reason),
      clearBufferedAudio: () => this.transport.clearBufferedAudio(),
      ledger: this.transport.ledger,
      getAlignmentAnchor: () => deps.getCursorTokenIndex(),
      // M1: VAD keeps firing across a reconnect; without this gate a turn that
      // ended mid-reconnect is committed against a connection that is gone.
      getConnectedGeneration: () => this.transport.connectedGeneration,
    });
    this.controller = new RealtimeSessionController({
      transport: this.transport,
      commitDriver: this.commitDriver,
      ...(deps.timers ? { timers: deps.timers } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      hooks: {
        /*
         * §29.2 steps 1–3. Supplied here rather than performed in the screen
         * that happens to precede the session, so the ORDER is owned by the
         * thing that specifies it. A rejection aborts `start()` before the
         * transport is subscribed or connected — nothing billable begins on a
         * session whose script, compile or stage was not ready.
         */
        ...(deps.startSequence
          ? {
              flushScriptSave: () => deps.startSequence!.flushScriptSave(),
              ensureCompiled: () => deps.startSequence!.ensureCompiled(),
              awaitStageAck: () => deps.startSequence!.awaitStageAck(),
            }
          : {}),
        /*
         * §28.1 explicit permission step. Strictly passive — `getUserMedia` is
         * the only thing that may prompt, it happens later inside
         * `acquireMicrophone`, and it may only follow an explicit user action.
         * All this does is refuse to walk the rest of the sequence when the OS
         * has already said no, which is the difference between "the microphone
         * failed to open" and "you have denied CandidCue the microphone".
         */
        requestPermission: () => this.checkMicrophonePermission(),
        /*
         * §29.2 step 8. The VAD used to start as a side effect of the transport
         * acquiring the microphone, which is both earlier than the spec says and
         * — worse — never stopped: a `start()` that threw took the
         * `failFromError` path, which called an unsupplied `stopVad`, and left a
         * polling AudioContext running on a session that never existed.
         */
        startVad: () => this.startVad(),
        stopVad: () => this.stopVad(),
        /** §29.2 step 9. */
        resetTranscriptState: () => this.resetTranscriptState(),
        onTranscriptEvent: (event) => this.handleTransportEvent(event),
        onStateChange: (state) => deps.onRealtimeState?.(state),
        onRecoverableIssue: (issue) => {
          // H5/H1: 'input_restored' is good news; everything else means the
          // session is not currently transcribing and must not read as live.
          if (issue === 'input_restored') {
            deps.onInputRestored?.();
            return;
          }
          deps.onConnectionState('reconnecting');
        },
        // H1: the UI must never stay green through a session-level failure.
        onSessionFailure: (code, fatal) => {
          deps.onConnectionState(fatal ? 'offline' : 'reconnecting');
          deps.onSessionFailure?.(code, fatal);
        },
        onFollowingHold: (held, reason) => deps.onFollowingHold?.(held, reason),
        onInputDeviceLost: (code) => deps.onInputDeviceLost?.(code),
        onPauseWarning: (ms) => deps.onPauseWarning?.(ms),
      },
    });
  }

  /** §29.2 start sequence; ends in `ready`. Billable streaming begins here. */
  async start(): Promise<void> {
    this.running = true;
    this.scheduleCommandTick();
    // Resolve capabilities before connecting, so the vocabulary supplier above
    // has an answer by the time the transport asks. A failure here is not a
    // session failure: `getModelCapabilities` already falls back to
    // UNKNOWN_CAPABILITIES, which is everything-off, so the session proceeds
    // without prompt steering rather than not at all.
    this.capabilities = await getModelCapabilities();
    try {
      await this.controller.start(this.deps.config);
    } catch (err) {
      // A start that never connected has no session to tick for. The 250 ms
      // ticker reschedules itself off `running`, so leaving it armed kept a
      // timer alive until the user happened to stop a session that had never
      // begun.
      this.running = false;
      this.stopCommandTick();
      throw err;
    }
    this.controller.startHealthChecks();
    this.watchDevices();
    this.deps.onConnectionState('connected');
  }

  /**
   * §33.11: drive `CommandRouter.tick` on a timer.
   *
   * `expireLuna` used to run only from `observe`, i.e. only when new transcript
   * arrived — and the whole failure it exists for is a Luna handoff that never
   * returns, which freezes the aligner in COMMAND_PENDING so no further
   * transcript is ever processed. The expiry could therefore never fire in the
   * one situation it was written for.
   *
   * The ticker is armed while the session is running and also for the lifetime
   * of any Luna handoff, so a pipeline that has not started a transport (and a
   * unit test) still gets the expiry.
   */
  private scheduleCommandTick(): void {
    if (this.commandTickTimer !== null || this.stopped) return;
    this.commandTickTimer = this.timers.setTimeout(() => {
      this.commandTickTimer = null;
      if (this.stopped) return;
      const observation = this.router.tick(this.now());
      // A bare `none` from `tick` means "nothing expired" — NOT "no command is
      // pending". Running it through `applyObservation` would call
      // `setPending(false)` and un-freeze the aligner on the very first tick,
      // which is the opposite of what the freeze is for.
      if (observation.kind !== 'none' || (observation.releaseItemIds?.length ?? 0) > 0) {
        this.applyObservation(observation);
      }
      if (this.running || this.router.hasPendingLuna()) this.scheduleCommandTick();
    }, COMMAND_TICK_INTERVAL_MS);
  }

  private stopCommandTick(): void {
    if (this.commandTickTimer === null) return;
    this.timers.clearTimeout(this.commandTickTimer);
    this.commandTickTimer = null;
  }

  /**
   * H5: watch `devicechange` so an unplugged or replaced input is noticed even
   * when the track itself does not end (macOS default-device switches in
   * particular). Nothing subscribed to this in production before.
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
      if (pinned) {
        this.deviceManager.select({ mode: 'specific', deviceId: pinned });
      }
      this.stopDeviceWatch = this.deviceManager.onDeviceChange((report) => {
        if (report.selectedDeviceLost) this.deps.onInputDeviceLost?.('MIC_DEVICE_LOST');
      });
    } catch {
      // Device enumeration is unavailable; track-level detection still applies.
    }
  }

  startListening(): void {
    this.controller.startListening();
  }

  /**
   * §28.2 mid-session input change — the recovery for a microphone unplugged
   * mid-take.
   *
   * The chosen id becomes this pipeline's device for everything that comes
   * after, not just the one track swap: a later reconnect mints a fresh
   * session and re-acquires, and re-opening the device that just vanished
   * would put the take straight back into the hold it was rescued from. The
   * `devicechange` watcher is re-pointed for the same reason.
   */
  async switchMicrophone(deviceId: string): Promise<void> {
    this.deviceOverride = deviceId;
    await this.controller.switchMicrophone(deviceId);
    try {
      this.deviceManager?.select({ mode: 'specific', deviceId });
    } catch {
      // Enumeration is a nicety; the track swap already succeeded.
    }
  }

  /** The device this pipeline should open, honouring any mid-session switch. */
  private get preferredDeviceId(): string | undefined {
    return this.deviceOverride ?? this.deps.deviceId;
  }

  softPause(): void {
    this.controller.softPause();
  }

  async resume(): Promise<void> {
    await this.controller.resume();
  }

  async hardPause(): Promise<void> {
    await this.controller.hardPause();
    await this.stopMonitor();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.stopCommandTick();
    this.stopDeviceWatch?.();
    this.stopDeviceWatch = null;
    this.router.cancelPending('session_stopped', this.now());
    try {
      await this.controller.stop();
    } finally {
      await this.stopMonitor();
    }
  }

  /** Realtime cost estimate for the F.17 summary (clearly an estimate). */
  estimatedCostUsd(): number {
    return this.controller.usage.estimate(this.deps.config.model).usd;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * §28.1/§29.2 step 4 precondition. Passive only: `queryMicrophonePermission`
   * uses the Permissions API and never calls `getUserMedia`, so this cannot
   * raise the OS prompt. `unsupported` and `prompt` both proceed — plenty of
   * WebViews do not answer the query, and the microphone open resolves
   * permission implicitly there, which is what the controller's hook contract
   * already says. Only an explicit `denied` stops the sequence.
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

  /**
   * §29.2 step 8. Idempotent, and safe to call before a stream exists: the
   * transport acquires the microphone during `connect`, which is step 5–7, so
   * by the time the controller reaches step 8 there is always a monitor waiting.
   */
  private async startVad(): Promise<void> {
    this.vadRequested = true;
    const monitor = this.monitor;
    if (!monitor || monitor.running || !this.activeStream) return;
    await monitor.start(this.activeStream);
  }

  /**
   * §29.2 step 8's counterpart, reached from stop, hard pause, AND the failed
   * start path. That last one is why this matters: nothing used to tear the
   * monitor down when the start sequence threw.
   */
  private async stopVad(): Promise<void> {
    this.vadRequested = false;
    await this.stopMonitor();
  }

  /**
   * §29.2 step 9 — clear old transcript state.
   *
   * The pipeline resets what it owns: any command handoff in flight, the commit
   * driver's buffered-turn bookkeeping, and the silence detector's history. The
   * alignment cursor and the session store's transcript tail live above this
   * layer and are reset through `onResetTranscriptState`.
   *
   * The `TranscriptLedger` is deliberately not cleared here: it is keyed by
   * session generation and clears itself when the generation moves, and forcing
   * it empty under an unchanged generation would discard commit ordering that
   * `UNIQUE(session_id, commit_sequence)` still depends on.
   */
  private resetTranscriptState(): void {
    this.router.cancelPending('session_stopped', this.now());
    this.commitDriver.reset();
    this.silentInput.reset();
    this.setPending(false);
    this.deps.onResetTranscriptState?.();
  }

  private async acquireMicrophone(deviceId?: string): Promise<MediaStreamLike> {
    await this.stopMonitor();
    const mediaDevices = navigator.mediaDevices as unknown as Parameters<
      typeof requestMicrophoneAccess
    >[0];
    const result = await requestMicrophoneAccess(mediaDevices, {
      deviceId,
      ...(this.deps.audioProcessing ?? {}),
    });
    if (!result.ok) {
      throw new Error(result.code);
    }
    this.activeStream = result.stream;
    // Local VAD drives manual commit boundaries (§28.4/§29.3).
    this.monitor = new MicrophoneMonitor({
      createGraph: createAnalyserGraph,
      ...(this.deps.vadSensitivity === undefined
        ? {}
        : { vadConfig: vadConfigForSensitivity(this.deps.vadSensitivity) }),
    });
    this.monitor.onVadEvent((event) => this.commitDriver.handleVadEvent(event));
    // H5: real captured audio is the precondition for the
    // `no_transcripts_despite_audio` health branch. Without a production
    // caller for `markAudioActivity` that check could never fire, which is why
    // a mic that had gone dead mid-take was never detected.
    this.silentInput.reset();
    this.monitor.onLevel((snapshot) => {
      if (snapshot.signalPresent) {
        this.controller.noteAudioActivity();
        this.silentInput.reset();
        return;
      }
      const code = this.silentInput.observe(snapshot);
      if (code) this.deps.onInputDeviceLost?.(code);
    });
    /*
     * §29.2 step 8 belongs to the controller, so the FIRST start leaves the
     * monitor built but idle and waits for `startVad`. Every later acquisition
     * — a reconnect, a mid-take device switch — happens underneath a session
     * that is already past step 8 and never re-enters it, so those restart the
     * VAD immediately or the session would come back with no commit boundaries
     * at all.
     */
    if (this.vadRequested) await this.monitor.start(result.stream);
    // §5.3: fan the SAME capture out to any extra consumer (the coaching
    // analyzer). This is deliberately after the monitor starts and before the
    // stream is returned to the transport, so all three consumers — peer
    // connection, level meter, analyzer — share one track and one clock.
    this.deps.onCaptureStream?.(result.stream);
    return result.stream;
  }

  private async stopMonitor(): Promise<void> {
    const monitor = this.monitor;
    this.monitor = null;
    if (monitor) await monitor.stop();
    releaseStream(this.activeStream);
    this.activeStream = null;
  }

  private handleTransportEvent(event: TransportEvent): void {
    const tracked = this.toTrackingEvent(event);
    if (tracked === null) return;

    if (tracked.type === 'transport_state') {
      this.deps.onConnectionState(
        tracked.state === 'connected'
          ? 'connected'
          : tracked.state === 'closed'
            ? 'offline'
            : 'reconnecting',
      );
      this.deps.onTrackingEvent(tracked);
      return;
    }

    this.ledger.apply(tracked);
    if (tracked.type === 'completed' && tracked.text.trim().length > 0) {
      const text = tracked.text.trim();
      this.deps.onTranscriptLine(text);
      // §36.2: the ledger owns commit ordering and the audio window, so the
      // retained record is built from it rather than re-derived here. An item
      // the ledger never saw is not persisted — a synthesized commit sequence
      // would collide on `UNIQUE(session_id, commit_sequence)` and silently
      // drop every later line.
      const item = this.ledger.getItem(tracked.itemId);
      if (item) {
        this.deps.onTranscriptItem?.({
          itemId: tracked.itemId,
          commitSequence: item.commitSequence,
          audioStartMs: item.audioStartMs,
          audioEndMs: item.audioEndMs,
          transcript: text,
        });
      }
    }

    // Command router runs between the ledger and the aligner (§33.4).
    if (this.deps.commandsEnabled !== false) {
      const observation = this.router.observe(this.deps.sessionGeneration, tracked.receivedAtMs);
      this.applyObservation(observation);
    }

    // Items consumed by the command channel never reach alignment; the
    // ledger inside the worker applies the same masking via mask_items.
    this.deps.onTrackingEvent(tracked);
  }

  private applyObservation(observation: CommandObservation): void {
    switch (observation.kind) {
      case 'none':
        this.setPending(false);
        // §33.4 tail: a wake-like phrase the collision scorer ruled authored
        // script hands its items BACK to alignment. Without this the sentence
        // the presenter was reading when a spurious wake fired is excluded for
        // the rest of the session.
        if (observation.releaseItemIds !== undefined && observation.releaseItemIds.length > 0) {
          this.deps.onReleaseItems(observation.releaseItemIds);
        }
        return;
      case 'pending':
        this.setPending(true);
        this.deps.onMaskItems(observation.itemIds);
        return;
      case 'command':
        this.setPending(false);
        this.deps.onMaskItems(observation.itemIds);
        // H8: every validated command goes through the §33.9 execution policy.
        // Previously `requiresConfirmation` was carried faithfully all the way
        // from Luna and then dropped on the floor here — an ambiguous "go to
        // conclusion", or a stop mid-take, executed and acknowledged anyway.
        void this.executeWithPolicy(observation.command);
        return;
      case 'needs_luna':
        // The aligner is frozen for the whole handoff. Saying so explicitly
        // (rather than relying on a preceding `pending` having done it) is what
        // makes the un-freeze in `resolveLuna` unconditional and provable.
        this.setPending(true);
        this.deps.onMaskItems(observation.itemIds);
        this.scheduleCommandTick();
        void this.resolveLuna(observation.candidate.id, observation.request);
        return;
      case 'unknown':
        this.setPending(false);
        this.deps.onMaskItems(observation.itemIds);
        this.deps.onUnknownCommand(observation.message);
        return;
    }
  }

  /**
   * H8: apply the execution policy, then execute — and acknowledge ONLY after
   * the action the user actually agreed to has been performed.
   */
  private async executeWithPolicy(command: ValidatedCommand): Promise<void> {
    const state: ExecutionState = this.deps.getExecutionState?.() ?? {
      hardPaused: false,
      takeInProgress: false,
      confirmStopDuringTake: true,
    };
    const decision = decideExecution(command.action, state, command.requiresConfirmation === true);

    if (decision.decision === 'reject') {
      this.router.acknowledgeRejected(command.humanLabel, this.now());
      this.deps.onCommandRejected?.(command, decision.reason);
      return;
    }

    if (decision.decision === 'confirm') {
      this.router.acknowledgeConfirmRequired(command, this.now());
      // No confirmation surface wired: refuse rather than act. Executing an
      // ambiguous jump or a stop the user did not confirm is worse than
      // doing nothing.
      if (!this.deps.confirmCommand) {
        this.deps.onCommandRejected?.(command, decision.reason);
        return;
      }
      let confirmed = false;
      try {
        confirmed = await this.deps.confirmCommand(command, decision.reason);
      } catch {
        confirmed = false;
      }
      // The session may have ended while the prompt was open.
      if (!confirmed || this.stopped) {
        this.deps.onCommandRejected?.(command, decision.reason);
        return;
      }
    }

    this.deps.executeCommand(command);
    this.router.acknowledgeExecuted(command, this.now(), true);
  }

  /**
   * Luna handoff (§33.7): `interpret_command` is NOT_IMPLEMENTED in v1 Rust;
   * failures resolve the candidate as unknown so parsing stays deterministic.
   *
   * §33.11: the invoke is raced against `lunaHardTimeoutMs` and the freeze is
   * released in a `finally`, so a rejected, hung, or superseded handoff ALWAYS
   * un-freezes the aligner. The engine's `commandPendingTimeoutMs` backstop
   * still exists, but a four-second stall mid-take is a ruined take — the
   * backstop is a safety net, not the fix.
   */
  private async resolveLuna(candidateId: string, request: unknown): Promise<void> {
    let timeout: unknown = null;
    try {
      const raw = await Promise.race<unknown>([
        // Luna unavailable → deterministic-only degradation, never a throw.
        ipcInvoke('interpret_command', { request }).catch(() => null),
        new Promise<null>((resolve) => {
          timeout = this.timers.setTimeout(
            () => resolve(null),
            this.router.settings.lunaHardTimeoutMs,
          );
        }),
      ]);
      if (this.stopped) return;
      this.applyObservation(this.router.resolveLuna(candidateId, raw, this.now()));
    } catch {
      // Nothing above is allowed to reject; a defect here must still un-freeze.
    } finally {
      if (timeout !== null) this.timers.clearTimeout(timeout);
      this.setPending(false);
    }
  }

  private setPending(pending: boolean): void {
    if (pending === this.commandPending) return;
    this.commandPending = pending;
    this.deps.onCommandPending(pending);
  }

  private toTrackingEvent(event: TransportEvent): TrackingEvent | null {
    const receivedAtMs = this.now();
    const sessionGeneration = this.deps.sessionGeneration;
    switch (event.type) {
      case 'item_started':
        return {
          type: 'item_started',
          sessionGeneration,
          itemId: event.itemId,
          commitSequence: event.commitSequence,
          audioStartMs: receivedAtMs,
          receivedAtMs,
        };
      case 'delta':
        return {
          type: 'delta',
          sessionGeneration,
          itemId: event.itemId,
          text: event.text,
          receivedAtMs,
        };
      case 'completed':
        return {
          type: 'completed',
          sessionGeneration,
          itemId: event.itemId,
          text: event.text,
          ...(event.logprobs ? { logprobs: event.logprobs } : {}),
          receivedAtMs,
        };
      case 'failed':
        return {
          type: 'failed',
          sessionGeneration,
          ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
          code: event.code,
          recoverable: event.recoverable,
          receivedAtMs,
        };
      case 'transport_state':
        return {
          type: 'transport_state',
          sessionGeneration,
          state:
            event.state === 'connected'
              ? 'connected'
              : event.state === 'connecting'
                ? 'connecting'
                : event.state === 'reconnecting'
                  ? 'degraded'
                  : 'closed',
          receivedAtMs,
        };
      default:
        return null;
    }
  }
}

function flattenOutline(compiled: CompiledScript): Array<{ level: number; title: string }> {
  const out: Array<{ level: number; title: string }> = [];
  const walk = (nodes: CompiledScript['outline']): void => {
    for (const node of nodes) {
      out.push({ level: node.level, title: node.title });
      walk(node.children);
    }
  };
  walk(compiled.outline);
  return out;
}
