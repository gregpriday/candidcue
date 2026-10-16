/**
 * The start-sequence gate, and the script it is allowed to have an opinion on.
 *
 * §45.3 says a take must not start against a compile that has moved on since
 * the session was assembled — the stage would prompt text the aligner was not
 * built from. The gate enforces that by comparing the script handed to
 * `startLiveSession` against whatever is in `stores/compiled`.
 *
 * That comparison was written when Preflight was the only caller and Preflight
 * drove that store, so "what is in the store" and "the script being presented"
 * were the same thing by construction. They are not any more: Present compiles
 * its own script directly, and the editor leaves its last compile in the store
 * on the way out (`closeScript` is never called when you go back to the
 * library).
 *
 * So the store routinely holds a DIFFERENT script, and every check in the gate
 * then ran the new take against the old script's compile:
 *
 *   1. edit script A — the store now holds A
 *   2. go back to the library — nothing clears it
 *   3. press Present on script B
 *
 * B compiled cleanly and its stage opened, but two scripts never hash alike, so
 * the source-hash check failed B against A and killed voice tracking on a take
 * that was otherwise perfect. The advice it gave — "start again from Preflight"
 * — named a screen that no longer exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompiledScript, CompileDiagnostic } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
}));

/** The pipeline is stubbed so the test can call the gate it was handed. */
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
/*
 * A vi.mock of `services/semantic-sidecar` used to sit here.
 *
 * The OpenAI semantic sidecar was removed from the product; the module does
 * not exist. Nothing imports it, so the mock never applied and the factory
 * below it — a whole fake scheduler with token budgets and cost estimates —
 * was inert. It survived because a mock of a missing module is silent: vitest
 * only resolves the path if something asks for it. The repository completeness
 * gate (scripts/verify-repository.mjs) is what finally named it.
 */
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../../src/control/services/alignment', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/alignment')>();
  return { ...actual, subscribeAlignmentSnapshots: () => () => {} };
});

/** The compiler worker never runs; the store is driven directly. */
const compileResult = vi.hoisted(() => ({
  value: null as { scriptId: string; sourceHash: string; diagnostics: CompileDiagnostic[] } | null,
  fail: null as string | null,
}));
vi.mock('../../../src/control/services/compiler', () => ({
  compileScript: async () => {
    if (compileResult.fail !== null) throw new Error(compileResult.fail);
    return { ...compileResult.value, stale: false, script: {} };
  },
}));

const { setInvokeForTesting } = await import('../../../src/control/services/ipc');
const { requestCompile, resetCompiled } = await import('../../../src/control/stores/compiled');
const { clearSession, startLiveSession } = await import(
  '../../../src/control/stores/session'
);

function compiledStub(scriptId: string, sourceHash: string): CompiledScript {
  return { scriptId, sourceHash, spokenTokens: [], sentences: [] } as unknown as CompiledScript;
}

/** Start a voice take and hand back the gate its pipeline was constructed with. */
function gateFor(scriptId: string, sourceHash: string): { ensureCompiled(): Promise<void> } {
  startLiveSession({
    scriptId,
    scriptTitle: 'A take',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: `session-${scriptId}`,
    compiled: compiledStub(scriptId, sourceHash),
    sessionGeneration: 1,
  });
  const deps = pipeline.captured.deps;
  if (!deps) throw new Error('the voice pipeline was never constructed');
  return deps['startSequence'] as { ensureCompiled(): Promise<void> };
}

/** Put a finished compile for `scriptId` into the shared store. */
async function storeHolds(
  scriptId: string,
  sourceHash: string,
  diagnostics: CompileDiagnostic[] = [],
): Promise<void> {
  compileResult.fail = null;
  compileResult.value = { scriptId, sourceHash, diagnostics };
  await requestCompile(scriptId, '# source', 0);
}

beforeEach(() => {
  resetCompiled();
  pipeline.captured.deps = null;
  compileResult.fail = null;
  setInvokeForTesting(async () => undefined as never);
});

afterEach(() => {
  clearSession();
  resetCompiled();
  setInvokeForTesting(null);
});

describe('the compile gate only judges the script it is looking at', () => {
  it('lets a take start while the store still holds another script', async () => {
    // Edit A, go back to the library, present B.
    await storeHolds('script-a', 'hash-a');
    await expect(gateFor('script-b', 'hash-b').ensureCompiled()).resolves.toBeUndefined();
  });

  it('is not fooled by another script that failed to compile', async () => {
    compileResult.fail = 'A is broken';
    await requestCompile('script-a', '# source', 0);
    await expect(gateFor('script-b', 'hash-b').ensureCompiled()).resolves.toBeUndefined();
  });

  it('ignores another script’s blocking diagnostics', async () => {
    await storeHolds('script-a', 'hash-a', [
      { code: 'X', message: 'A has an unclosed cue.', severity: 'error', blocking: true } as CompileDiagnostic,
    ]);
    await expect(gateFor('script-b', 'hash-b').ensureCompiled()).resolves.toBeUndefined();
  });

  it('still refuses when THIS script has moved on since the take was built', async () => {
    // §45.3, and the reason the gate exists: the stage would be prompting text
    // the aligner was not built from.
    await storeHolds('script-a', 'hash-newer');
    await expect(gateFor('script-a', 'hash-older').ensureCompiled()).rejects.toThrow(
      /changed after this take was prepared/,
    );
  });

  it('still refuses when THIS script has a blocking diagnostic', async () => {
    await storeHolds('script-a', 'hash-a', [
      { code: 'X', message: 'Unclosed cue.', severity: 'error', blocking: true } as CompileDiagnostic,
    ]);
    await expect(gateFor('script-a', 'hash-a').ensureCompiled()).rejects.toThrow(/Unclosed cue/);
  });

  it('still refuses when THIS script failed to compile', async () => {
    compileResult.fail = 'the worker died';
    await requestCompile('script-a', '# source', 0);
    await expect(gateFor('script-a', 'hash-a').ensureCompiled()).rejects.toThrow(/worker died/);
  });

  it('says nothing about a screen that no longer exists', async () => {
    await storeHolds('script-a', 'hash-newer');
    await expect(gateFor('script-a', 'hash-older').ensureCompiled()).rejects.not.toThrow(
      /Preflight/,
    );
  });

  it('an untouched store has no opinion at all', async () => {
    // A test, or a caller with its own compiler. The supplied script is then
    // the only authority and it has already been checked.
    await expect(gateFor('script-a', 'hash-a').ensureCompiled()).resolves.toBeUndefined();
  });
});
