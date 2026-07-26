/**
 * §44.12 / Appendix E.7 — no user ever reads a stable error code.
 *
 * The defect these guard: `onSessionFailure` handed a bare code string to
 * `describeError`, which fell through `typeof err === 'string' → return err`,
 * so the toast read literally "Voice following stopped: QUOTA_EXHAUSTED".
 *
 * These tests drive the REAL store path — `startLiveSession` → the voice
 * pipeline's `onSessionFailure` hook → `showToast` → the toast store — and
 * assert the rendered string. Asserting that `describeError('QUOTA_EXHAUSTED')`
 * returns something would prove nothing about what the operator sees.
 *
 * The sweep at the end is the regression guard that matters most: EVERY code
 * this build can produce is pushed through the live path and no rendered
 * string is allowed to contain a SCREAMING_SNAKE_CASE token. A code added
 * tomorrow without copy fails here rather than in front of a camera.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
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

const pipeline = vi.hoisted(() => {
  const captured: { deps: Record<string, (...args: never[]) => unknown> | null } = { deps: null };
  const control: { startRejection: unknown } = { startRejection: null };
  class FakePipeline {
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
    }
    async start(): Promise<void> {
      if (control.startRejection !== null) throw control.startRejection;
    }
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    async switchMicrophone(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  }
  return { captured, control, FakePipeline };
});

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: pipeline.FakePipeline,
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

const { clearSession, setStageEmitterForTesting, startLiveSession } = await import(
  '../../../src/control/stores/session'
);
const { toasts, clearToasts } = await import('../../../src/control/stores/toasts');
const { KNOWN_ERROR_CODES, recentErrorDiagnostics, clearErrorDiagnostics, describeError } =
  await import('../../../src/control/services/errors');

/**
 * The shape a user must never see. Deliberately the same rule the production
 * scrubber uses, applied from the outside to the RENDERED string.
 */
const CODE_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

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

function start(): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    stageGeneration: 4,
    sessionGeneration: 7,
  });
}

interface PipelineHooks {
  onSessionFailure?: (code: string, fatal: boolean) => void;
  onInputDeviceLost?: (code: string) => void;
}

function hooks(): PipelineHooks {
  expect(pipeline.captured.deps).not.toBeNull();
  return pipeline.captured.deps as unknown as PipelineHooks;
}

function toastMessages(): string[] {
  return get(toasts).map((t) => t.message);
}

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
  clearErrorDiagnostics();
  pipeline.captured.deps = null;
  pipeline.control.startRejection = null;
  setStageEmitterForTesting(async () => {});
});

afterEach(() => {
  clearSession();
  clearToasts();
  setStageEmitterForTesting(null);
  vi.useRealTimers();
});

describe('a session-level failure toast is authored copy, not a code', () => {
  it('renders quota exhaustion as advice, with no code anywhere in the toast', () => {
    start();
    hooks().onSessionFailure?.('QUOTA_EXHAUSTED', true);

    const [message] = toastMessages();
    expect(message).toBeDefined();
    // The literal string the operator used to see.
    expect(message).not.toContain('QUOTA_EXHAUSTED');
    expect(message).not.toMatch(CODE_TOKEN);
    expect(message).toContain('Voice following stopped.');
    // What happened, and what to do about it.
    expect(message).toMatch(/quota|billing/i);
    expect(message).toMatch(/Inworld dashboard|manual mode/i);
  });

  it('gives an auth failure, a quota failure and a network drop different advice', () => {
    start();
    hooks().onSessionFailure?.('AUTH_KEY_INVALID', true);
    hooks().onSessionFailure?.('QUOTA_EXHAUSTED', true);
    hooks().onSessionFailure?.('NETWORK_OFFLINE', true);

    const [auth, quota, network] = toastMessages();
    expect(new Set([auth, quota, network]).size).toBe(3);
    // Each names the remedy that actually applies to it.
    expect(auth).toMatch(/Settings → Speech/);
    expect(quota).toMatch(/credit|billing/i);
    expect(network).toMatch(/internet connection/i);
    // …and not one that does not: re-entering a key cannot fix an empty
    // account, and adding credit cannot fix a dead Wi-Fi link.
    expect(quota).not.toMatch(/Settings → Speech/);
    expect(network).not.toMatch(/Settings → Speech/);
  });

  it('distinguishes a stopped session from an interrupted one', () => {
    start();
    hooks().onSessionFailure?.('REALTIME_CONNECTION_LOST', false);
    expect(toastMessages()[0]).toContain('Voice following interrupted.');
    expect(toastMessages()[0]).not.toMatch(CODE_TOKEN);
  });

  it('keeps the raw code for Settings → Diagnostics', () => {
    start();
    hooks().onSessionFailure?.('QUOTA_EXHAUSTED', true);

    const entries = recentErrorDiagnostics();
    expect(entries[0]?.code).toBe('QUOTA_EXHAUSTED');
    // The copy recorded next to it is the copy that was shown.
    expect(toastMessages()[0]).toContain(entries[0]?.shown ?? ' ');
  });
});

describe('no code can reach a user-visible string', () => {
  it('renders every known code as copy through the live session path', () => {
    for (const code of KNOWN_ERROR_CODES) {
      clearToasts();
      start();
      hooks().onSessionFailure?.(code, true);
      hooks().onSessionFailure?.(code, false);
      hooks().onInputDeviceLost?.(code);
      for (const message of toastMessages()) {
        expect(message, `code ${code} leaked into a toast: ${message}`).not.toMatch(CODE_TOKEN);
        expect(message).not.toContain(code);
      }
      clearSession();
    }
  });

  it('does not leak a code nobody has written copy for yet', () => {
    start();
    // Stands in for the next code added to APP_ERROR_CODES without copy.
    hooks().onSessionFailure?.('SOME_FUTURE_PROVIDER_FAULT', true);

    const [message] = toastMessages();
    expect(message).not.toContain('SOME_FUTURE_PROVIDER_FAULT');
    expect(message).not.toMatch(CODE_TOKEN);
    // Honest plain English that points at where the code can be read.
    expect(message).toMatch(/Settings → Diagnostics/);
    expect(recentErrorDiagnostics()[0]?.code).toBe('SOME_FUTURE_PROVIDER_FAULT');
  });

  it('does not leak a code thrown as an Error message by audio acquisition', async () => {
    // `voice-session.acquireMicrophone` does `throw new Error(result.code)` —
    // the message IS a code, and it lands in the start-failure toast.
    pipeline.control.startRejection = new Error('MIC_PERMISSION_DENIED');
    start();
    // The rejection is a microtask, not a timer; the store owns recurring
    // intervals so draining every timer would never terminate.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    const message = toastMessages().find((m) => m.includes('Voice tracking is unavailable.'));
    expect(message).toBeDefined();
    expect(message).not.toContain('MIC_PERMISSION_DENIED');
    expect(message).not.toMatch(CODE_TOKEN);
    expect(message).toMatch(/System Settings/);
  });

  it('does not leak a code carried on a RealtimeTransportError', () => {
    // `RealtimeTransportError` puts developer prose in `message` and the real
    // code in `.code`; the prose is not user copy either.
    const err = Object.assign(new Error('No live audio track'), { code: 'MIC_DEVICE_MISSING' });
    const shown = describeError(err);
    expect(shown).not.toMatch(CODE_TOKEN);
    expect(shown).not.toBe('No live audio track');
    expect(shown).toMatch(/No microphone was found/);
  });
});
