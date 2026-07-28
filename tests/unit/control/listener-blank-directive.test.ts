/**
 * §37.4 — "Keep the Listener when the stage is blanked", end to end.
 *
 * `keepListener: false` was a literal on the `blank` directive in
 * `toggleBlankStage`, so blanking always took the person with it. That made one
 * of the two ordinary reasons to blank work and the other not: clearing a
 * script off a screen someone else can see wants the face gone, blanking
 * between takes on a lens rig wants it to stay.
 *
 * The chain under test is the whole one, with nothing faked in the middle:
 *
 *   Settings toggle → patchSettings → the settings service → the Rust document
 *   → getSettings → the session store → the directive the stage receives
 *
 * The `ipcInvoke` fake merges patches the way Rust's `merge_json` does, so the
 * document these assertions read is the document Rust would have stored. What
 * is NOT faked is the part that used to be a constant: the value on the
 * directive comes from `toggleBlankStage` reading the settings snapshot.
 *
 * On revert — `keepListener: false` back as a literal — the second test fails
 * with `false` where `true` is expected, and the third fails because both
 * settings produce the same directive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompiledScript, StageDirective } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  /* §64: the heartbeat compares what control sent against what the stage
     applied. `exists: false` means "no stage to compare with", which is the
     right answer for a mock that is not modelling a stage window. */
  getStageStatus: vi.fn(async () => ({ exists: false })),
  publishStageDirective: vi.fn(
    async (_sessionId: string, _stageGeneration: number, _directive: StageDirective) => {},
  ),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  appendSessionTranscript: vi.fn(async () => 0),
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
  recordSessionTake: vi.fn(async () => null),
  listSessionTakes: vi.fn(async () => []),
}));

/** A settings document that merges patches the way Rust's `merge_json` does. */
const ipc = vi.hoisted(() => {
  const document = {
    revision: 1,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
        autosaveDebounceMs: 600,
        revisionIntervalMinutes: 5,
        wordsPerMinuteEstimate: 130,
        updateCheck: 'daily',
        analyticsEnabled: false,
        saveTranscript: 'off',
      },
      editor: {},
      stageBehavior: {
        promptMode: 'voice',
        manualWheelMultiplier: 1,
        fixedSpeedWpm: 130,
        pointerHideDelaySeconds: 1.5,
        manualMoveTrackingGraceSeconds: 2.5,
        stageAcknowledgement: 'subtle',
        horizontalMirror: false,
        keepScreenAwake: true,
        blankColor: '#000000',
      },
      audio: {
        transcriptionModel: 'inworld/inworld-stt-1',
        language: 'en',
        delayProfile: 'low',
        softPauseAutoDisconnectMinutes: 10,
        vadSensitivity: 0.5,
      },
      commands: {
        wakePhrase: 'CandidCue',
        wakeMode: 'strict',
      },
      listener: {},
    } as Record<string, unknown>,
  };
  const start = structuredClone(document.value);
  return {
    get listener(): Record<string, unknown> {
      return document.value.listener as Record<string, unknown>;
    },
    reset(): void {
      document.value = structuredClone(start);
      document.revision = 1;
    },
    invoke: async (command: string, args?: unknown) => {
      if (command === 'update_settings') {
        const { patch } = args as { patch: Record<string, Record<string, unknown>> };
        for (const [section, values] of Object.entries(patch)) {
          const target = (document.value[section] ??= {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(values)) {
            if (value === null) delete target[key];
            else target[key] = value;
          }
        }
        document.revision += 1;
      }
      return document;
    },
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  },
  COMMAND_TICK_INTERVAL_MS: 250,
}));
vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  BackendUnavailableError: class extends Error {},
  ipcInvoke: ipc.invoke,
}));
vi.mock('../../../src/control/services/stage-acks', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/stage-acks')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const localStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => localStore.get(key) ?? null,
    setItem: (key: string, value: string) => void localStore.set(key, value),
    removeItem: (key: string) => void localStore.delete(key),
    clear: () => localStore.clear(),
  },
});

const { clearSession, startLiveSession, stopSession, toggleBlankStage } = await import(
  '../../../src/control/stores/session'
);
const { loadSettings, patchSettings } = await import('../../../src/control/stores/settings');

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

function startSession(): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'manual',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: '22222222-2222-4222-8222-222222222222',
    compiled: compiledStub(),
    sessionGeneration: 1,
    stageGeneration: 3,
  });
}

type BlankDirective = Extract<StageDirective, { kind: 'blank' }>;

/** The `blank` directives published so far, in order. */
function blankDirectives(): BlankDirective[] {
  return stage.publishStageDirective.mock.calls
    .map((call) => call[2])
    .filter((d): d is BlankDirective => d.kind === 'blank');
}

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.reset();
  localStore.clear();
  stage.publishStageDirective.mockClear();
  await loadSettings(true);
});

afterEach(() => {
  stopSession();
  clearSession();
  vi.useRealTimers();
});

describe('§37.4 blanking the stage', () => {
  it('takes the Listener with it by default — the behaviour that shipped', () => {
    startSession();
    toggleBlankStage();
    expect(blankDirectives()).toEqual([{ kind: 'blank', blanked: true, keepListener: false }]);
  });

  it('keeps the Listener when the saved preference says so', async () => {
    await patchSettings('listeners', { keepWhenBlanked: true });
    // It really went to the document, not to a local overlay.
    expect(ipc.listener.keepWhenBlanked).toBe(true);

    startSession();
    toggleBlankStage();
    expect(blankDirectives()).toEqual([{ kind: 'blank', blanked: true, keepListener: true }]);
  });

  it('carries the preference on the unblank too, so the two agree', async () => {
    await patchSettings('listeners', { keepWhenBlanked: true });
    startSession();
    toggleBlankStage();
    toggleBlankStage();
    expect(blankDirectives()).toEqual([
      { kind: 'blank', blanked: true, keepListener: true },
      { kind: 'blank', blanked: false, keepListener: true },
    ]);
  });

  /**
   * Changing it between takes is the point — the preference is read when the
   * directive is built, not captured when the session started.
   */
  it('is read at blank time, not latched at session start', async () => {
    startSession();
    toggleBlankStage();
    await patchSettings('listeners', { keepWhenBlanked: true });
    toggleBlankStage();
    toggleBlankStage();
    expect(blankDirectives().map((d) => d.keepListener)).toEqual([false, true, true]);
  });
});
