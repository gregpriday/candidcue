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
  onRecoverableIssue?: (issue: HealthIssue | 'connection_lost') => void;
}

export interface SessionControllerDeps {
  transport: RealtimeTranscriptionTransport;
  hooks?: SessionControllerHooks;
  /** When provided, pause/stop/mic-switch force commits through the driver. */
  commitDriver?: ManualCommitDriver;
  reconnectPolicy?: ReconnectPolicyConfig;
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

      // Walk any sub-states the transport did not report via progress wiring.
      this.machine.tryTransition('microphone_open');
      this.machine.tryTransition('credential_minted');
      this.machine.tryTransition('negotiated'); // → ready

      this.usage.markConnected();
      this.health.reset();
      this.health.setCredentialExpiry(this.deps.transport.getDiagnostics().credentialExpiresAt ?? null);
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

  /** §29.2 step 11–12 — user presses Start; begin committing speech. */
  startListening(): void {
    this.machine.transition('start_listening');
  }

  /** Soft pause: session stays connected and billable (§29.7). */
  softPause(): void {
    this.deps.commitDriver?.forceCommit('soft_pause');
    this.machine.transition('soft_pause');
  }

  /** Resume from soft pause. After an interruption, reconnects first. */
  async resume(): Promise<void> {
    if (this.interrupted || this.transportDisconnected()) {
      await this.reconnectNow('resume_after_interruption');
    }
    this.machine.transition('resume');
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
    this.deps.commitDriver?.forceCommit('mic_disconnect');
    this.machine.tryTransition('suspend'); // active states → soft_paused
    this.usage.markDisconnected();
    await this.deps.transport.disconnect('sleep');
    this.stopHealthChecks();
  }

  /**
   * On wake, stay paused (§29.8). The next `resume()` call — an explicit
   * user action — negotiates the fresh connection.
   */
  handleWake(): void {
    // Intentionally passive; state is already soft_paused/interrupted.
  }

  /** Begin periodic keepalive checks (§29.6). */
  startHealthChecks(intervalMs = 5_000): void {
    this.stopHealthChecks();
    const tick = () => {
      this.healthTimer = this.timers.setTimeout(tick, intervalMs);
      void this.evaluateHealth();
    };
    this.healthTimer = this.timers.setTimeout(tick, intervalMs);
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
      this.hooks.onRecoverableIssue?.('no_transcripts_despite_audio');
    }
  }

  // -- internals -----------------------------------------------------------

  private subscribeTransport(): void {
    if (this.transportUnsubscribe) return;
    this.transportUnsubscribe = this.deps.transport.onEvent((event) => {
      this.health.markServerEvent(this.now());
      if (event.type === 'completed') this.health.markCompletedItem(this.now());
      this.hooks.onTranscriptEvent?.(event);
      if (
        event.type === 'failed' &&
        event.code === 'REALTIME_CONNECTION_LOST' &&
        event.recoverable &&
        this.isActive()
      ) {
        void this.handleConnectionLost();
      }
    });
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
    this.hooks.onRecoverableIssue?.('connection_lost');
    this.machine.tryTransition('connection_lost'); // → reconnecting
    this.usage.markDisconnected();
    this.deps.commitDriver?.reset();

    try {
      for (;;) {
        const delay = this.reconnectScheduler.nextDelayMs();
        if (delay === null) {
          this.machine.tryTransition('recoverable_error');
          return;
        }
        if (delay > 0) await this.sleep(delay);
        try {
          await this.deps.transport.disconnect('reconnect');
          await this.deps.transport.connect(this.config);
          this.machine.tryTransition('reconnected'); // → soft_paused
          this.usage.markConnected();
          this.health.reset();
          this.health.setCredentialExpiry(
            this.deps.transport.getDiagnostics().credentialExpiresAt ?? null,
          );
          this.reconnectScheduler.reset();
          this.interrupted = false;
          return;
        } catch (error) {
          if (error instanceof RealtimeTransportError && !error.recoverable) {
            // Never retry auth/billing failures (§35.4, E.7).
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

  /** Single reconnect used by resume-after-interruption. */
  private async reconnectNow(_context: string): Promise<void> {
    if (!this.config) throw new RealtimeTransportError('REALTIME_CONNECTION_LOST', 'No session', true);
    this.machine.tryTransition('connection_lost');
    await this.deps.transport.disconnect('reconnect');
    await this.deps.transport.connect(this.config);
    this.machine.tryTransition('reconnected'); // → soft_paused
    this.usage.markConnected();
    this.health.reset();
    this.health.setCredentialExpiry(this.deps.transport.getDiagnostics().credentialExpiresAt ?? null);
    this.interrupted = false;
  }

  private async teardown(
    reason: 'stop' | 'hard_pause',
    options: { clearTranscripts: boolean },
  ): Promise<void> {
    if (this.machine.state === 'idle') return;
    this.deps.commitDriver?.forceCommit(reason);
    this.machine.tryTransition('stop'); // → stopping
    this.stopHealthChecks();
    await this.hooks.stopVad?.();
    this.usage.markDisconnected();
    await this.deps.transport.disconnect(reason);
    if (this.transportUnsubscribe) {
      this.transportUnsubscribe();
      this.transportUnsubscribe = null;
    }
    if (options.clearTranscripts) this.hooks.resetTranscriptState?.();
    this.interrupted = false;
    this.machine.tryTransition('stopped'); // → idle
  }

  private async failFromError(error: unknown): Promise<void> {
    this.stopHealthChecks();
    await this.hooks.stopVad?.();
    this.usage.markDisconnected();
    try {
      await this.deps.transport.disconnect('error');
    } catch {
      // best-effort cleanup
    }
    const fatal = error instanceof RealtimeTransportError && !error.recoverable;
    this.machine.tryTransition(fatal ? 'fatal_error' : 'recoverable_error');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.setTimeout(resolve, ms);
    });
  }
}
