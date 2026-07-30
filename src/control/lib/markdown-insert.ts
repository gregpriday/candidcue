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

/*
 * An ATX heading, as CommonMark actually defines one: up to three spaces of
 * indent, one to six hashes, then a space, a tab or the end of the line. The
 * end-of-line case matters — a bare `######` is a valid empty H6, and a
 * pattern demanding whitespace after the hashes read it as ordinary text and
 * cycled it to `# ######`.
 *
 * Setext headings (a line underlined with `===` or `---`) are deliberately out
 * of scope: they are a property of the FOLLOWING line, and a control that
 * edits the current one cannot cycle them honestly.
 */
const ATX_HEADING = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;

/** Leading whitespace on a line that is not a heading. */
const LEADING_SPACE = /^[ \t]*/;

/** The largest heading Markdown has; the cycle wraps back to plain after it. */
const MAX_HEADING_LEVEL = 6;

/**
 * Cycle the current line's heading level: plain → H1 → H2 → … → H6 → plain.
 *
 * This used to be `insertHeading`, and it could only ever produce an H1: on a
 * line that already began with `#` it focused the editor and returned, so the
 * button did nothing at all and said nothing about why. Every heading below
 * the top level had to be typed by hand, and pressing the button on one was
 * indistinguishable from the button being broken.
 *
 * The caret keeps its place in the TEXT rather than its offset in the line —
 * the marker in front of it changes width, and holding the offset would slide
 * the caret through the first word every time the level changed.
 */
export function cycleHeading(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const current = ATX_HEADING.exec(line.text);

  // The line's own indentation survives the cycle in both directions; only
  // the hashes come and go.
  const indent = current?.[1] ?? LEADING_SPACE.exec(line.text)?.[0] ?? '';
  const marker = current?.[0] ?? indent;
  const level = current?.[2]?.length ?? 0;
  const next = level >= MAX_HEADING_LEVEL ? indent : `${indent}${'#'.repeat(level + 1)} `;
  const shift = next.length - marker.length;

  /* Clamped to the line's start so a caret sitting inside the marker being
     removed lands on the text rather than before the line. */
  const move = (pos: number): number =>
    pos < line.from + marker.length ? line.from + next.length : pos + shift;

  view.dispatch({
    changes: { from: line.from, to: line.from + marker.length, insert: next },
    selection: { anchor: move(range.anchor), head: move(range.head) },
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

/**
 * Insert a reference to an image that has ALREADY been imported.
 *
 * C10: this used to insert the literal `![Image description](./assets/image.png)`
 * — a file that does not exist and never would, because nothing in the product
 * called `import_image`. The path now comes from the importer's `markdownPath`,
 * which is what the compiler and the asset-protocol scope both resolve.
 */
export function insertImage(view: EditorView, markdownPath: string, altText = 'Image description'): void {
  const alt = altText.replace(/[[\]]/g, '');
  insertBlock(view, `![${alt}](${markdownPath})`);
}

export function insertDiagram(view: EditorView): void {
  insertBlock(view, '```mermaid\nflowchart LR\n  A --> B\n```');
}

export function insertTakeMarker(view: EditorView): void {
  insertBlock(view, '[Take: name this take]');
}
