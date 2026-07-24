/**
 * Compiler worker service — the single place the control window talks to the
 * compile Web Worker (spec §45.3). Speaks the shared protocol in
 * src/shared/markdown/worker-protocol.ts; if the protocol evolves, THIS FILE
 * is the only integration point that changes.
 *
 * Requests carry a monotonic revision; results for superseded requests come
 * back with `stale: true` and must be discarded by callers.
 */
import type {
  CompileDiagnostic,
  CompiledBlock,
  CompiledScript,
  NavigationTarget,
  OutlineNode,
  SentenceUnit,
} from '../../shared/contracts';
import type {
  CompileRequestMessage,
  CompilerWorkerResponse,
} from '../../shared/markdown/worker-protocol';

/** Result shape consumed by the UI stores. */
export interface CompileOutput {
  stale: boolean;
  requestId: number;
  scriptId: string;
  sourceHash: string;
  /** Full immutable compile result (null when superseded). */
  script: CompiledScript | null;
  blocks: CompiledBlock[];
  outline: OutlineNode[];
  sentences: SentenceUnit[];
  navigationTargets: NavigationTarget[];
  diagnostics: CompileDiagnostic[];
  spokenWordCount: number;
  estimatedDurationSeconds: number;
}

/** Minimal worker surface so tests can inject a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

type WorkerFactory = () => WorkerLike;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('../../workers/compiler.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;

let workerFactory: WorkerFactory = defaultFactory;

/** Inject a fake worker in unit tests. Pass `null` to restore the default. */
export function setCompilerWorkerFactoryForTesting(factory: WorkerFactory | null): void {
  workerFactory = factory ?? defaultFactory;
  disposeCompilerWorker();
}

let worker: WorkerLike | null = null;
/** Global monotonic tag — doubles as the wire `editorRevision` so the
 * worker's latest-wins ordering holds across script switches. */
let latestRequestId = 0;

interface Pending {
  scriptId: string;
  resolve(result: CompileOutput): void;
  reject(error: Error): void;
}
const pending = new Map<number, Pending>();

function supersededOutput(requestId: number, scriptId: string): CompileOutput {
  return {
    stale: true,
    requestId,
    scriptId,
    sourceHash: '',
    script: null,
    blocks: [],
    outline: [],
    sentences: [],
    navigationTargets: [],
    diagnostics: [],
    spokenWordCount: 0,
    estimatedDurationSeconds: 0,
  };
}

function handleResponse(data: CompilerWorkerResponse): void {
  const entry = pending.get(data.requestId);
  if (!entry) return;
  pending.delete(data.requestId);
  if (data.type === 'compile_result') {
    const script = data.script;
    entry.resolve({
      stale: data.requestId !== latestRequestId,
      requestId: data.requestId,
      scriptId: script.scriptId,
      sourceHash: script.sourceHash,
      script,
      blocks: script.blocks,
      outline: script.outline,
      sentences: script.sentences,
      navigationTargets: script.navigationTargets,
      diagnostics: script.diagnostics,
      spokenWordCount: script.statistics.spokenWordCount,
      estimatedDurationSeconds: script.statistics.estimatedDurationSeconds,
    });
  } else if (data.type === 'compile_superseded') {
    entry.resolve(supersededOutput(data.requestId, entry.scriptId));
  } else {
    entry.reject(new Error(data.message));
  }
}

function ensureWorker(): WorkerLike {
  if (worker) return worker;
  worker = workerFactory();
  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as CompilerWorkerResponse | null;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    handleResponse(data);
  });
  return worker;
}

/** Compile a script source off the UI thread (latest request wins). */
export function compileScript(scriptId: string, source: string): Promise<CompileOutput> {
  const w = ensureWorker();
  latestRequestId += 1;
  const requestId = latestRequestId;
  const request: CompileRequestMessage = {
    type: 'compile',
    requestId,
    editorRevision: requestId,
    scriptId,
    source,
    options: { scriptId },
    operation: 'full',
  };
  return new Promise<CompileOutput>((resolve, reject) => {
    pending.set(requestId, { scriptId, resolve, reject });
    w.postMessage(request);
  });
}

/** Terminate the worker (editor teardown / tests). */
export function disposeCompilerWorker(): void {
  if (worker) worker.terminate();
  worker = null;
  pending.clear();
}
