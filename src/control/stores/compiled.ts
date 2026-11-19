/**
 * CompiledScriptStore — the latest immutable compile result.
 * Requests are tagged with the editor revision; stale results are discarded.
 */
import { writable } from 'svelte/store';
import { compileScript, type CompileOutput, type CompileOverrides } from '../services/compiler';

export type CompileStatus = 'idle' | 'compiling' | 'ready' | 'error';

export interface CompiledState {
  status: CompileStatus;
  editorRevision: number;
  result: CompileOutput | null;
  error: string | null;
  /**
   * Which script this state is about, kept even when the compile FAILED.
   *
   * `result` carries a scriptId, but a failed compile has no result — so
   * without this an error belonging to one script is indistinguishable from an
   * error belonging to the next one, and a reader has no way to tell whether
   * the store has anything to say about the script it is asking about.
   */
  scriptId: string | null;
  /**
   * The exact text `result` was compiled from, or null with no result.
   *
   * A request superseded by a newer one never reaches the store, so the result
   * in hand can be of older text than the editor holds — and `editorRevision`
   * cannot say whether that text is the same again (an edit undone). A reader
   * that needs "is this a compile of the text on screen?" compares this.
   * Optional so a hand-built state need not spell it; absent reads as unknown.
   */
  source?: string | null;
}

const state = writable<CompiledState>({
  status: 'idle',
  editorRevision: -1,
  result: null,
  error: null,
  scriptId: null,
  source: null,
});
export const compiled = { subscribe: state.subscribe };

let latestRequestedRevision = -1;

export async function requestCompile(
  scriptId: string,
  source: string,
  editorRevision: number,
  options?: CompileOverrides,
): Promise<void> {
  latestRequestedRevision = editorRevision;
  state.update((s) => ({ ...s, status: 'compiling', scriptId }));
  try {
    const output = await compileScript(scriptId, source, options);
    if (editorRevision !== latestRequestedRevision || output.stale) return; // superseded
    state.set({ status: 'ready', editorRevision, result: output, error: null, scriptId, source });
  } catch (err) {
    if (editorRevision !== latestRequestedRevision) return;
    state.set({ status: 'error', editorRevision, result: null, error: String(err), scriptId, source: null });
  }
}

export function resetCompiled(): void {
  latestRequestedRevision = -1;
  state.set({ status: 'idle', editorRevision: -1, result: null, error: null, scriptId: null, source: null });
}
