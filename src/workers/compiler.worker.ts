/// <reference lib="webworker" />
/**
 * Compiler worker shell — Markdown compilation runs off the UI thread
 * (spec §42.1). Instantiate from the control window with:
 *
 *   new Worker(new URL('../workers/compiler.worker.ts', import.meta.url), { type: 'module' })
 *
 * The real unified/remark/rehype pipeline replaces the stub below.
 */
import type {
  CompileDiagnostic,
  CompiledBlock,
  OutlineNode,
  SentenceUnit,
  NavigationTarget,
} from '../shared/contracts';

export interface CompileRequest {
  type: 'compile';
  requestId: number;
  scriptId: string;
  source: string;
  sourceHash: string;
}

export interface CompileResult {
  type: 'compile_result';
  requestId: number;
  scriptId: string;
  sourceHash: string;
  blocks: CompiledBlock[];
  outline: OutlineNode[];
  sentences: SentenceUnit[];
  navigationTargets: NavigationTarget[];
  diagnostics: CompileDiagnostic[];
  spokenWordCount: number;
}

export type CompilerWorkerRequest = CompileRequest;
export type CompilerWorkerResponse = CompileResult;

self.onmessage = (event: MessageEvent<CompilerWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'compile') return;

  // Stub: an empty, diagnostic-free compile so callers can wire plumbing.
  const result: CompileResult = {
    type: 'compile_result',
    requestId: request.requestId,
    scriptId: request.scriptId,
    sourceHash: request.sourceHash,
    blocks: [],
    outline: [],
    sentences: [],
    navigationTargets: [],
    diagnostics: [],
    spokenWordCount: 0,
  };
  self.postMessage(result);
};

export {};
