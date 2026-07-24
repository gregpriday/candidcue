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
  releaseStream,
  requestMicrophoneAccess,
  SilentInputDetector,
  type MediaStreamLike,
} from './audio';
import {
  ManualCommitDriver,
  RealtimeSessionController,
  WebRtcTranscriptionTransport,
} from './realtime';
import { ipcInvoke } from './ipc';

export interface VoicePipelineDeps {
  sessionId: string;
  sessionGeneration: number;
  compiled: CompiledScript;
  config: TranscriptionConfig;
  commandSettings?: Partial<CommandSettings>;
  /** Voice-command listening toggle (§14.2 D); alignment still runs. */
  commandsEnabled?: boolean;
  deviceId?: string;
  getCursorTokenIndex(): number;
  getPosition(): { blockId: string; sentenceId: string; tokenIndex: number };
  getScrollMode(): 'voice' | 'manual' | 'fixed';
  /** Reconciled transcript events destined for the tracking worker. */
  onTrackingEvent(event: TrackingEvent): void;
  /** Command-consumed items to exclude from alignment (§33.4). */
  onMaskItems(itemIds: string[]): void;
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
  /** Final transcript lines for the Live transcript tail. */
  onTranscriptLine(line: string): void;
  onConnectionState(state: 'connected' | 'reconnecting' | 'offline'): void;
  onRealtimeState?(state: RealtimeState): void;
  /**
   * H5: following must visibly stop while transcription is untrustworthy —
   * dead input, no transcripts despite audio, or a reconnect in progress.
   */
  onFollowingHold?(held: boolean, reason: string | null): void;
  /** H5: the input device is gone; the user must pick another (§28.6). */
  onInputDeviceLost?(code: string): void;
  /** H1: a session-level provider failure ended or interrupted the session. */
  onSessionFailure?(code: string, fatal: boolean): void;
  /** M3: soft pause will auto-disconnect in `msRemaining` (A.6). */
  onPauseWarning?(msRemaining: number): void;
}

export class VoiceSessionPipeline {
  readonly ledger = new TranscriptLedger();
  readonly router: CommandRouter;
  readonly controller: RealtimeSessionController;
  private readonly transport: WebRtcTranscriptionTransport;
  private readonly commitDriver: ManualCommitDriver;
  private monitor: MicrophoneMonitor | null = null;
  private activeStream: MediaStreamLike | null = null;
  private commandPending = false;
  private stopped = false;
  /** H5: sustained no-signal detection on the captured stream (§28.6). */
  private readonly silentInput = new SilentInputDetector();
  /** H5: `devicechange` watcher for unplug / default-device changes. */
  private deviceManager: MicrophoneDeviceManager | null = null;
  private stopDeviceWatch: (() => void) | null = null;

  constructor(private readonly deps: VoicePipelineDeps) {
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
      acquireMicrophone: (deviceId) => this.acquireMicrophone(deviceId ?? deps.deviceId),
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
      hooks: {
        onTranscriptEvent: (event) => this.handleTransportEvent(event),
        onStateChange: (state) => deps.onRealtimeState?.(state),
        onRecoverableIssue: (issue) => {
          // H5/H1: 'input_restored' is good news; everything else means the
          // session is not currently transcribing and must not read as live.
          if (issue !== 'input_restored') deps.onConnectionState('reconnecting');
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
    await this.controller.start(this.deps.config);
    this.controller.startHealthChecks();
    this.watchDevices();
    this.deps.onConnectionState('connected');
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
      if (this.deps.deviceId) {
        this.deviceManager.select({ mode: 'specific', deviceId: this.deps.deviceId });
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
    this.stopDeviceWatch?.();
    this.stopDeviceWatch = null;
    this.router.cancelPending('session_stopped', Date.now());
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

  private async acquireMicrophone(deviceId?: string): Promise<MediaStreamLike> {
    await this.stopMonitor();
    const mediaDevices = navigator.mediaDevices as unknown as Parameters<
      typeof requestMicrophoneAccess
    >[0];
    const result = await requestMicrophoneAccess(mediaDevices, { deviceId });
    if (!result.ok) {
      throw new Error(result.code);
    }
    this.activeStream = result.stream;
    // Local VAD drives manual commit boundaries (§28.4/§29.3).
    this.monitor = new MicrophoneMonitor({ createGraph: createAnalyserGraph });
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
    await this.monitor.start(result.stream);
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
      this.deps.onTranscriptLine(tracked.text.trim());
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
        this.deps.onMaskItems(observation.itemIds);
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
      this.router.acknowledgeRejected(command.humanLabel, Date.now());
      this.deps.onCommandRejected?.(command, decision.reason);
      return;
    }

    if (decision.decision === 'confirm') {
      this.router.acknowledgeConfirmRequired(command, Date.now());
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
    this.router.acknowledgeExecuted(command, Date.now(), true);
  }

  /**
   * Luna handoff (§33.7): `interpret_command` is NOT_IMPLEMENTED in v1 Rust;
   * failures resolve the candidate as unknown so parsing stays deterministic.
   */
  private async resolveLuna(candidateId: string, request: unknown): Promise<void> {
    let raw: unknown = null;
    try {
      raw = await ipcInvoke('interpret_command', { request });
    } catch {
      raw = null; // Luna unavailable — deterministic-only degradation.
    }
    const observation = this.router.resolveLuna(candidateId, raw, Date.now());
    this.applyObservation(observation);
  }

  private setPending(pending: boolean): void {
    if (pending === this.commandPending) return;
    this.commandPending = pending;
    this.deps.onCommandPending(pending);
  }

  private toTrackingEvent(event: TransportEvent): TrackingEvent | null {
    const receivedAtMs = Date.now();
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
