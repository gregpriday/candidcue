/**
 * CompiledScriptStore (spec §45.2) — the latest immutable compile result.
 * Requests are tagged with the editor revision; stale results are discarded
 * (spec §45.3).
 */
import { writable } from 'svelte/store';
import { compileScript, type CompileOutput } from '../services/compiler';

export type CompileStatus = 'idle' | 'compiling' | 'ready' | 'error';

export interface CompiledState {
  status: CompileStatus;
  editorRevision: number;
  result: CompileOutput | null;
  error: string | null;
}

const state = writable<CompiledState>({ status: 'idle', editorRevision: -1, result: null, error: null });
export const compiled = { subscribe: state.subscribe };

let latestRequestedRevision = -1;

export async function requestCompile(
  scriptId: string,
  source: string,
  editorRevision: number,
): Promise<void> {
  latestRequestedRevision = editorRevision;
  state.update((s) => ({ ...s, status: 'compiling' }));
  try {
    const output = await compileScript(scriptId, source);
    if (editorRevision !== latestRequestedRevision || output.stale) return; // superseded
    state.set({ status: 'ready', editorRevision, result: output, error: null });
  } catch (err) {
    if (editorRevision !== latestRequestedRevision) return;
    state.set({ status: 'error', editorRevision, result: null, error: String(err) });
  }
}

export function resetCompiled(): void {
  latestRequestedRevision = -1;
  state.set({ status: 'idle', editorRevision: -1, result: null, error: null });
}
