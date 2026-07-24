/**
 * Realtime session lifecycle controller (spec §29).
 *
 * Owns the centralized state machine and drives the transport through the
 * start sequence (§29.2), soft/hard pause and stop semantics (§29.7),
 * keepalive-driven reconnects with fresh credentials (§29.6), and
 * sleep/wake handling (§29.8). Everything outside this package (script
 * save flush, compile gate, stage acknowledgement, transcript consumers)
 * is injected as hooks so the UI facade can bind without circular deps.
 */
import type {
  RealtimeState,
  RealtimeTranscriptionTransport,
  TranscriptEvent,
  TranscriptionConfig,
  Unsubscribe,
} from '../../../shared/contracts';
import type { Clock } from '../audio/types';
import { DEFAULT_SOFT_PAUSE_AUTO_DISCONNECT_MS } from '../audio/defaults';
import type { ManualCommitDriver } from './commitDriver';
import { RealtimeTransportError } from './errors';
import {
  DEFAULT_HEALTH_MONITOR_CONFIG,
  SessionHealthMonitor,
  type HealthIssue,
} from './healthMonitor';
import { DEFAULT_RECONNECT_POLICY, ReconnectScheduler, type ReconnectPolicyConfig } from './reconnect';
import { RealtimeStateMachine, type StateChangeListener } from './stateMachine';
import { SessionUsageTracker } from './costEstimator';
import type { TransportTimers } from './webrtcTransport';

export interface SessionControllerHooks {
  /** §29.2 step 1 — flush the current script save. */
  flushScriptSave?: () => Promise<void>;
  /** §29.2 step 2 — compile; must reject on blocking diagnostics. */
  ensureCompiled?: () => Promise<void>;
  /** §29.2 step 3 — load stage data and await stage acknowledgement. */
  awaitStageAck?: () => Promise<void>;
  /**
   * §28.1 — explicit permission step. Return false when the user declined.
   * When omitted, permission is resolved implicitly by microphone open.
   */
  requestPermission?: () => Promise<boolean>;
  /** §29.2 step 8 — start local VAD. */
  startVad?: () => void | Promise<void>;
  stopVad?: () => void | Promise<void>;
  /** §29.2 step 9 — clear old transcript buffer, reset alignment cursor. */
  resetTranscriptState?: () => void;
  onTranscriptEvent?: (event: TranscriptEvent) => void;
  onStateChange?: StateChangeListener;
  /** §29.6 — surface "Reconnecting — position held" style notices. */
  onRecoverableIssue?: (issue: HealthIssue | RecoverableIssue) => void;
  /**
   * H1: a SESSION-level provider failure (no item id). Fatal codes end the
   * session; recoverable ones enter bounded reconnect. Either way the UI must
   * stop claiming to be live — this is the hook that guarantees it.
   */
  onSessionFailure?: (code: string, fatal: boolean) => void;
  /**
   * H5: transcription is not trustworthy right now (dead input, no transcripts
   * despite audio, reconnecting). While held, the follower must NOT advance —
   * a teleprompter scrolling on stale or absent speech is worse than one that
   * visibly stops.
   */
  onFollowingHold?: (held: boolean, reason: FollowingHoldReason | null) => void;
  /** H5: the input device is gone and a device choice is required. */
  onInputDeviceLost?: (code: string) => void;
  /** M3: soft pause is about to auto-disconnect in `msRemaining`. */
  onPauseWarning?: (msRemaining: number) => void;
}

/** M3: warn this long before the soft-pause auto-disconnect fires. */
export const DEFAULT_PAUSE_WARNING_LEAD_MS = 60_000;

export type RecoverableIssue =
  | 'connection_lost'
  | 'input_lost'
  | 'input_silent'
  | 'input_restored'
  | 'pause_auto_disconnect';

export type FollowingHoldReason =
  | 'reconnecting'
  | 'input_lost'
  | 'input_silent'
  | 'no_transcripts';

/**
 * H5: local input failures that mean "audio is not reaching the provider".
 * They arrive as session-level `failed` events from the transport's track
 * watcher, and are NOT provider errors — reconnecting to OpenAI cannot fix an
 * unplugged microphone, so they take the device-recovery path instead.
 */
const INPUT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'MIC_DEVICE_LOST',
  'MIC_DEVICE_MISSING',
  'MIC_NO_SIGNAL',
  'MIC_PERMISSION_DENIED',
]);

export interface SessionControllerDeps {
  transport: RealtimeTranscriptionTransport;
  hooks?: SessionControllerHooks;
  /** When provided, pause/stop/mic-switch force commits through the driver. */
  commitDriver?: ManualCommitDriver;
  reconnectPolicy?: ReconnectPolicyConfig;
  /** M3: soft-pause auto-disconnect budget (A.6 default: 10 minutes). */
  pauseAutoDisconnectMs?: number;
  /** M3: how long before auto-disconnect the warning fires. */
  pauseWarningLeadMs?: number;
  usage?: SessionUsageTracker;
  health?: SessionHealthMonitor;
  timers?: TransportTimers;
  now?: Clock;
  random?: () => number;
}

export class RealtimeSessionController {
  readonly machine = new RealtimeStateMachine();
  readonly usage: SessionUsageTracker;
  readonly health: SessionHealthMonitor;

  private readonly hooks: SessionControllerHooks;
  private readonly timers: TransportTimers;
  private readonly now: Clock;
  private reconnectScheduler: ReconnectScheduler;
  private readonly reconnectPolicy: ReconnectPolicyConfig;
  private readonly random: () => number;

  private config: TranscriptionConfig | null = null;
  private transportUnsubscribe: Unsubscribe | null = null;
  private healthTimer: unknown | null = null;
  /** Set by system suspend; resume then requires a fresh connection (§29.8). */
  private interrupted = false;
  private reconnectInFlight = false;
  /**
   * H3: interval the caller asked for, so every path that re-establishes a
   * connection can restart health monitoring with the same cadence. Suspend
   * used to stop the timer and nothing ever started it again — the session
   * came back with no liveness checking at all.
   */
  private healthIntervalMs = 5_000;
  private healthChecksRequested = false;
  /**
   * H2/H3: bumped by stop/hard-pause/suspend. Any reconnect loop or backoff
   * sleep in flight compares against it after every await and abandons itself,
   * so a stopped session can never be revived by a retry that was already
   * queued.
   */
  private lifecycleGeneration = 0;
  /** H5: current following-hold reason, or null when following may advance. */
  private holdReason: FollowingHoldReason | null = null;
  /** M3: soft-pause auto-disconnect timers. */
  private pauseTimer: unknown | null = null;
  private pauseWarnTimer: unknown | null = null;
  private readonly pauseAutoDisconnectMs: number;
  private readonly pauseWarningLeadMs: number;

  constructor(private readonly deps: SessionControllerDeps) {
    this.hooks = deps.hooks ?? {};
    this.usage = deps.usage ?? new SessionUsageTracker(deps.now);
    this.health = deps.health ?? new SessionHealthMonitor(DEFAULT_HEALTH_MONITOR_CONFIG, deps.now);
    this.timers = deps.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
    };
    this.now = deps.now ?? (() => Date.now());
    this.reconnectPolicy = deps.reconnectPolicy ?? DEFAULT_RECONNECT_POLICY;
    this.random = deps.random ?? Math.random;
    this.reconnectScheduler = new ReconnectScheduler(this.reconnectPolicy, this.random);
    this.pauseAutoDisconnectMs =
      deps.pauseAutoDisconnectMs ?? DEFAULT_SOFT_PAUSE_AUTO_DISCONNECT_MS;
    this.pauseWarningLeadMs = deps.pauseWarningLeadMs ?? DEFAULT_PAUSE_WARNING_LEAD_MS;
    if (this.hooks.onStateChange) this.machine.onChange(this.hooks.onStateChange);
  }

  get state(): RealtimeState {
    return this.machine.state;
  }

  /**
   * Start sequence (§29.2 steps 1–10): ends in `ready`. Billable streaming
   * begins here, so callers must only invoke it from an explicit user start
   * — never merely because the preflight screen opened.
   */
  async start(config: TranscriptionConfig): Promise<void> {
    this.config = config;
    this.machine.transition('start'); // → requesting_permission
    // A fresh start owns a fresh generation: anything queued by a previous
    // attempt (reconnect retry, backoff sleep) is now irrelevant.
    this.lifecycleGeneration += 1;
    const generation = this.lifecycleGeneration;
    this.reconnectInFlight = false;
    this.releaseAllHolds();

    try {
      await this.hooks.flushScriptSave?.();
      await this.hooks.ensureCompiled?.();
      await this.hooks.awaitStageAck?.();

      if (this.hooks.requestPermission) {
        const granted = await this.hooks.requestPermission();
        if (!granted) {
          throw new RealtimeTransportError('MIC_PERMISSION_DENIED', 'Permission declined', true);
        }
      }
      this.machine.transition('permission_granted'); // → opening_microphone

      this.subscribeTransport();
      await this.deps.transport.connect(config);
      // H2: the user may have pressed Stop while the mic was opening or the
      // SDP exchange was stalling. The transport cancels its own attempt, but
      // if it happened to complete first we must not publish a live session
      // over a stopped one.
      if (generation !== this.lifecycleGeneration) {
        await this.deps.transport.disconnect('stop').catch(() => {});
        throw new RealtimeTransportError(
          'REALTIME_CONNECTION_LOST',
          'Session was stopped during start',
          true,
        );
      }

      // Walk any sub-states the transport did not report via progress wiring.
      this.machine.tryTransition('microphone_open');
      this.machine.tryTransition('credential_minted');
      this.machine.tryTransition('negotiated'); // → ready

      this.usage.markConnected();
      this.health.reset();
      this.health.setCredentialExpiry(
        this.deps.transport.getDiagnostics().credentialExpiresAtEpochMs ?? null,
      );
      this.hooks.resetTranscriptState?.();
      await this.hooks.startVad?.();
      this.interrupted = false;
      this.reconnectScheduler.reset();
    } catch (error) {
      await this.failFromError(error);
      throw error;
    }
  }

  /**
   * Mirror transport connect progress onto the state machine. Wire the
   * WebRTC transport's `onConnectProgress` dep to this method.
   */
  handleConnectProgress(phase: 'opening_microphone' | 'minting_credential' | 'negotiating'): void {
    if (phase === 'minting_credential') this.machine.tryTransition('microphone_open');
    if (phase === 'negotiating') this.machine.tryTransition('credential_minted');
  }

  /**
   * §29.2 step 11–12 — user presses Start; begin committing speech.
   *
   * Tolerant by construction. The Live transport is the operator's MANUAL
   * fallback, and it is reached for precisely when the realtime session has
   * already died — `fatal_error` has no `start_listening` edge, so the throwing
   * `transition` used to escape the click handler as an uncaught
   * `InvalidTransitionError` and take the whole press with it. A dead session
   * has no listening to start; that is a no-op, not an exception. The state is
   * already reported honestly by the connection/microphone pills, so nothing is
   * hidden by declining quietly here.
   */
  startListening(): void {
    this.machine.tryTransition('start_listening');
  }

  /** Soft pause: session stays connected and billable (§29.7). */
  softPause(): void {
    // Same reasoning as `startListening`: there is nothing to pause on a dead
    // or not-yet-listening session, and pausing must never throw out of the
    // transport. Guarding before the commit keeps the driver from flushing a
    // commit for a pause that cannot happen.
    if (!this.machine.canTransition('soft_pause')) return;
    this.deps.commitDriver?.forceCommit('soft_pause');
    this.machine.transition('soft_pause');
    this.startPauseTimer();
  }

  // -- M3 soft-pause auto-disconnect (A.6: 10 minutes) ---------------------

  /**
   * A soft pause keeps the connection, the microphone and the billing meter
   * live. `DEFAULT_SOFT_PAUSE_AUTO_DISCONNECT_MS` existed but nothing
   * implemented it, so walking away from a paused session left all three
   * running indefinitely. Warn first, then disconnect deterministically.
   */
  private startPauseTimer(): void {
    this.clearPauseTimer();
    const total = this.pauseAutoDisconnectMs;
    if (!Number.isFinite(total) || total <= 0) return;
    const warnAt = Math.max(0, total - this.pauseWarningLeadMs);
    const generation = this.lifecycleGeneration;

    this.pauseWarnTimer = this.timers.setTimeout(() => {
      this.pauseWarnTimer = null;
      if (generation !== this.lifecycleGeneration) return;
      if (this.machine.state !== 'soft_paused') return;
      this.hooks.onPauseWarning?.(total - warnAt);
    }, warnAt);

    this.pauseTimer = this.timers.setTimeout(() => {
      this.pauseTimer = null;
      if (generation !== this.lifecycleGeneration) return;
      if (this.machine.state !== 'soft_paused') return;
      this.hooks.onRecoverableIssue?.('pause_auto_disconnect');
      // Hard-pause semantics: connection and microphone released, position
      // held, resume negotiates fresh.
      void this.hardPause().catch(() => {});
    }, total);
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer !== null) {
      this.timers.clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.pauseWarnTimer !== null) {
      this.timers.clearTimeout(this.pauseWarnTimer);
      this.pauseWarnTimer = null;
    }
  }

  /**
   * Resume (§29.7/§29.8).
   *
   * H3: hard pause tears the transport down, unsubscribes and lands in `idle`,
   * so there is nothing left to "resume" — the old code called the reconnect
   * helper without re-subscribing and then attempted an illegal
   * `idle -> resume` transition, which threw. A resume that needs a connection
   * is therefore a FULL fresh start: subscribe → mic → connect → health checks,
   * and only then is the session live.
   */
  async resume(): Promise<void> {
    if (this.needsFreshSession()) {
      const config = this.config;
      if (!config) {
        throw new RealtimeTransportError(
          'REALTIME_CONNECTION_LOST',
          'No session configuration to resume',
          true,
        );
      }
      // H3: the teardown below clears the monitoring flag, but a resume is a
      // continuation of the same session — if health checks were running
      // before the pause/sleep they must be running after it. Forgetting this
      // is how a resumed session ends up with no liveness checking at all.
      const wasMonitoring = this.healthChecksRequested;
      const interval = this.healthIntervalMs;
      await this.resetToIdle();
      await this.start(config);
      if (wasMonitoring) this.startHealthChecks(interval);
      // A fresh start lands in `ready`; the user is listening again only once
      // that succeeded. Errors propagate — silently swallowing them is what
      // let the UI show a live microphone over a dead session.
      this.machine.tryTransition('start_listening');
      return;
    }
    // Tolerant for the same reason as `startListening`/`softPause`: a resume
    // pressed on a session that is already listening is a no-op, not a crash
    // out of the transport. A session that genuinely needs a new connection
    // took the branch above, where failures still propagate to the caller.
    this.machine.tryTransition('resume');
  }

  /**
   * H3: unwind whatever state we are in back to `idle` so `start()` can run
   * its full sequence. Terminal error states leave via `reset`, live states
   * via the normal stop path; both release the transport and the microphone.
   */
  private async resetToIdle(): Promise<void> {
    if (this.machine.state === 'fatal_error' || this.machine.state === 'recoverable_error') {
      this.lifecycleGeneration += 1;
      this.reconnectInFlight = false;
      this.reconnectScheduler.reset();
      await this.deps.transport.disconnect('stop').catch(() => {});
      if (this.transportUnsubscribe) {
        this.transportUnsubscribe();
        this.transportUnsubscribe = null;
      }
      this.releaseAllHolds();
      this.machine.tryTransition('reset');
      return;
    }
    if (this.machine.state !== 'idle') {
      await this.teardown('hard_pause', { clearTranscripts: false });
    }
  }

  /**
   * True when resuming requires negotiating a new connection rather than
   * simply leaving soft pause.
   */
  private needsFreshSession(): boolean {
    if (this.machine.state === 'idle' || this.machine.state === 'fatal_error') return true;
    if (this.machine.state === 'recoverable_error') return true;
    return this.interrupted || this.transportDisconnected();
  }

  /** Hard pause: disconnect Realtime, stop mic; resume needs a fresh session (§29.7). */
  async hardPause(): Promise<void> {
    await this.teardown('hard_pause', { clearTranscripts: false });
  }

  /** Stop: end the take; ephemeral credentials and transcript data cleared (§29.7). */
  async stop(): Promise<void> {
    await this.teardown('stop', { clearTranscripts: true });
  }

  /** System suspend detected (§29.8): close connections, remain paused. */
  async handleSuspend(): Promise<void> {
    if (this.machine.state === 'idle' || this.machine.state === 'stopping') return;
    this.interrupted = true;
    // H3: abandon any reconnect loop or backoff sleep in flight. Without this
    // a retry queued before the machine slept would fire on wake and reconnect
    // a session the user believes is paused.
    this.lifecycleGeneration += 1;
    this.reconnectInFlight = false;
    this.reconnectScheduler.reset();
    this.deps.commitDriver?.forceCommit('mic_disconnect');
    this.machine.tryTransition('suspend'); // active states → soft_paused
    this.usage.markDisconnected();
    this.stopHealthChecks();
    this.applyHold('reconnecting');
    await this.deps.transport.disconnect('sleep');
  }

  /**
   * On wake, stay paused (§29.8). The next `resume()` call — an explicit
   * user action — negotiates the fresh connection.
   */
  handleWake(): void {
    // Intentionally passive; state is already soft_paused/interrupted.
  }

  /** Begin periodic keepalive checks (§29.6). */
  startHealthChecks(intervalMs = this.healthIntervalMs): void {
    this.stopHealthChecks();
    this.healthIntervalMs = intervalMs;
    // H3: remember that monitoring was asked for, so every path that
    // re-establishes a connection (reconnect, resume-after-sleep) restarts it.
    // Suspend stopped the timer and nothing ever started it again, leaving a
    // resumed session with no liveness checking whatsoever.
    this.healthChecksRequested = true;
    const tick = () => {
      this.healthTimer = this.timers.setTimeout(tick, intervalMs);
      void this.evaluateHealth();
    };
    this.healthTimer = this.timers.setTimeout(tick, intervalMs);
  }

  /** Restart monitoring after a reconnect, but only if it was ever running. */
  private restartHealthChecks(): void {
    if (!this.healthChecksRequested) return;
    this.startHealthChecks(this.healthIntervalMs);
  }

  stopHealthChecks(): void {
    if (this.healthTimer !== null) {
      this.timers.clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  async evaluateHealth(): Promise<void> {
    const issues = this.health.check(this.now());
    if (issues.includes('suspend_detected')) {
      await this.handleSuspend();
      return;
    }
    if (issues.includes('credential_expiring') || issues.includes('stale_server_events')) {
      if (this.isActive()) {
        this.hooks.onRecoverableIssue?.(
          issues.includes('credential_expiring') ? 'credential_expiring' : 'stale_server_events',
        );
        await this.handleConnectionLost();
      }
      return;
    }
    if (issues.includes('no_transcripts_despite_audio')) {
      // H5: this is THE silent-death signature — the presenter is audibly
      // speaking, the peer connection is up, and no transcripts are coming
      // back. Reporting it and doing nothing left a green UI over a dead
      // session for the rest of the take. Hold following first (so the
      // teleprompter visibly stops rather than drifting on stale text), then
      // rebuild the connection.
      this.hooks.onRecoverableIssue?.('no_transcripts_despite_audio');
      if (this.isActive()) {
        this.applyHold('no_transcripts');
        await this.handleConnectionLost();
      }
    }
  }

  // -- internals -----------------------------------------------------------

  private subscribeTransport(): void {
    if (this.transportUnsubscribe) return;
    this.transportUnsubscribe = this.deps.transport.onEvent((event) => {
      // H5: only events that genuinely came FROM the provider count as proof
      // the server is alive. Marking health on every transport event — including
      // our own local `transport_state` and input notices — let unrelated
      // bookkeeping mask a connection that had stopped transcribing.
      if (isProviderEvent(event)) this.health.markServerEvent(this.now());
      if (event.type === 'completed') {
        this.health.markCompletedItem(this.now());
        // Real transcription is flowing; whatever we were holding for is over.
        this.releaseHold('no_transcripts');
      }

      // A subscriber that throws must never take the lifecycle down with it:
      // dropping the recovery decision below is exactly the "UI still says
      // connected" failure this whole pass exists to remove.
      try {
        this.hooks.onTranscriptEvent?.(event);
      } catch {
        // consumer-side fault; recovery continues
      }

      if (event.type === 'input_restored') {
        this.releaseHold('input_lost');
        this.releaseHold('input_silent');
        this.hooks.onRecoverableIssue?.('input_restored');
        return;
      }
      if (event.type === 'failed') void this.handleFailureEvent(event);
    });
  }

  /**
   * H1: route a `failed` event to the right owner.
   *
   * - ITEM-level (has an item id): one utterance failed to transcribe. The
   *   session is fine; the ledger already handles it.
   * - SESSION-level input failure: audio is not reaching the provider.
   *   Reconnecting cannot fix an unplugged mic, so hold following and ask for
   *   a device instead of burning the retry budget.
   * - SESSION-level fatal (auth/quota/model): stop now. Retrying an
   *   `insufficient_quota` is both useless and billable.
   * - SESSION-level recoverable: bounded reconnect.
   *
   * Previously ONLY `REALTIME_CONNECTION_LOST` was acted on, so a provider
   * `insufficient_quota` at minute 45 stopped transcription while the UI
   * stayed green for the rest of the take.
   */
  private async handleFailureEvent(event: {
    type: 'failed';
    itemId?: string;
    code: string;
    recoverable: boolean;
  }): Promise<void> {
    if (event.itemId !== undefined) return; // item-level: not a session event

    if (INPUT_FAILURE_CODES.has(event.code)) {
      this.handleInputFailure(event.code);
      return;
    }
    if (!event.recoverable) {
      await this.failFatally(event.code);
      return;
    }
    if (this.isActive()) await this.handleConnectionLost();
  }

  /**
   * H5: local audio input died. The peer connection is still perfectly
   * healthy, so nothing else in the stack notices — this is the single worst
   * silent-failure shape in the product.
   */
  private handleInputFailure(code: string): void {
    if (!this.isActive()) return;
    const reason: FollowingHoldReason = code === 'MIC_NO_SIGNAL' ? 'input_silent' : 'input_lost';
    this.applyHold(reason);
    this.hooks.onRecoverableIssue?.(reason === 'input_silent' ? 'input_silent' : 'input_lost');
    // A missing device needs a human choice, not a retry loop.
    if (reason === 'input_lost') this.hooks.onInputDeviceLost?.(code);
  }

  /** Fatal session failure: tear down and land in `fatal_error` (§35.4, E.7). */
  private async failFatally(code: string): Promise<void> {
    this.lifecycleGeneration += 1; // abandon any reconnect in flight
    this.applyHold('reconnecting');
    this.stopHealthChecks();
    this.usage.markDisconnected();
    this.hooks.onSessionFailure?.(code, true);
    try {
      await this.deps.transport.disconnect('error');
    } catch {
      // best-effort cleanup
    }
    this.machine.tryTransition('fatal_error');
  }

  // -- H5 following hold ----------------------------------------------------

  private applyHold(reason: FollowingHoldReason): void {
    if (this.holdReason === reason) return;
    this.holdReason = reason;
    this.hooks.onFollowingHold?.(true, reason);
  }

  private releaseHold(reason: FollowingHoldReason): void {
    if (this.holdReason !== reason) return;
    this.holdReason = null;
    this.hooks.onFollowingHold?.(false, null);
  }

  private releaseAllHolds(): void {
    if (this.holdReason === null) return;
    this.holdReason = null;
    this.hooks.onFollowingHold?.(false, null);
  }

  /** True while transcription is not trustworthy (H5). */
  get followingHeld(): boolean {
    return this.holdReason !== null;
  }

  /**
   * H5: report that real audio is being captured. Wire this to the local level
   * meter. Without it the `no_transcripts_despite_audio` health branch can
   * never fire, because it requires recent audio activity as its precondition
   * — the check existed but had no production caller, so it was unarmed.
   */
  noteAudioActivity(atMs = this.now()): void {
    this.health.markAudioActivity(atMs);
  }

  private isActive(): boolean {
    return ['ready', 'listening', 'soft_paused'].includes(this.machine.state);
  }

  private transportDisconnected(): boolean {
    const state = this.deps.transport.getDiagnostics().transportState;
    return state !== 'connected';
  }

  /**
   * Reconnect loop (§29.6): one immediate attempt, then bounded exponential
   * backoff; every attempt mints a fresh credential (transport.connect does
   * that). Position is held; the machine sits in `reconnecting` and lands in
   * `soft_paused` on success so the user resumes explicitly.
   */
  private async handleConnectionLost(): Promise<void> {
    if (this.reconnectInFlight || !this.config) return;
    this.reconnectInFlight = true;
    const generation = this.lifecycleGeneration;
    this.hooks.onRecoverableIssue?.('connection_lost');
    // Following must stop while we are not receiving transcripts, and the UI
    // must not read "connected" during the loop.
    this.applyHold('reconnecting');
    this.machine.tryTransition('connection_lost'); // → reconnecting
    this.usage.markDisconnected();
    this.stopHealthChecks();
    this.deps.commitDriver?.reset();

    try {
      for (;;) {
        // H2/H3: bail out the moment a stop/hard-pause/suspend happened. Each
        // check is after an await, so a queued retry can never revive a
        // session the user already ended.
        if (generation !== this.lifecycleGeneration) return;
        const delay = this.reconnectScheduler.nextDelayMs();
        if (delay === null) {
          // Retry budget exhausted: this is a visible, non-live state.
          this.hooks.onSessionFailure?.('REALTIME_CONNECTION_LOST', false);
          this.machine.tryTransition('recoverable_error');
          return;
        }
        if (delay > 0) await this.sleep(delay);
        if (generation !== this.lifecycleGeneration) return;
        try {
          await this.deps.transport.disconnect('reconnect');
          if (generation !== this.lifecycleGeneration) return;
          await this.deps.transport.connect(this.config);
          if (generation !== this.lifecycleGeneration) {
            // Stopped while the connection was being negotiated: do not
            // publish it, and make sure the transport is closed again.
            await this.deps.transport.disconnect('stop').catch(() => {});
            return;
          }
          this.machine.tryTransition('reconnected'); // → soft_paused
          this.usage.markConnected();
          this.health.reset();
          this.health.setCredentialExpiry(
            this.deps.transport.getDiagnostics().credentialExpiresAtEpochMs ?? null,
          );
          // H3: monitoring was stopped for the duration of the loop; a
          // reconnected session with no health timer is exactly the state that
          // lets the next silent death go unnoticed.
          this.restartHealthChecks();
          this.reconnectScheduler.reset();
          this.interrupted = false;
          this.releaseHold('reconnecting');
          this.releaseHold('no_transcripts');
          return;
        } catch (error) {
          if (generation !== this.lifecycleGeneration) return;
          if (error instanceof RealtimeTransportError && !error.recoverable) {
            // Never retry auth/billing failures (§35.4, E.7).
            this.hooks.onSessionFailure?.(error.code, true);
            this.machine.tryTransition('fatal_error');
            return;
          }
          // otherwise: loop for the next bounded attempt
        }
      }
    } finally {
      this.reconnectInFlight = false;
    }
  }

  private async teardown(
    reason: 'stop' | 'hard_pause',
    options: { clearTranscripts: boolean },
  ): Promise<void> {
    // H2/H3: invalidate first, unconditionally — even from `idle`, because a
    // connect attempt or reconnect loop may still be in flight after a failed
    // start. This is what stops a stalled negotiation from later installing a
    // live microphone on a stopped session.
    this.lifecycleGeneration += 1;
    this.reconnectInFlight = false;
    this.reconnectScheduler.reset();
    if (this.machine.state === 'idle') {
      // Nothing to transition, but the transport may still hold resources.
      await this.deps.transport.disconnect(reason).catch(() => {});
      this.releaseAllHolds();
      return;
    }
    this.deps.commitDriver?.forceCommit(reason);
    this.machine.tryTransition('stop'); // → stopping
    this.stopHealthChecks();
    this.healthChecksRequested = false;
    await this.hooks.stopVad?.();
    this.usage.markDisconnected();
    await this.deps.transport.disconnect(reason);
    if (this.transportUnsubscribe) {
      this.transportUnsubscribe();
      this.transportUnsubscribe = null;
    }
    if (options.clearTranscripts) this.hooks.resetTranscriptState?.();
    this.interrupted = false;
    this.releaseAllHolds();
    this.machine.tryTransition('stopped'); // → idle
  }

  private async failFromError(error: unknown): Promise<void> {
    this.lifecycleGeneration += 1;
    this.stopHealthChecks();
    await this.hooks.stopVad?.();
    this.usage.markDisconnected();
    try {
      await this.deps.transport.disconnect('error');
    } catch {
      // best-effort cleanup
    }
    // The subscription belongs to a connection that no longer exists; leaving
    // it attached made a later `start()` skip re-subscribing entirely (H3).
    if (this.transportUnsubscribe) {
      this.transportUnsubscribe();
      this.transportUnsubscribe = null;
    }
    const fatal = error instanceof RealtimeTransportError && !error.recoverable;
    this.releaseAllHolds();
    this.machine.tryTransition(fatal ? 'fatal_error' : 'recoverable_error');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.setTimeout(resolve, ms);
    });
  }
}

/**
 * H5: did this event actually come from the provider?
 *
 * `transport_state` and `input_restored` are LOCAL notices we generate
 * ourselves. Counting them as server liveness meant that a transport churning
 * out state changes kept `stale_server_events` permanently satisfied while the
 * provider had gone quiet — local bookkeeping masking dead transcription.
 */
function isProviderEvent(event: TranscriptEvent): boolean {
  switch (event.type) {
    case 'item_started':
    case 'delta':
    case 'completed':
      return true;
    case 'failed':
      // Only an item-scoped failure proves the provider is still talking to
      // us; a session-level failure is often exactly the silence we detect.
      return event.itemId !== undefined;
    default:
      return false;
  }
}
