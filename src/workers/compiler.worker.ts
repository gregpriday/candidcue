/// <reference lib="webworker" />
/**
 * Compiler worker (spec §42.1, §45.3) — Markdown compilation off the UI
 * thread. Instantiate from the control window with:
 *
 *   new Worker(new URL('../workers/compiler.worker.ts', import.meta.url), { type: 'module' })
 *
 * Protocol: src/shared/markdown/worker-protocol.ts. Latest request wins:
 * requests queued behind a newer one (or carrying an older editorRevision)
 * are answered with `compile_superseded` and never compiled.
 */
import { compile } from '../shared/markdown/compile';
import type {
  CompileRequestMessage,
  CompilerWorkerRequest,
  CompilerWorkerResponse,
} from '../shared/markdown/worker-protocol';

const post = (message: CompilerWorkerResponse) => {
  (self as unknown as { postMessage(m: CompilerWorkerResponse): void }).postMessage(message);
};

let pending: CompileRequestMessage | null = null;
let scheduled = false;
let latestRevision = Number.NEGATIVE_INFINITY;

function supersede(request: CompileRequestMessage, supersededBy?: number): void {
  post({
    type: 'compile_superseded',
    requestId: request.requestId,
    editorRevision: request.editorRevision,
    ...(supersededBy !== undefined ? { supersededBy } : {}),
  });
}

function runPending(): void {
  scheduled = false;
  const request = pending;
  pending = null;
  if (!request) return;
  const startedAt = performance.now();
  try {
    // Incremental compiles fall back to a full compile in v1; the result is
    // versioned and immutable either way (spec §45.3).
    const script = compile(request.source, {
      ...request.options,
      scriptId: request.scriptId,
    });
    post({
      type: 'compile_result',
      requestId: request.requestId,
      editorRevision: request.editorRevision,
      script,
      durationMs: performance.now() - startedAt,
    });
  } catch (error) {
    post({
      type: 'compile_error',
      requestId: request.requestId,
      editorRevision: request.editorRevision,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<CompilerWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (pending && (message.requestId === undefined || pending.requestId === message.requestId)) {
      supersede(pending);
      pending = null;
    }
    return;
  }
  if (message.type !== 'compile') return;

  // Stale editor revisions are never compiled (spec §45.3).
  if (message.editorRevision < latestRevision) {
    supersede(message);
    return;
  }
  latestRevision = message.editorRevision;

  // Latest wins: displace any not-yet-started request.
  if (pending) supersede(pending, message.requestId);
  pending = message;

  if (!scheduled) {
    scheduled = true;
    // Defer one microtask so a burst of queued messages collapses into a
    // single compile of the newest source snapshot.
    queueMicrotask(runPending);
  }
};

export {};
