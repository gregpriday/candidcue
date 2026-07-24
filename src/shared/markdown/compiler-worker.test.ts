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

/**
 * Deliver a message the way a real Worker does: one `message` event per
 * macrotask, never several inside one synchronous turn.
 *
 * The previous version of this file called `shim.onmessage` twice in a row in
 * the same task, which manufactured the coalescing it was asserting: with a
 * `queueMicrotask` scheduler, real queued messages are only dispatched *after*
 * the microtask has already compiled, so nothing was ever superseded in
 * production. Sending each message in its own task reproduces reality.
 */
const deliver = (data: unknown): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => {
      shim.onmessage!({ data });
      resolve();
    }, 0);
  });

/**
 * Deliver a burst the way a fast typist's keystrokes arrive: every message
 * event is queued as its own task in the same turn, so they are all already
 * waiting by the time the worker's scheduled compile runs. This is the shape
 * a microtask scheduler cannot coalesce.
 */
const deliverBurst = async (messages: unknown[]): Promise<void> => {
  for (const message of messages) setTimeout(() => shim.onmessage!(({ data: message })), 0);
  await settle();
};

/** Let every already-queued task (including the worker's own) run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

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
    await deliver(req);
    await settle();
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

  it('latest request wins when both messages are real, separately queued events', async () => {
    outbox.length = 0;
    const first = request({ source: 'First version.' });
    const second = request({ source: 'Second version wins.' });
    await deliverBurst([first, second]);
    await settle();
    const superseded = outbox.find((m) => m.type === 'compile_superseded');
    const results = outbox.filter((m) => m.type === 'compile_result');
    expect(superseded).toBeDefined();
    if (superseded?.type === 'compile_superseded') {
      expect(superseded.requestId).toBe(first.requestId);
      expect(superseded.supersededBy).toBe(second.requestId);
    }
    // Exactly one compile ran, for the newest snapshot.
    expect(results).toHaveLength(1);
    const result = results[0]!;
    if (result.type === 'compile_result') {
      expect(result.requestId).toBe(second.requestId);
      expect(result.script.spokenTokens.some((t) => t.normalized === 'second')).toBe(true);
      expect(result.script.spokenTokens.some((t) => t.normalized === 'first')).toBe(false);
    }
  });

  it('coalesces a keystroke burst into a single compile of the newest source', async () => {
    outbox.length = 0;
    const burst = Array.from({ length: 8 }, (_, i) =>
      request({ source: `Draft revision ${i} of the script.` }),
    );
    await deliverBurst(burst);
    await settle();
    const results = outbox.filter((m) => m.type === 'compile_result');
    expect(results).toHaveLength(1);
    const last = burst[burst.length - 1]!;
    if (results[0]!.type === 'compile_result') {
      expect(results[0]!.requestId).toBe(last.requestId);
    }
    // Every earlier request is answered, never silently dropped.
    const superseded = outbox.filter((m) => m.type === 'compile_superseded');
    expect(superseded).toHaveLength(burst.length - 1);
    expect(superseded.map((m) => m.requestId).sort((a, b) => a - b)).toEqual(
      burst.slice(0, -1).map((r) => r.requestId),
    );
  });

  it('rejects stale editor revisions outright', async () => {
    outbox.length = 0;
    await deliver(request({ editorRevision: 500 }));
    await settle();
    outbox.length = 0;
    await deliver(request({ editorRevision: 3 }));
    await settle();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.type).toBe('compile_superseded');
  });

  it('cancel arriving in a later task still beats the compile', async () => {
    outbox.length = 0;
    const req = request({ editorRevision: 1000 });
    // Cancel in its own task: with a microtask scheduler the compile had
    // already run and posted before this ever arrived.
    await deliverBurst([req, { type: 'cancel', requestId: req.requestId }]);
    await settle();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.type).toBe('compile_superseded');
    expect(outbox.some((m) => m.type === 'compile_result')).toBe(false);
  });

  it('never answers a superseded request with a result or an error', async () => {
    outbox.length = 0;
    const burst = Array.from({ length: 4 }, (_, i) => request({ editorRevision: 3000 + i }));
    await deliverBurst(burst);
    await settle();
    const answeredIds = new Map(outbox.map((m) => [m.requestId, m.type]));
    for (const req of burst.slice(0, -1)) {
      // Superseded requests are always answered, and only ever as superseded:
      // a stale error must not surface as the editor's current state either.
      expect(answeredIds.get(req.requestId)).toBe('compile_superseded');
    }
    expect(answeredIds.get(burst[burst.length - 1]!.requestId)).toBe('compile_result');
    expect(outbox.some((m) => m.type === 'compile_error')).toBe(false);
  });
});
