import { describe, expect, it, vi } from 'vitest';
import { RealtimeSessionController } from './sessionController';
import { RealtimeTransportError } from './errors';
import { DEFAULT_TRANSCRIPTION_CONFIG } from './sessionConfig';
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

  async connect(_config: TranscriptionConfig): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
    if (this.failNextConnects > 0) {
      this.failNextConnects -= 1;
      throw new RealtimeTransportError('PROVIDER_UNAVAILABLE', 'transient', true);
    }
    this.state = 'connected';
  }
  async setMicrophone(): Promise<void> {}
  commit(_reason: CommitReason): void {}
  clearBufferedAudio(): void {}
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
  getDiagnostics(): TransportDiagnostics {
    return {
      transportState: this.state,
      credentialExpiresAt: 999_999,
      sessionGeneration: 1,
      reconnectAttempts: 0,
    };
  }
}

/** Timers that run callbacks immediately (delays collapse in tests). */
const immediateTimers = {
  setTimeout: (cb: () => void) => {
    cb();
    return 0;
  },
  clearTimeout: () => {},
};

function makeController(transport: FakeTransport, hookOverrides = {}) {
  const states: RealtimeState[] = [];
  const controller = new RealtimeSessionController({
    transport,
    timers: immediateTimers,
    now: () => 0,
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
  return { controller, states };
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
    const { controller } = makeController(transport, {
      onRecoverableIssue: (issue: string) => issues.push(issue),
    });
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.failNextConnects = 1; // first retry fails, second succeeds
    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await flushAsync();

    expect(issues).toContain('connection_lost');
    expect(controller.state).toBe('soft_paused'); // position held, explicit resume
    expect(transport.connectCalls).toBe(3); // initial + failed retry + success
    expect(transport.disconnects.filter((r) => r === 'reconnect').length).toBeGreaterThan(0);

    await controller.resume();
    expect(controller.state).toBe('listening');
  });

  it('gives up into recoverable_error when the bounded policy is exhausted', async () => {
    const transport = new FakeTransport();
    const { controller } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.failNextConnects = 99;
    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await flushAsync();
    expect(controller.state).toBe('recoverable_error');
    expect(transport.connectCalls).toBe(1 + 3); // initial + maxAttempts
  });

  it('never retries a non-recoverable failure during reconnect (§35.4)', async () => {
    const transport = new FakeTransport();
    const { controller } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    transport.connectError = new RealtimeTransportError('QUOTA_EXHAUSTED', 'billing', false);
    transport.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
    await flushAsync();
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
