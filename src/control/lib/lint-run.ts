/**
 * The run a reading note is about, marked in the editor once the note has been
 * followed to it.
 *
 * Following a note puts the caret at the start of the run and scrolls it into
 * view, and on its own that says very little: a long sentence usually starts in
 * the middle of a paragraph, and "no full stop" is about the last word of one.
 * The author was left rereading the paragraph to work out what the note meant —
 * and when the run was already on screen, clicking the note changed nothing
 * they could see at all.
 *
 * So the run is marked, as a passage rather than as a selection. A note
 * reveals and never selects (see `goToFinding` in `Editor.svelte`), and a mark
 * that looked like a selection would tell the author the next keystroke
 * replaces it. The mark is the rail's own neutral grey, and the accent stays
 * with the real selection.
 *
 * It lasts exactly as long as the author is looking at it: typing, moving the
 * caret, leaving the editor or following another note all retire it. A mark
 * outliving its moment would be one more thing on the page marking the script.
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** Mark one run of the document, or clear the mark with `null`. */
export const showLintRun = StateEffect.define<{ from: number; to: number } | null>();

const runMark = Decoration.mark({ class: 'cm-lint-run' });

const lintRunField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(showLintRun)) continue;
      const run = effect.value;
      return run && run.to > run.from
        ? Decoration.set([runMark.range(run.from, run.to)])
        : Decoration.none;
    }
    if (marks.size === 0) return marks;
    // The jump's own dispatch moves the caret too, but it is not a user event,
    // so only a caret the author moved counts.
    if (tr.docChanged || tr.isUserEvent('select')) return Decoration.none;
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const lintRun: Extension = [
  lintRunField,
  EditorView.focusChangeEffect.of((_state, focusing) => (focusing ? null : showLintRun.of(null))),
];
