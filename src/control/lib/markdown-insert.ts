/**
 * Editor insert controls (spec §13.6). Every action inserts plain Markdown
 * or CandidCue's documented directive syntax (spec §23) so documents remain
 * readable outside CandidCue.
 */
import type { EditorView } from '@codemirror/view';

function wrapSelection(view: EditorView, before: string, after: string, placeholder: string): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to) || placeholder;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `${before}${selected}${after}` },
    selection: {
      anchor: range.from + before.length,
      head: range.from + before.length + selected.length,
    },
  });
  view.focus();
}

function insertBlock(view: EditorView, block: string): void {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const needsLeadingBreak = line.length > 0;
  const insert = `${needsLeadingBreak ? '\n\n' : ''}${block}\n`;
  const from = line.to;
  view.dispatch({
    changes: { from, to: from, insert },
    selection: { anchor: from + insert.length },
  });
  view.focus();
}

export function insertHeading(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  if (/^#{1,6}\s/.test(line.text)) {
    view.focus();
    return;
  }
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: '# ' },
    selection: { anchor: range.anchor + 2, head: range.head + 2 },
  });
  view.focus();
}

export function insertBold(view: EditorView): void {
  wrapSelection(view, '**', '**', 'bold text');
}

export function insertItalic(view: EditorView): void {
  wrapSelection(view, '*', '*', 'italic text');
}

export function insertLink(view: EditorView): void {
  wrapSelection(view, '[', '](https://)', 'link text');
}

export function insertCue(view: EditorView): void {
  wrapSelection(view, '[Cue: ', ']', 'stage direction');
}

export function insertImage(view: EditorView): void {
  insertBlock(view, '![Image description](./assets/image.png)');
}

export function insertDiagram(view: EditorView): void {
  insertBlock(view, '```mermaid\nflowchart LR\n  A --> B\n```');
}

export function insertTakeMarker(view: EditorView): void {
  insertBlock(view, '[Take: name this take]');
}
