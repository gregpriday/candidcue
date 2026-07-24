/**
 * §29.2 start sequence — enforced by the controller, not by whichever screen
 * happened to run first.
 *
 * `RealtimeSessionController` has always had hooks for steps 1–3, 8 and 9, and
 * the only production caller supplied none of them. Steps 1–3 did happen, in
 * `Preflight.svelte`, before `startLiveSession` — so the behaviour was right by
 * accident. The accident is the defect: the controller re-runs its whole start
 * sequence on every resume-after-sleep and every hard-pause recovery, when
 * Preflight is long gone, and any future caller inherits nothing.
 *
 * What is asserted here, in order of how much it matters:
 *
 *  1. an UNMET PRECONDITION STOPS THE START — the transport is never connected,
 *     so nothing billable begins;
 *  2. the steps run in the specified order, before anything is subscribed;
 *  3. the session store really supplies a gate, and the gate really checks
 *     rather than merely existing.
 *
 * On revert, (3) fails immediately (no `startSequence` on the pipeline deps) and
 * (1)/(2) fail because there is no hook to reject from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompiledScript,
  RealtimeTranscriptionTransport,
  TranscriptionConfig,
} from '../../../src/shared/contracts';
import { RealtimeSessionController } from '../../../src/control/services/realtime/sessionController';

/* ------------------------------------------------------- controller-level */

const CONFIG: TranscriptionConfig = {
  model: 'gpt-realtime-whisper',
  language: 'en',
  delay: 'low',
  requestLogprobs: true,
};

function fakeTransport(calls: string[]): RealtimeTranscriptionTransport {
  return {
    connect: async () => {
      calls.push('connect');
    },
    disconnect: async () => {
      calls.push('disconnect');
    },
    commit: async () => {},
    clearBufferedAudio: async () => {},
    setMicrophone: async () => {},
    onEvent: () => {
      calls.push('subscribe');
      return () => {};
    },
    getDiagnostics: () => ({
      transportState: 'connected',
      credentialExpiresAtEpochMs: null,
    }),
  } as unknown as RealtimeTranscriptionTransport;
}

describe('§29.2 the controller owns the ordering', () => {
  it('walks steps 1–3 before touching the transport', async () => {
    const calls: string[] = [];
    const controller = new RealtimeSessionController({
      transport: fakeTransport(calls),
      hooks: {
        flushScriptSave: async () => {
          calls.push('flush');
        },
        ensureCompiled: async () => {
          calls.push('compile');
        },
        awaitStageAck: async () => {
          calls.push('stage_ack');
        },
        requestPermission: async () => {
          calls.push('permission');
          return true;
        },
        resetTranscriptState: () => {
          calls.push('reset');
        },
        startVad: () => {
          calls.push('vad');
        },
      },
    });

    await controller.start(CONFIG);

    expect(calls.slice(0, 4)).toEqual(['flush', 'compile', 'stage_ack', 'permission']);
    expect(calls.indexOf('connect')).toBeGreaterThan(calls.indexOf('permission'));
    // Step 8 and 9 land after the connection, in that order.
    expect(calls.indexOf('reset')).toBeGreaterThan(calls.indexOf('connect'));
    expect(calls.indexOf('vad')).toBeGreaterThan(calls.indexOf('reset'));
  });

  /* ---- the assertion that makes the hooks load-bearing rather than decor ---- */

  it.each(['flushScriptSave', 'ensureCompiled', 'awaitStageAck'] as const)(
    'a failing %s stops the start before the transport connects',
    async (hook) => {
      const calls: string[] = [];
      const controller = new RealtimeSessionController({
        transport: fakeTransport(calls),
        hooks: {
          flushScriptSave: async () => {},
          ensureCompiled: async () => {},
          awaitStageAck: async () => {},
          [hook]: async () => {
            throw new Error('precondition not met');
          },
        },
      });

      await expect(controller.start(CONFIG)).rejects.toThrow('precondition not met');
      expect(calls).not.toContain('connect');
      expect(calls).not.toContain('subscribe');
      expect(controller.state).not.toBe('ready');
    },
  );

  it('a declined microphone stops the start', async () => {
    const calls: string[] = [];
    const controller = new RealtimeSessionController({
      transport: fakeTransport(calls),
      hooks: {
        flushScriptSave: async () => {},
        ensureCompiled: async () => {},
        awaitStageAck: async () => {},
        requestPermission: async () => false,
      },
    });
    await expect(controller.start(CONFIG)).rejects.toThrow();
    expect(calls).not.toContain('connect');
  });

  it('stops the VAD when the start sequence fails', async () => {
    const stopVad = vi.fn();
    const controller = new RealtimeSessionController({
      transport: fakeTransport([]),
      hooks: {
        flushScriptSave: async () => {},
        ensureCompiled: async () => {
          throw new Error('nope');
        },
        awaitStageAck: async () => {},
        stopVad,
      },
    });
    await expect(controller.start(CONFIG)).rejects.toThrow();
    // The leak this closes: `failFromError` called an unsupplied `stopVad` and
    // left a polling AudioContext on a session that never existed.
    expect(stopVad).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------- store-level */

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
  getStageStatus: vi.fn(async () => ({
    exists: true,
    visible: true,
    fullscreen: true,
    stageGeneration: 2,
    hydrated: true,
    layoutReady: true,
    mediaHealthy: true,
  })),
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

const editor = vi.hoisted(() => ({ saveNow: vi.fn(async () => {}) }));

/** A real writable, so the store's `get(compiled)` reads what the test sets. */
const compiledStore = vi.hoisted(() => {
  type State = {
    status: 'idle' | 'compiling' | 'ready' | 'error';
    editorRevision: number;
    result: { sourceHash: string; diagnostics: unknown[] } | null;
    error: string | null;
  };
  const listeners = new Set<(s: State) => void>();
  let value: State = { status: 'idle', editorRevision: -1, result: null, error: null };
  return {
    set(next: State) {
      value = next;
      for (const fn of listeners) fn(value);
    },
    compiled: {
      subscribe(fn: (s: State) => void) {
        listeners.add(fn);
        fn(value);
        return () => listeners.delete(fn);
      },
    },
  };
});

const pipeline = vi.hoisted(() => {
  const captured: { deps: Record<string, unknown> | null } = { deps: null };
  class FakePipeline {
    constructor(deps: Record<string, unknown>) {
      captured.deps = deps;
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  }
  return { captured, FakePipeline };
});

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/stores/editor', () => editor);
vi.mock('../../../src/control/stores/compiled', () => ({
  compiled: compiledStore.compiled,
  requestCompile: vi.fn(async () => {}),
  resetCompiled: vi.fn(),
}));
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: pipeline.FakePipeline,
  COMMAND_TICK_INTERVAL_MS: 250,
}));
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../../src/control/services/smooth-follow-adapter', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/smooth-follow-adapter')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const { clearSession, startLiveSession, stopSession } = await import(
  '../../../src/control/stores/session'
);

interface Gate {
  flushScriptSave(): Promise<void>;
  ensureCompiled(): Promise<void>;
  awaitStageAck(): Promise<void>;
}

function compiledStub(): CompiledScript {
  return {
    scriptId: 'script-1',
    sourceHash: 'hash-abc',
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
    ],
    navigationTargets: [],
    spokenTokens: [],
    literalCommandRanges: [],
    outline: [],
  } as unknown as CompiledScript;
}

function start(overrides: { compiled?: CompiledScript | null; stageGeneration?: number } = {}): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: '11111111-1111-4111-8111-111111111111',
    compiled: overrides.compiled === undefined ? compiledStub() : overrides.compiled,
    sessionGeneration: 4,
    stageGeneration: overrides.stageGeneration ?? 2,
  });
}

function gate(): Gate {
  const value = pipeline.captured.deps?.startSequence as Gate | undefined;
  if (!value) throw new Error('the session store supplied no §29.2 gate');
  return value;
}

describe('§29.2 the session store supplies a real gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pipeline.captured.deps = null;
    editor.saveNow.mockClear();
    stage.getStageStatus.mockClear();
    compiledStore.set({ status: 'idle', editorRevision: -1, result: null, error: null });
  });

  afterEach(() => {
    stopSession();
    clearSession();
    vi.useRealTimers();
  });

  it('supplies all three §29.2 preconditions, not some of them', () => {
    start();
    const supplied = gate();
    expect(typeof supplied.flushScriptSave).toBe('function');
    expect(typeof supplied.ensureCompiled).toBe('function');
    expect(typeof supplied.awaitStageAck).toBe('function');
  });

  it('step 1 flushes the pending script save', async () => {
    start();
    await gate().flushScriptSave();
    expect(editor.saveNow).toHaveBeenCalled();
  });

  it('step 2 accepts a current compile with no blocking diagnostics', async () => {
    start();
    compiledStore.set({
      status: 'ready',
      editorRevision: 3,
      result: { sourceHash: 'hash-abc', diagnostics: [{ severity: 'warning', blocking: false }] },
      error: null,
    });
    await expect(gate().ensureCompiled()).resolves.toBeUndefined();
  });

  it('step 2 refuses a compile that failed', async () => {
    start();
    compiledStore.set({
      status: 'error',
      editorRevision: 3,
      result: null,
      error: 'Unclosed directive on line 4.',
    });
    await expect(gate().ensureCompiled()).rejects.toThrow(/Unclosed directive/);
  });

  it('step 2 refuses a compile with blocking diagnostics', async () => {
    start();
    compiledStore.set({
      status: 'ready',
      editorRevision: 3,
      result: {
        sourceHash: 'hash-abc',
        diagnostics: [{ severity: 'error', blocking: true, message: 'Unknown directive :::foo' }],
      },
      error: null,
    });
    await expect(gate().ensureCompiled()).rejects.toThrow(/Unknown directive/);
  });

  it('step 2 refuses a script that moved on after the session was prepared', async () => {
    start();
    // §45.3: the stage would be prompting text the aligner was not built from.
    compiledStore.set({
      status: 'ready',
      editorRevision: 9,
      result: { sourceHash: 'hash-different', diagnostics: [] },
      error: null,
    });
    await expect(gate().ensureCompiled()).rejects.toThrow(/changed/i);
  });

  it('step 3 refuses a stage that has not hydrated', async () => {
    stage.getStageStatus.mockResolvedValueOnce({
      exists: true,
      visible: true,
      fullscreen: true,
      stageGeneration: 2,
      hydrated: false,
      layoutReady: false,
      mediaHealthy: true,
    });
    start();
    await expect(gate().awaitStageAck()).rejects.toThrow(/stage/i);
  });

  it('step 3 refuses a stage window from a different generation', async () => {
    stage.getStageStatus.mockResolvedValueOnce({
      exists: true,
      visible: true,
      fullscreen: true,
      // The stage was reopened underneath us — hydrated, ready, wrong window.
      stageGeneration: 99,
      hydrated: true,
      layoutReady: true,
      mediaHealthy: true,
    });
    start();
    await expect(gate().awaitStageAck()).rejects.toThrow(/stage/i);
  });

  it('step 3 accepts the stage it was told to expect', async () => {
    start();
    await expect(gate().awaitStageAck()).resolves.toBeUndefined();
    expect(stage.getStageStatus).toHaveBeenCalled();
  });

  it('step 3 is a no-op for a session with no stage window', async () => {
    start({ stageGeneration: 0 });
    await expect(gate().awaitStageAck()).resolves.toBeUndefined();
    expect(stage.getStageStatus).not.toHaveBeenCalled();
  });
});
