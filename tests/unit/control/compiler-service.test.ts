import { afterEach, describe, expect, it } from 'vitest';
import {
  compileScript,
  disposeCompilerWorker,
  setCompilerWorkerFactoryForTesting,
  type WorkerLike,
} from '../../../src/control/services/compiler';
import type { CompiledScript } from '../../../src/shared/contracts';

function makeScript(scriptId: string, spokenWordCount = 12): CompiledScript {
  return {
    schemaVersion: 1,
    compilerVersion: 'test',
    scriptId,
    sourceHash: 'hash',
    settingsHash: 'settings',
    title: 'Test',
    outline: [],
    blocks: [],
    spokenTokens: [],
    sentences: [],
    navigationTargets: [],
    parts: [
      { id: 'p1', label: 'Opening', ordinal: 1, startTokenIndex: 0, endTokenIndex: 5, origin: 'marker' },
      { id: 'p2', label: 'Close', ordinal: 2, startTokenIndex: 6, endTokenIndex: 11, origin: 'marker' },
    ],
    cues: [],
    assets: [],
    diagnostics: [],
    statistics: {
      spokenWordCount,
      wordsPerMinute: 150,
      estimatedDurationSeconds: Math.round((spokenWordCount / 150) * 60),
      nonSpokenBlockCount: 0,
      imageCount: 0,
      diagramCount: 0,
      tableCount: 0,
      cueCount: 0,
      takeCount: 0,
      sentenceCount: 0,
      blockCount: 0,
    },
    indexes: {},
  } as unknown as CompiledScript;
}

/** Fake worker that records requests and lets the test answer manually. */
class FakeWorker implements WorkerLike {
  requests: Array<Record<string, unknown>> = [];
  private listener: ((event: MessageEvent) => void) | null = null;

  postMessage(message: unknown): void {
    this.requests.push(message as Record<string, unknown>);
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listener = listener;
  }
  terminate(): void {
    this.listener = null;
  }
  respondResult(requestId: number, scriptId = 's1'): void {
    this.listener?.({
      data: {
        type: 'compile_result',
        requestId,
        editorRevision: requestId,
        script: makeScript(scriptId),
        durationMs: 1,
      },
    } as MessageEvent);
  }
  respondSuperseded(requestId: number, supersededBy: number): void {
    this.listener?.({
      data: { type: 'compile_superseded', requestId, editorRevision: requestId, supersededBy },
    } as MessageEvent);
  }
  respondError(requestId: number, message: string): void {
    this.listener?.({
      data: { type: 'compile_error', requestId, editorRevision: requestId, message },
    } as MessageEvent);
  }
}

afterEach(() => {
  setCompilerWorkerFactoryForTesting(null);
  disposeCompilerWorker();
});

describe('compiler service', () => {
  it('carries the script parts through to the UI result (§parts)', async () => {
    /*
     * The service RESHAPES the compiled script into `CompileOutput`, field by
     * field. A field the worker produces and that mapping forgets is invisible
     * everywhere else: the compiler tests would still pass, the contract would
     * still typecheck, and the launch menu would simply never offer a part.
     */
    const fake = new FakeWorker();
    setCompilerWorkerFactoryForTesting(() => fake);
    const pending = compileScript('s1', '# Hello');
    fake.respondResult(fake.requests[0]!['requestId'] as number);
    const output = await pending;
    expect(output.parts.map((p) => p.label)).toEqual(['Opening', 'Close']);
  });

  it('round-trips a compile through the worker protocol', async () => {
    const fake = new FakeWorker();
    setCompilerWorkerFactoryForTesting(() => fake);

    const pending = compileScript('s1', '# Hello');
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request['type']).toBe('compile');
    expect(request['scriptId']).toBe('s1');
    expect(request['operation']).toBe('full');
    expect(request['options']).toMatchObject({ scriptId: 's1' });
    expect(typeof request['editorRevision']).toBe('number');

    fake.respondResult(request['requestId'] as number);
    const output = await pending;
    expect(output.stale).toBe(false);
    expect(output.spokenWordCount).toBe(12);
    expect(output.script?.scriptId).toBe('s1');
  });

  it('marks late results for superseded requests stale', async () => {
    const fake = new FakeWorker();
    setCompilerWorkerFactoryForTesting(() => fake);

    const first = compileScript('s1', 'v1');
    const second = compileScript('s1', 'v2');
    const firstId = fake.requests[0]!['requestId'] as number;
    const secondId = fake.requests[1]!['requestId'] as number;
    expect(secondId).toBeGreaterThan(firstId);

    // Older result arrives after a newer request exists → stale.
    fake.respondResult(firstId);
    fake.respondResult(secondId);

    expect((await first).stale).toBe(true);
    expect((await second).stale).toBe(false);
  });

  it('resolves compile_superseded answers as stale placeholders', async () => {
    const fake = new FakeWorker();
    setCompilerWorkerFactoryForTesting(() => fake);

    const first = compileScript('s1', 'v1');
    const second = compileScript('s1', 'v2');
    const firstId = fake.requests[0]!['requestId'] as number;
    const secondId = fake.requests[1]!['requestId'] as number;

    fake.respondSuperseded(firstId, secondId);
    fake.respondResult(secondId);

    const firstOut = await first;
    expect(firstOut.stale).toBe(true);
    expect(firstOut.script).toBeNull();
    expect((await second).stale).toBe(false);
  });

  it('rejects on compile_error', async () => {
    const fake = new FakeWorker();
    setCompilerWorkerFactoryForTesting(() => fake);
    const pending = compileScript('s1', 'v1');
    fake.respondError(fake.requests[0]!['requestId'] as number, 'boom');
    await expect(pending).rejects.toThrow('boom');
  });

  it('reuses one worker across compiles', async () => {
    let constructed = 0;
    const fake = new FakeWorker();
    setCompilerWorkerFactoryForTesting(() => {
      constructed += 1;
      return fake;
    });
    const a = compileScript('s1', 'a');
    const b = compileScript('s1', 'b');
    fake.respondResult(fake.requests[0]!['requestId'] as number);
    fake.respondResult(fake.requests[1]!['requestId'] as number);
    await Promise.all([a, b]);
    expect(constructed).toBe(1);
  });
});
