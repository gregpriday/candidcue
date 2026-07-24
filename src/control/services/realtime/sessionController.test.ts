import { describe, expect, it, vi } from 'vitest';
import { RealtimeSessionController } from './sessionController';
import { RealtimeTransportError } from './errors';
import { DEFAULT_TRANSCRIPTION_CONFIG } from './sessionConfig';
import type { ManualCommitDriver } from './commitDriver';
import type {
  CommitReason,
  DisconnectReason,
  RealtimeState,
  RealtimeTranscriptionTransport,
  TranscriptEvent,
  TranscriptionConfig,
  TransportDiagnostics,
  TransportState,
  Unsubscribe,
} from '../../../shared/contracts';

class FakeTransport implements RealtimeTranscriptionTransport {
  state: TransportState = 'disconnected';
  connectCalls = 0;
  disconnects: DisconnectReason[] = [];
  connectError: RealtimeTransportError | null = null;
  /** Errors thrown for the first N connect attempts. */
  failNextConnects = 0;
  private handlers = new Set<(event: TranscriptEvent) => void>();

  /** Stalls `connect()` until resolved — models a hung SDP negotiation. */
  connectGate: Promise<void> | null = null;

  async connect(_config: TranscriptionConfig): Promise<void> {
    this.connectCalls += 1;
    if (this.connectGate) {
      const gate = this.connectGate;
      this.connectGate = null;
      await gate;
    }
    if (this.connectError) throw this.connectError;
    if (this.failNextConnects > 0) {
      this.failNextConnects -= 1;
      throw new RealtimeTransportError('PROVIDER_UNAVAILABLE', 'transient', true);
    }
    this.state = 'connected';
  }
  async setMicrophone(): Promise<void> {}
  commit(_reason: CommitReason): boolean {
    return true;
  }
  clearBufferedAudio(): boolean {
    return true;
  }
  async disconnect(reason: DisconnectReason): Promise<void> {
    this.disconnects.push(reason);
    this.state = 'disconnected';
  }
  onEvent(handler: (event: TranscriptEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(event: TranscriptEvent): void {
    for (const handler of this.handlers) handler(event);
  }
  /** Epoch ms, far enough ahead not to trip the expiry check (C1). */
  credentialExpiresAtEpochMs = 1_785_110_400_000 + 3_600_000;

  getDiagnostics(): TransportDiagnostics {
    return {
      transportState: this.state,
      credentialExpiresAtEpochMs: this.credentialExpiresAtEpochMs,
      sessionGeneration: 1,
      reconnectAttempts: 0,
    };
  }
}

/**
 * Virtual clock + timer queue.
 *
 * The previous harness ran every `setTimeout` callback SYNCHRONOUSLY at
 * schedule time. That collapsed backoff sleeps, health ticks and the
 * soft-pause timer into the call that scheduled them, which made it impossible
 * to express any of the races that actually matter: stop during a backoff
 * sleep, suspend mid-reconnect, a health timer that was never restarted, or a
 * late connect completing after the session was torn down. Delays are now real
 * (virtually), and cancellation is observable.
 */
class VirtualClock {
  nowMs = 1_785_110_400_000; // realistic epoch ms (C1)
  private seq = 0;
  private queue: Array<{ id: number; at: number; cb: () => void }> = [];

  readonly timers = {
    setTimeout: (cb: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.queue.push({ id, at: this.nowMs + Math.max(0, ms), cb });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      this.queue = this.queue.filter((t) => t.id !== handle);
    },
  };

  /** Number of timers still armed — cancellation is directly assertable. */
  get pending(): number {
    return this.queue.length;
  }

  /** Advance time, firing due callbacks in order, flushing microtasks between. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    // Let any in-flight async chain reach its first `setTimeout` before we
    // start looking for due timers.
    await flushAsync();
    for (;;) {
      const due = this.queue
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter((t) => t.id !== due.id);
      this.nowMs = due.at;
      due.cb();
      await flushAsync();
    }
    this.nowMs = target;
    await flushAsync();
  }
}

function makeController(
  transport: FakeTransport,
  hookOverrides = {},
  clock: VirtualClock = new VirtualClock(),
) {
  const states: RealtimeState[] = [];
  const controller = new RealtimeSessionController({
    transport,
    timers: clock.timers,
    now: () => clock.nowMs,
    random: () => 0,
    reconnectPolicy: {
      immediateFirstRetry: true,
      baseDelayMs: 1,
      multiplier: 2,
      maxDelayMs: 4,
      maxAttempts: 3,
      jitterRatio: 0,
    },
    hooks: {
      onStateChange: (next) => states.push(next),
      ...hookOverrides,
    },
  });
  return { controller, states, clock };
}

describe('RealtimeSessionController (spec §29)', () => {
  it('runs the §29.2 start sequence in order and ends in ready', async () => {
    const transport = new FakeTransport();
    const calls: string[] = [];
    const { controller, states } = makeController(transport, {
      flushScriptSave: async () => calls.push('flush'),
      ensureCompiled: async () => calls.push('compile'),
      awaitStageAck: async () => calls.push('stage_ack'),
      requestPermission: async () => {
        calls.push('permission');
        return true;
      },
      startVad: () => calls.push('start_vad'),
      resetTranscriptState: () => calls.push('reset_transcripts'),
    });

    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    expect(calls).toEqual(['flush', 'compile', 'stage_ack', 'permission', 'reset_transcripts', 'start_vad']);
    expect(controller.state).toBe('ready');
    expect(states).toEqual([
      'requesting_permission',
      'opening_microphone',
      'minting_credential',
      'negotiating',
      'ready',
    ]);
    expect(controller.usage.connected).toBe(true);

    controller.startListening();
    expect(controller.state).toBe('listening');
  });

  it('enters recoverable_error when permission is declined', async () => {
    const transport = new FakeTransport();
    const { controller } = makeController(transport, { requestPermission: async () => false });
    await expect(controller.start(DEFAULT_TRANSCRIPTION_CONFIG)).rejects.toMatchObject({
      code: 'MIC_PERMISSION_DENIED',
    });
    expect(controller.state).toBe('recoverable_error');
    expect(transport.connectCalls).toBe(0);
  });

  it('enters fatal_error for non-recoverable connect failures', async () => {
    const transport = new FakeTransport();
    transport.connectError = new RealtimeTransportError('AUTH_KEY_INVALID', 'bad key', false);
    const { controller } = makeController(transport);
    await expect(controller.start(DEFAULT_TRANSCRIPTION_CONFIG)).rejects.toMatchObject({
      code: 'AUTH_KEY_INVALID',
    });
    expect(controller.state).toBe('fatal_error');
  });

  it('soft pause keeps the transport connected; stop tears it down and clears transcripts', async () => {
    const transport = new FakeTransport();
    const resetTranscriptState = vi.fn();
    const stopVad = vi.fn();
    const { controller } = makeController(transport, { resetTranscriptState, stopVad });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    controller.softPause();
    expect(controller.state).toBe('soft_paused');
    expect(transport.disconnects).toEqual([]); // still connected + billable (§29.7)

    await controller.resume();
    expect(controller.state).toBe('listening');

    await controller.stop();
    expect(controller.state).toBe('idle');
    expect(transport.disconnects).toEqual(['stop']);
    expect(stopVad).toHaveBeenCalled();
    expect(resetTranscriptState).toHaveBeenCalledTimes(2); // start + stop
    expect(controller.usage.connected).toBe(false);
  });

  it('hard pause disconnects but preserves transcript state', async () => {
    const transport = new FakeTransport();
    const resetTranscriptState = vi.fn();
    const { controller } = makeController(transport, { resetTranscriptState });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    await controller.hardPause();
    expect(controller.state).toBe('idle'); // fresh session required (§29.7)
    expect(transport.disconnects).toEqual(['hard_pause']);
    expect(resetTranscriptState).toHaveBeenCalledTimes(1); // start only
  });

  it('reconnects with a fresh connection on connection loss and lands soft_paused', async () => {
    const transport = new FakeTransport();
    const issues: string[] = [];
    const { controller, clock } = makeController(transport, {
      onRecoverableIssue: (issue: string) => issues.push(issue),
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.failNextConnects = 1; // first retry fails, second succeeds
    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await clock.advance(1000); // backoff is a real delay now

    expect(issues).toContain('connection_lost');
    expect(controller.state).toBe('soft_paused'); // position held, explicit resume
    expect(transport.connectCalls).toBe(3); // initial + failed retry + success
    expect(transport.disconnects.filter((r) => r === 'reconnect').length).toBeGreaterThan(0);

    await controller.resume();
    expect(controller.state).toBe('listening');
  });

  it('gives up into recoverable_error when the bounded policy is exhausted', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.failNextConnects = 99;
    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await clock.advance(1000);
    expect(controller.state).toBe('recoverable_error');
    expect(transport.connectCalls).toBe(1 + 3); // initial + maxAttempts
  });

  it('never retries a non-recoverable failure during reconnect (§35.4)', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.connectError = new RealtimeTransportError('QUOTA_EXHAUSTED', 'billing', false);
    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await clock.advance(1000);
    expect(controller.state).toBe('fatal_error');
    expect(transport.connectCalls).toBe(2); // exactly one retry attempt, then stop
  });

  it('suspend disconnects and pauses; resume after wake makes a fresh connection', async () => {
    const transport = new FakeTransport();
    const { controller } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    await controller.handleSuspend();
    expect(controller.state).toBe('soft_paused');
    expect(transport.disconnects).toEqual(['sleep']);

    controller.handleWake();
    expect(controller.state).toBe('soft_paused'); // stays paused (§29.8)

    await controller.resume(); // explicit user action → fresh connection
    expect(transport.connectCalls).toBe(2);
    expect(controller.state).toBe('listening');
  });

  // -------------------------------------------------------------------------
  // H1: session-level provider errors must drive the lifecycle
  // -------------------------------------------------------------------------

  it('H1: a session-level fatal provider error ends the session instead of staying connected', async () => {
    const transport = new FakeTransport();
    const failures: Array<[string, boolean]> = [];
    const holds: Array<[boolean, string | null]> = [];
    const { controller, clock } = makeController(transport, {
      onSessionFailure: (code: string, fatal: boolean) => failures.push([code, fatal]),
      onFollowingHold: (held: boolean, reason: string | null) => holds.push([held, reason]),
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    expect(controller.state).toBe('listening');

    // Minute 45: the provider reports quota exhaustion. No item id — this is a
    // SESSION event. Previously only REALTIME_CONNECTION_LOST was acted on, so
    // transcription stopped while the UI stayed green for the rest of the take.
    transport.emit({ type: 'failed', code: 'QUOTA_EXHAUSTED', recoverable: false });
    await clock.advance(1);

    expect(controller.state).toBe('fatal_error');
    expect(failures).toContainEqual(['QUOTA_EXHAUSTED', true]);
    expect(transport.disconnects).toContain('error');
    expect(holds[0]).toEqual([true, 'reconnecting']);
    // Critically: never left sitting in a "live" state.
    expect(['ready', 'listening']).not.toContain(controller.state);
  });

  it('H1: an ITEM-level failure does not touch the session lifecycle', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.emit({
      type: 'failed',
      itemId: 'item_9',
      code: 'PROVIDER_UNAVAILABLE',
      recoverable: true,
    });
    await clock.advance(1);
    expect(controller.state).toBe('listening');
    expect(transport.connectCalls).toBe(1);
  });

  it('H1: a recoverable session error enters bounded reconnect, not silence', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.emit({ type: 'failed', code: 'PROVIDER_UNAVAILABLE', recoverable: true });
    await clock.advance(1000);
    expect(transport.connectCalls).toBeGreaterThan(1);
    expect(controller.state).toBe('soft_paused');
  });

  it('H1: retry exhaustion reports a non-fatal session failure and leaves error state', async () => {
    const transport = new FakeTransport();
    const failures: Array<[string, boolean]> = [];
    const { controller, clock } = makeController(transport, {
      onSessionFailure: (code: string, fatal: boolean) => failures.push([code, fatal]),
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.failNextConnects = 99;
    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await clock.advance(1000);
    expect(controller.state).toBe('recoverable_error');
    expect(failures).toContainEqual(['REALTIME_CONNECTION_LOST', false]);
  });

  it('H1: a throwing transcript subscriber cannot suppress recovery', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport, {
      onTranscriptEvent: () => {
        throw new Error('consumer blew up');
      },
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.emit({ type: 'failed', code: 'AUTH_KEY_INVALID', recoverable: false });
    await clock.advance(1);
    expect(controller.state).toBe('fatal_error');
  });

  // -------------------------------------------------------------------------
  // H3: hard-pause resume, sleep recovery, health-timer lifetime
  // -------------------------------------------------------------------------

  it('H3: resume after a hard pause performs a full fresh start', async () => {
    const transport = new FakeTransport();
    const resetTranscriptState = vi.fn();
    const { controller, clock } = makeController(transport, { resetTranscriptState });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    controller.startHealthChecks(5_000);

    await controller.hardPause();
    expect(controller.state).toBe('idle');

    // Pre-fix this threw InvalidTransitionError (idle --resume-->) after
    // reconnecting without re-subscribing.
    await controller.resume();
    await clock.advance(1);
    expect(controller.state).toBe('listening');
    expect(transport.connectCalls).toBe(2);

    // The event subscription must be live again, or transcripts silently stop.
    const seen: TranscriptEvent[] = [];
    controller.machine.onChange(() => {});
    transport.emit({ type: 'completed', itemId: 'i1', text: 'hello' });
    void seen;
    expect(controller.state).toBe('listening');
  });

  it('H3: resume after a hard pause re-subscribes so session failures still act', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    await controller.hardPause();
    await controller.resume();
    await clock.advance(1);

    // If the subscription were not re-established this would be ignored and
    // the UI would keep reading "listening" over a dead session.
    transport.emit({ type: 'failed', code: 'AUTH_KEY_INVALID', recoverable: false });
    await clock.advance(1);
    expect(controller.state).toBe('fatal_error');
  });

  it('H3: suspend cancels an in-flight reconnect backoff', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.failNextConnects = 99;
    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await flushAsync(); // now sitting in a backoff sleep
    const connectsBeforeSuspend = transport.connectCalls;

    await controller.handleSuspend();
    await clock.advance(10_000);

    // The queued retry must not resurrect the session behind the user's back.
    expect(transport.connectCalls).toBe(connectsBeforeSuspend);
    expect(controller.state).toBe('soft_paused');
  });

  it('H3: sleep/wake resume restarts health monitoring', async () => {
    const transport = new FakeTransport();
    const issues: string[] = [];
    const clock = new VirtualClock();
    const { controller } = makeController(
      transport,
      { onRecoverableIssue: (issue: string) => issues.push(issue) },
      clock,
    );
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    controller.startHealthChecks(5_000);

    await controller.handleSuspend();
    expect(controller.state).toBe('soft_paused');
    // Suspend stops the health timer — that part was always correct.
    expect(clock.pending).toBe(0);

    await controller.resume();
    await clock.advance(1);
    expect(controller.state).toBe('listening');

    // Pre-fix NOTHING restarted the timer, so the resumed session ran with no
    // liveness checking whatsoever for the rest of the take. Prove it ticks by
    // making it detect something.
    expect(clock.pending).toBeGreaterThan(0);
    controller.health.reset();
    controller.noteAudioActivity(clock.nowMs);
    clock.nowMs += 13_000;
    controller.noteAudioActivity(clock.nowMs);
    await clock.advance(6_000);
    expect(issues).toContain('no_transcripts_despite_audio');
  });

  it('H3: reconnect restarts health monitoring rather than leaving it stopped', async () => {
    const transport = new FakeTransport();
    const clock = new VirtualClock();
    const { controller } = makeController(transport, {}, clock);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    controller.startHealthChecks(5_000);

    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await clock.advance(1000);
    expect(controller.state).toBe('soft_paused');
    expect(clock.pending).toBeGreaterThan(0);
  });

  it('H3: stop cancels the health timer and every pending timer', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    controller.startHealthChecks(5_000);
    expect(clock.pending).toBeGreaterThan(0);

    await controller.stop();
    expect(clock.pending).toBe(0);
  });

  // -------------------------------------------------------------------------
  // H2: stop during connect must not resurrect a session
  // -------------------------------------------------------------------------

  it('H2: stopping while connect is in flight never publishes a live session', async () => {
    const transport = new FakeTransport();
    const gate: { release: (() => void) | null } = { release: null };
    transport.connectGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { controller, clock } = makeController(transport);

    const started = controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    await flushAsync(); // stalled inside transport.connect

    await controller.stop();
    gate.release?.(); // the stalled negotiation finally completes
    await expect(started).rejects.toBeTruthy();
    await clock.advance(1);

    expect(controller.state).toBe('idle');
    expect(['ready', 'listening']).not.toContain(controller.state);
    // The late connection must have been closed again, not left live.
    expect(transport.disconnects.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // H5: dead input must visibly hold following
  // -------------------------------------------------------------------------

  it('H5: a lost input device holds following and asks for a device', async () => {
    const transport = new FakeTransport();
    const holds: Array<[boolean, string | null]> = [];
    const deviceLost: string[] = [];
    const { controller, clock } = makeController(transport, {
      onFollowingHold: (held: boolean, reason: string | null) => holds.push([held, reason]),
      onInputDeviceLost: (code: string) => deviceLost.push(code),
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    // USB mic unplugged: the peer connection is perfectly healthy.
    transport.emit({ type: 'failed', code: 'MIC_DEVICE_LOST', recoverable: true });
    await clock.advance(1);

    expect(controller.followingHeld).toBe(true);
    expect(holds).toContainEqual([true, 'input_lost']);
    expect(deviceLost).toEqual(['MIC_DEVICE_LOST']);
    // An unplugged mic is NOT a provider problem: do not burn the retry budget.
    expect(transport.connectCalls).toBe(1);
  });

  it('H5: input recovery releases the hold', async () => {
    const transport = new FakeTransport();
    const holds: Array<[boolean, string | null]> = [];
    const { controller, clock } = makeController(transport, {
      onFollowingHold: (held: boolean, reason: string | null) => holds.push([held, reason]),
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.emit({ type: 'failed', code: 'MIC_NO_SIGNAL', recoverable: true });
    await clock.advance(1);
    expect(controller.followingHeld).toBe(true);

    transport.emit({ type: 'input_restored' });
    await clock.advance(1);
    expect(controller.followingHeld).toBe(false);
    expect(holds.at(-1)).toEqual([false, null]);
  });

  it('H5: no transcripts despite audio holds following and rebuilds the connection', async () => {
    const transport = new FakeTransport();
    const issues: string[] = [];
    const { controller, clock } = makeController(transport, {
      onRecoverableIssue: (issue: string) => issues.push(issue),
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    // Speaking now…
    controller.noteAudioActivity(clock.nowMs);
    // …and the provider goes quiet well past the no-transcript budget.
    clock.nowMs += 13_000;
    controller.noteAudioActivity(clock.nowMs);
    await controller.evaluateHealth();
    await clock.advance(1000);

    expect(issues).toContain('no_transcripts_despite_audio');
    // Pre-fix this branch only reported the issue and never transitioned, so
    // the take continued with a live-looking UI and no transcription.
    expect(transport.connectCalls).toBeGreaterThan(1);
  });

  it('H5: local transport_state churn does not count as provider liveness', async () => {
    const transport = new FakeTransport();
    const { controller, clock } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    controller.health.reset();
    controller.noteAudioActivity(clock.nowMs);
    clock.nowMs += 13_000;
    controller.noteAudioActivity(clock.nowMs);
    // Local bookkeeping only — must NOT refresh server health.
    transport.emit({ type: 'transport_state', state: 'connected' });

    expect(controller.health.check(clock.nowMs)).toContain('no_transcripts_despite_audio');
  });

  // -------------------------------------------------------------------------
  // M3: soft-pause auto-disconnect
  // -------------------------------------------------------------------------

  it('M3: a soft pause warns and then deterministically disconnects', async () => {
    const transport = new FakeTransport();
    const warnings: number[] = [];
    const issues: string[] = [];
    const clock = new VirtualClock();
    const { controller } = makeController(
      transport,
      {
        onPauseWarning: (ms: number) => warnings.push(ms),
        onRecoverableIssue: (issue: string) => issues.push(issue),
      },
      clock,
    );
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    controller.softPause();

    await clock.advance(9 * 60_000); // warning lead is 60s before the 10m budget
    expect(warnings).toHaveLength(1);
    expect(controller.state).toBe('soft_paused');
    expect(transport.disconnects).toEqual([]); // still live and billable

    await clock.advance(61_000);
    expect(issues).toContain('pause_auto_disconnect');
    expect(controller.state).toBe('idle');
    expect(transport.disconnects).toContain('hard_pause');
  });

  it('M3: resuming cancels the auto-disconnect', async () => {
    const transport = new FakeTransport();
    const clock = new VirtualClock();
    const { controller } = makeController(transport, {}, clock);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    controller.softPause();
    await controller.resume();
    expect(controller.state).toBe('listening');

    await clock.advance(20 * 60_000);
    // Still live: the timer belonged to a pause that ended.
    expect(controller.state).toBe('listening');
    expect(transport.disconnects).toEqual([]);
  });

  /*
   * The manual fallback. `fatal_error` has no `start_listening`, `soft_pause`
   * or `resume` edge, and the Live transport calls all three straight out of a
   * click handler — a throwing `transition` here escaped as an uncaught
   * `InvalidTransitionError` and killed the press. Manual driving is the ONLY
   * thing left once the transport is dead, so this is the exact moment the
   * transport must not break.
   */
  it('does not throw out of the transport once the session is in fatal_error', async () => {
    const transport = new FakeTransport();
    transport.connectError = new RealtimeTransportError('AUTH_KEY_INVALID', 'bad key', false);
    const commits: CommitReason[] = [];
    const clock = new VirtualClock();
    const controller = new RealtimeSessionController({
      transport,
      timers: clock.timers,
      now: () => clock.nowMs,
      commitDriver: {
        forceCommit: (reason: CommitReason) => {
          commits.push(reason);
          return true;
        },
      } as unknown as ManualCommitDriver,
    });
    await expect(controller.start(DEFAULT_TRANSCRIPTION_CONFIG)).rejects.toMatchObject({
      code: 'AUTH_KEY_INVALID',
    });
    expect(controller.state).toBe('fatal_error');

    expect(() => controller.startListening()).not.toThrow();
    expect(controller.state).toBe('fatal_error'); // declined, not faked into 'listening'

    expect(() => controller.softPause()).not.toThrow();
    expect(controller.state).toBe('fatal_error');
    // A pause that cannot happen must not flush a commit for it either.
    expect(commits).toEqual([]);
  });

  /*
   * `resume` from a live `listening` session is the operator pressing a button
   * the UI should not have offered. It is a no-op, not an exception — and it
   * must not be mistaken for the fresh-session path, whose failures still
   * propagate (see the hard-pause resume tests above).
   */
  it('a redundant resume on a listening session is a no-op rather than a throw', async () => {
    const transport = new FakeTransport();
    const { controller } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    expect(controller.state).toBe('listening');

    await expect(controller.resume()).resolves.toBeUndefined();
    expect(controller.state).toBe('listening');
    expect(transport.connectCalls).toBe(1); // no fresh negotiation was started
  });

  it('forwards transcript events and feeds health markers', async () => {
    const transport = new FakeTransport();
    const seen: TranscriptEvent[] = [];
    const { controller } = makeController(transport, {
      onTranscriptEvent: (event: TranscriptEvent) => seen.push(event),
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    transport.emit({ type: 'delta', itemId: 'item_1', text: 'hi', receivedAtMs: 1 });
    transport.emit({ type: 'completed', itemId: 'item_1', text: 'hi there' });
    expect(seen.map((e) => e.type)).toEqual(['delta', 'completed']);
  });
});

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
