/**
 * Compiler worker protocol tests (spec §45.3). The worker module reads
 * `self`, so we install a minimal worker-global shim before importing it.
 * Lives beside the markdown package because the worker is a thin shell over
 * this package's compile().
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  CompileRequestMessage,
  CompilerWorkerResponse,
} from './worker-protocol';

interface WorkerShim {
  postMessage(message: CompilerWorkerResponse): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const outbox: CompilerWorkerResponse[] = [];
let shim: WorkerShim;

beforeAll(async () => {
  shim = {
    postMessage: (message) => outbox.push(message),
    onmessage: null,
  };
  (globalThis as Record<string, unknown>)['self'] = shim;
  await import('../../workers/compiler.worker');
  expect(shim.onmessage).toBeTypeOf('function');
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let nextId = 1;
function request(overrides: Partial<CompileRequestMessage> = {}): CompileRequestMessage {
  return {
    type: 'compile',
    requestId: nextId++,
    editorRevision: nextId,
    scriptId: 'worker-test',
    source: '# Title\n\nHello worker world.',
    options: { scriptId: 'worker-test' },
    operation: 'full',
    ...overrides,
  };
}

describe('compiler worker protocol (spec §45.3)', () => {
  it('compiles a request and returns a versioned result', async () => {
    outbox.length = 0;
    const req = request();
    shim.onmessage!({ data: req });
    await flush();
    expect(outbox).toHaveLength(1);
    const result = outbox[0]!;
    expect(result.type).toBe('compile_result');
    if (result.type === 'compile_result') {
      expect(result.requestId).toBe(req.requestId);
      expect(result.editorRevision).toBe(req.editorRevision);
      expect(result.script.spokenTokens.map((t) => t.normalized)).toEqual([
        'hello',
        'worker',
        'world',
      ]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('latest request wins: earlier queued requests are superseded, not compiled', async () => {
    outbox.length = 0;
    const first = request({ source: 'First version.' });
    const second = request({ source: 'Second version wins.' });
    shim.onmessage!({ data: first });
    shim.onmessage!({ data: second });
    await flush();
    const superseded = outbox.find((m) => m.type === 'compile_superseded');
    const result = outbox.find((m) => m.type === 'compile_result');
    expect(superseded).toBeDefined();
    if (superseded?.type === 'compile_superseded') {
      expect(superseded.requestId).toBe(first.requestId);
      expect(superseded.supersededBy).toBe(second.requestId);
    }
    expect(result).toBeDefined();
    if (result?.type === 'compile_result') {
      expect(result.requestId).toBe(second.requestId);
      expect(result.script.spokenTokens.some((t) => t.normalized === 'second')).toBe(true);
      expect(result.script.spokenTokens.some((t) => t.normalized === 'first')).toBe(false);
    }
  });

  it('rejects stale editor revisions outright', async () => {
    outbox.length = 0;
    const current = request({ editorRevision: 500 });
    shim.onmessage!({ data: current });
    await flush();
    outbox.length = 0;
    const stale = request({ editorRevision: 3 });
    shim.onmessage!({ data: stale });
    await flush();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.type).toBe('compile_superseded');
  });

  it('cancel drops the pending request', async () => {
    outbox.length = 0;
    const req = request({ editorRevision: 1000 });
    shim.onmessage!({ data: req });
    shim.onmessage!({ data: { type: 'cancel', requestId: req.requestId } });
    await flush();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.type).toBe('compile_superseded');
  });
});
