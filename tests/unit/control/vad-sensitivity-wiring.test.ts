/**
 * §28.4 — the sensitivity actually reaches the VAD.
 *
 * Two hops, and both were missing:
 *
 *   settings → `startLiveSession` → `VoiceSessionPipeline`   (asserted live)
 *   `VoiceSessionPipeline` → `MicrophoneMonitor`             (asserted on source)
 *
 * The second is a source assertion on purpose: the monitor is constructed
 * inside `acquireMicrophone`, which cannot run in node without a real
 * `getUserMedia`, and the failure this guards against is precisely the one the
 * feature started in — a value carried faithfully to the last call site and
 * then not passed.
 *
 * What this no longer asserts: that the sensitivity gates what is SENT. It
 * does not. The recogniser decides its own turn boundaries, so the local
 * detector drives the
 * meter and the dead-input check only — a threshold that could silence a word
 * on its way to the recogniser is the thing this app removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
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
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: pipeline.FakePipeline,
  COMMAND_TICK_INTERVAL_MS: 250,
}));
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});

const { clearSession, startLiveSession, stopSession } = await import(
  '../../../src/control/stores/session'
);

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

function start(vadSensitivity?: number): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: '11111111-1111-4111-8111-111111111111',
    compiled: compiledStub(),
    sessionGeneration: 4,
    ...(vadSensitivity === undefined ? {} : { vadSensitivity }),
  });
}

describe('§28.4 sensitivity reaches the voice pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pipeline.captured.deps = null;
  });

  afterEach(() => {
    stopSession();
    clearSession();
    vi.useRealTimers();
  });

  it('passes an explicit sensitivity straight through', () => {
    start(0.87);
    expect(pipeline.captured.deps?.vadSensitivity).toBe(0.87);
  });

  it('supplies the saved setting when the caller names none', () => {
    start();
    const value = pipeline.captured.deps?.vadSensitivity;
    // Every caller of `startLiveSession` gets a sensitivity, not only the one
    // screen that happens to read settings — that is the point of resolving it
    // in the store rather than at the call site.
    expect(typeof value).toBe('number');
    expect(value as number).toBeGreaterThanOrEqual(0);
    expect(value as number).toBeLessThanOrEqual(1);
  });
});

describe('§28.4 the pipeline hands it to the monitor', () => {
  it('constructs MicrophoneMonitor with a sensitivity-derived config', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/control/services/voice-session.ts'),
      'utf8',
    );
    const constructions = source.match(/new MicrophoneMonitor\(\{[\s\S]*?\n {4}\}\)/g) ?? [];
    expect(constructions.length).toBe(1);

    /*
     * Asserted in two halves, because either alone passes with the feature
     * broken: the sensitivity must be turned into a config, and THAT config
     * must be the one the monitor receives. A derivation whose result is
     * dropped is the exact shape of the original defect.
     */
    expect(constructions[0]).toContain('vadConfigForSensitivity(this.deps.vadSensitivity)');
    expect(constructions[0]).toContain('vadConfig:');
  });
});
