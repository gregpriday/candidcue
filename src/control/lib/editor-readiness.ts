/**
 * When the editor is still opening a script — the one question behind the
 * loading panel (issue #140).
 *
 * Opening a script used to land in four separate paints: the header and insert
 * toolbar mounted from whatever the stores still held, `openScript` reset them,
 * the document arrived, and finally the compile came back and gave the header a
 * metadata line it did not have before — which grew the header and shoved the
 * toolbar down. Only the last of those is the jump people actually notice, and
 * it happens well AFTER `loading` has gone false, which is why gating on
 * `loading` alone cannot fix it.
 *
 * So the editor stays covered until everything it is about to draw is in hand:
 * the document AND the first compile of that document, because the header's
 * metadata, the outline and the preview all come from the compile rather than
 * from the document.
 *
 * This lives outside the component so the rule can be read as a truth table
 * instead of inferred from a Svelte template.
 */
import type { CompiledState } from '../stores/compiled';
import type { EditorState } from '../stores/editor';

/** Just the parts of the editor store this decision reads. */
export type EditorOpenSnapshot = Pick<EditorState, 'scriptId' | 'loading'>;

/** Just the parts of the compile store this decision reads. */
export type CompileOpenSnapshot = Pick<CompiledState, 'scriptId' | 'status'>;

/**
 * What the editor component knows that the stores cannot say.
 *
 * `openStarted` — this component has begun its own open. Nothing resets the
 * stores when the editor unmounts, so leaving a script and coming straight back
 * to it finds both stores still settled on that same id. Without this flag the
 * first render would show the previous visit's document before the effect that
 * reopens it has run.
 *
 * `firstCompileSettled` — a latch, not a live reading. It is set once per open
 * and never cleared until the next open. Reading the compile status live would
 * be a bug with teeth: every debounced compile while typing returns the status
 * to `compiling`, which would raise the panel over a working editor and destroy
 * the CodeMirror instance — and the undo history with it — on a keystroke.
 */
export interface EditorOpenLifecycle {
  openStarted: boolean;
  firstCompileSettled: boolean;
}

/**
 * Is the first compile of THIS script finished, one way or the other?
 *
 * `error` settles it as firmly as `ready` does. A script that cannot compile is
 * still a script the author has to be able to see and fix, so a compile failure
 * has to hand the editor over rather than leave the panel up forever.
 *
 * Both stores are checked against the requested id: `compiled` keeps its own
 * `scriptId` precisely so a result belonging to the previous script cannot be
 * mistaken for this one's.
 */
export function isCompileSettledForScript(
  scriptId: string,
  editor: EditorOpenSnapshot,
  compiled: CompileOpenSnapshot,
): boolean {
  if (editor.scriptId !== scriptId || editor.loading) return false;
  if (compiled.scriptId !== scriptId) return false;
  return compiled.status === 'ready' || compiled.status === 'error';
}

/** Should the loading panel be covering the editor? */
export function isEditorOpening(
  scriptId: string,
  editor: EditorOpenSnapshot,
  lifecycle: EditorOpenLifecycle,
): boolean {
  if (!lifecycle.openStarted) return true;
  if (editor.scriptId !== scriptId || editor.loading) return true;
  return !lifecycle.firstCompileSettled;
}
