/**
 * §28.2 — losing a microphone mid-take is recoverable, and the UI now says
 * something it can actually do.
 *
 * The defect: the `MIC_DEVICE_LOST` toast read "Choose an input to continue
 * following", but `WebRtcTranscriptionTransport.setMicrophone` had no
 * production caller, Live had no device selector, and
 * `settings.audio.preferredDeviceId` was declared and never read or written.
 * The instruction was unfollowable in three separate ways.
 *
 * These tests prove the switch end to end at both seams: the controller really
 * hands the new device to the transport and releases the following hold, and
 * the session store's action — the one the Live picker calls — resumes the
 * take and remembers the choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { RealtimeSessionController } from '../../../src/control/services/realtime/sessionController';
import { DEFAULT_TRANSCRIPTION_CONFIG } from '../../../src/control/services/realtime/sessionConfig';
import type { ManualCommitDriver } from '../../../src/control/services/realtime/commitDriver';
import type {
  CommitReason,
  CompiledScript,
  DisconnectReason,
  RealtimeTranscriptionTransport,
  TranscriptEvent,
  TranscriptionConfig,
  TransportDiagnostics,
  TransportState,
  Unsubscribe,
} from '../../../src/shared/contracts';

/* ==========================================================================
 * 1. The controller seam: the transport really receives the new device.
 * ======================================================================== */

class FakeTransport implements RealtimeTranscriptionTransport {
  state: TransportState = 'disconnected';
  /** Every device id `setMicrophone` was asked for, in order. */
  microphones: string[] = [];
  setMicrophoneRejection: Error | null = null;
  /** Interleaved log of commits and switches — order is load-bearing (§29.3). */
  log: string[] = [];
  private handlers = new Set<(event: TranscriptEvent) => void>();

  async connect(_config: TranscriptionConfig): Promise<void> {
    this.state = 'connected';
  }
  async setMicrophone(deviceId: string): Promise<void> {
    if (this.setMicrophoneRejection) throw this.setMicrophoneRejection;
    this.microphones.push(deviceId);
    this.log.push(`switch:${deviceId}`);
  }
  commit(reason: CommitReason): boolean {
    this.log.push(`commit:${reason}`);
    return true;
  }
  clearBufferedAudio(): boolean {
    return true;
  }
  async disconnect(_reason: DisconnectReason): Promise<void> {
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
      credentialExpiresAtEpochMs: Date.now() + 3_600_000,
      sessionGeneration: 1,
      reconnectAttempts: 0,
    };
  }
}

function makeController(transport: FakeTransport): {
  controller: RealtimeSessionController;
  holds: Array<[boolean, string | null]>;
  issues: string[];
} {
  const holds: Array<[boolean, string | null]> = [];
  const issues: string[] = [];
  const commitDriver = {
    forceCommit: (reason: CommitReason) => transport.commit(reason),
    reset: () => {},
  } as unknown as ManualCommitDriver;
  const controller = new RealtimeSessionController({
    transport,
    commitDriver,
    hooks: {
      onFollowingHold: (held, reason) => holds.push([held, reason]),
      onRecoverableIssue: (issue) => issues.push(issue),
    },
  });
  return { controller, holds, issues };
}

describe('the controller performs a real mid-session device switch', () => {
  it('hands the chosen device to the transport and resumes following', async () => {
    const transport = new FakeTransport();
    const { controller, holds, issues } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();

    // USB microphone unplugged: the peer connection is perfectly healthy.
    transport.emit({ type: 'failed', code: 'MIC_DEVICE_LOST', recoverable: true });
    expect(controller.followingHeld).toBe(true);

    await controller.switchMicrophone('usb-shure-mv7');

    // The transport was actually asked to use the new input.
    expect(transport.microphones).toEqual(['usb-shure-mv7']);
    // Following resumed — nothing else releases `input_lost`, because
    // `input_restored` only fires when the ORIGINAL track unmutes, which an
    // unplugged device never does.
    expect(controller.followingHeld).toBe(false);
    expect(holds.at(-1)).toEqual([false, null]);
    expect(issues).toContain('input_restored');
  });

  it('commits buffered speech BEFORE replacing the track (§29.3)', async () => {
    const transport = new FakeTransport();
    const { controller } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    transport.log.length = 0;

    await controller.switchMicrophone('usb-shure-mv7');

    // Switching first would either drop the last phrase or attribute it to a
    // microphone that did not record it.
    expect(transport.log).toEqual(['commit:mic_disconnect', 'switch:usb-shure-mv7']);
  });

  it('leaves the hold in place when the switch fails', async () => {
    const transport = new FakeTransport();
    transport.setMicrophoneRejection = new Error('MIC_DEVICE_MISSING');
    const { controller } = makeController(transport);
    await controller.start(DEFAULT_TRANSCRIPTION_CONFIG);
    controller.startListening();
    transport.emit({ type: 'failed', code: 'MIC_DEVICE_LOST', recoverable: true });

    await expect(controller.switchMicrophone('gone')).rejects.toThrow();
    // A failed switch must not report a take as following again.
    expect(controller.followingHeld).toBe(true);
  });

  it('refuses on a session that has not started', async () => {
    const transport = new FakeTransport();
    const { controller } = makeController(transport);
    await expect(controller.switchMicrophone('usb-1')).rejects.toMatchObject({
      code: 'REALTIME_CONNECTION_LOST',
    });
    expect(transport.microphones).toEqual([]);
  });
});

/* ==========================================================================
 * 2. The store seam: the action the Live picker calls.
 * ======================================================================== */

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
}));

const records = vi.hoisted(() => ({
  appendSessionTranscript: vi.fn(async () => 0),
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
  // §36.3 take history — part of the same module the store imports.
  recordSessionTake: vi.fn(async () => null),
  listSessionTakes: vi.fn(async () => []),
}));

const fakePipeline = vi.hoisted(() => {
  const captured: {
    deps: Record<string, (...args: never[]) => unknown> | null;
    switched: string[];
    rejection: unknown;
  } = { deps: null, switched: [], rejection: null };
  class FakePipeline {
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    async switchMicrophone(deviceId: string): Promise<void> {
      if (captured.rejection !== null) throw captured.rejection;
      captured.switched.push(deviceId);
    }
    estimatedCostUsd(): number {
      return 0;
    }
  }
  return { captured, FakePipeline };
});

const settingsPatches = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: fakePipeline.FakePipeline,
  COMMAND_TICK_INTERVAL_MS: 250,
}));
vi.mock('../../../src/control/services/semantic-sidecar', () => ({
  SemanticSidecar: class {
    scheduler = {
      getDiagnostics: () => ({
        requestsByLane: {},
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        availability: 'disabled' as const,
        estimatedCostUsd: null,
      }),
      getAvailability: () => 'disabled' as const,
      getBudget: () => ({
        maxRequestsPerSession: 400,
        maxRequestsPerHour: 600,
        maxTotalTokens: 1_500_000,
      }),
    };
    attachContextSource(): void {}
    cancelInFlight(): void {}
    setMode(): void {}
    setRequestLimit(): void {}
    setPrices(): void {}
    dispose(): void {}
  },
}));
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../../src/control/services/smooth-follow-adapter', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/smooth-follow-adapter')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});
vi.mock('../../../src/control/stores/settings', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/stores/settings')>();
  return {
    ...actual,
    patchSettings: async (section: string, patch: unknown) => {
      settingsPatches.calls.push([section, patch]);
    },
  };
});

const {
  canSwitchMicrophone,
  clearSession,
  session,
  setStageEmitterForTesting,
  startLiveSession,
  switchMicrophone,
} = await import('../../../src/control/stores/session');
const { toasts, clearToasts } = await import('../../../src/control/stores/toasts');

function compiledStub(): CompiledScript {
  return {
    sourceHash: 'hash-abc',
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
    ],
    navigationTargets: [],
    spokenTokens: [],
    literalCommandRanges: [],
  } as unknown as CompiledScript;
}

function startVoiceSession(mode: 'voice' | 'manual' = 'voice'): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode,
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    stageGeneration: 4,
    sessionGeneration: 7,
    micDeviceId: 'built-in',
  });
}

interface StoreHooks {
  onInputDeviceLost?: (code: string) => void;
  onInputRestored?: () => void;
  onSessionFailure?: (code: string, fatal: boolean) => void;
}

function storeHooks(): StoreHooks {
  expect(fakePipeline.captured.deps).not.toBeNull();
  return fakePipeline.captured.deps as unknown as StoreHooks;
}

function loseTheMicrophone(): void {
  storeHooks().onInputDeviceLost?.('MIC_DEVICE_LOST');
}

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
  settingsPatches.calls.length = 0;
  fakePipeline.captured.deps = null;
  fakePipeline.captured.switched.length = 0;
  fakePipeline.captured.rejection = null;
  setStageEmitterForTesting(async () => {});
});

afterEach(() => {
  clearSession();
  clearToasts();
  setStageEmitterForTesting(null);
  vi.useRealTimers();
});

describe('the Live screen can honour what the device-lost toast promises', () => {
  it('offers the switch only when there is a transport to switch on', () => {
    expect(canSwitchMicrophone()).toBe(false); // no session at all
    startVoiceSession();
    expect(canSwitchMicrophone()).toBe(true);
    clearSession();
    startVoiceSession('manual');
    // A manual take never builds a pipeline; offering a picker would be the
    // same defect in a new place.
    expect(canSwitchMicrophone()).toBe(false);
  });

  it('names a remedy the UI can actually perform', () => {
    startVoiceSession();
    loseTheMicrophone();

    const message = get(toasts).at(-1)?.message ?? '';
    // The old copy sent the user looking for a control that did not exist.
    expect(message).not.toContain('Choose an input to continue following');
    expect(message).toMatch(/status bar/);
    // …and the control it names is offered exactly when the copy appears.
    expect(canSwitchMicrophone()).toBe(true);
    expect(get(session).micState).toBe('disconnected');
  });

  it('switches the pipeline, resumes the take and remembers the device', async () => {
    startVoiceSession();
    loseTheMicrophone();
    expect(get(session).micState).toBe('disconnected');

    const ok = await switchMicrophone('usb-shure-mv7');

    expect(ok).toBe(true);
    expect(fakePipeline.captured.switched).toEqual(['usb-shure-mv7']);
    expect(get(session).micState).toBe('live');
    expect(get(toasts).at(-1)?.message).toMatch(/following has resumed/i);
    // `preferredDeviceId` was declared and never written by anything.
    expect(settingsPatches.calls).toContainEqual(['audio', { preferredDeviceId: 'usb-shure-mv7' }]);
  });

  it('keeps saying the microphone is lost when the switch fails', async () => {
    startVoiceSession();
    loseTheMicrophone();
    fakePipeline.captured.rejection = new Error('MIC_DEVICE_MISSING');

    const ok = await switchMicrophone('gone');

    expect(ok).toBe(false);
    expect(get(session).micState).toBe('disconnected');
    // Human copy, not the code (§44.12).
    const message = get(toasts).at(-1)?.message ?? '';
    expect(message).toContain('Could not switch to that microphone.');
    expect(message).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
    // A failed switch must not be remembered as the preferred device.
    expect(settingsPatches.calls).toEqual([]);
  });

  it('does not offer a microphone swap as the cure for a dead transport', () => {
    startVoiceSession();
    // A rejected key leaves `micState` 'disconnected' too — but no input was
    // lost, and switching microphones cannot possibly help.
    storeHooks().onSessionFailure?.('AUTH_KEY_INVALID', true);

    expect(get(session).micState).toBe('disconnected');
    expect(get(session).inputDeviceLost).toBe(false);
  });

  it('clears itself when the microphone is simply plugged back in', () => {
    startVoiceSession();
    loseTheMicrophone();
    expect(get(session).inputDeviceLost).toBe(true);

    storeHooks().onInputRestored?.();

    // "Reconnect it and we resume" has to hold without being asked twice.
    expect(get(session).inputDeviceLost).toBe(false);
    expect(get(session).micState).toBe('live');
    expect(get(toasts).at(-1)?.message).toMatch(/microphone is back/i);
  });
});
