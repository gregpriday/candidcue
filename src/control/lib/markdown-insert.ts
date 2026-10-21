/**
 * Editor insert controls (spec §13.6). Every action inserts plain Markdown
 * or Speaking Glass's documented directive syntax (spec §23) so documents remain
 * readable outside Speaking Glass.
 */
import { ensureSyntaxTree } from '@codemirror/language';
import type { EditorState, Line } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

type Tree = NonNullable<ReturnType<typeof ensureSyntaxTree>>;
type SyntaxNode = ReturnType<Tree['resolveInner']>;

/*
 * Every insert dispatches with `scrollIntoView`. The toolbar acts on the
 * caret, and the caret need not be on screen: scroll away from it to read
 * something, press Bold, and without this the edit landed out of sight with
 * nothing to show it had happened at all.
 */

function wrapSelection(
  view: EditorView,
  before: string,
  after: string,
  placeholder: string,
  { spaced = false }: { spaced?: boolean } = {},
): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to) || placeholder;
  /* An inline construct dropped against a word reads as part of it: a cue at
     the start of a paragraph came out as `[Cue: …]Every tool`. `spaced` gives
     it a space on whichever side touches text. */
  const prev = state.sliceDoc(Math.max(state.doc.lineAt(range.from).from, range.from - 1), range.from);
  const next = state.sliceDoc(range.to, Math.min(state.doc.lineAt(range.to).to, range.to + 1));
  const lead = spaced && /[^\s([{]/.test(prev) ? ' ' : '';
  const trail = spaced && /[^\s.,;:!?)\]}]/.test(next) ? ' ' : '';
  const start = range.from + lead.length + before.length;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `${lead}${before}${selected}${after}${trail}` },
    selection: { anchor: start, head: start + selected.length },
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * A blank line as CommonMark defines one: spaces and tabs and nothing else.
 * Not `\s` — that also matches a no-break space, which Markdown reads as text,
 * and treating such a line as blank would delete it.
 */
const BLANK_LINE = /^[ \t]*$/;

/**
 * Block constructs nothing may be inserted into. A part break typed inside a
 * mermaid fence became a line of the diagram, and a block dropped into a table
 * ends the table there.
 */
const SEALED = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'Table']);

/** The sealed block around `pos`, if there is one. */
/** Where a block goes: the range it replaces and the breaks around it. */
interface Placement {
  from: number;
  to: number;
  lead: string;
  gap: string;
}

function sealedAt(tree: Tree, pos: number): { from: number; to: number; open: boolean } | null {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (SEALED.has(node.name)) return { from: node.from, to: node.to, open: unclosedFence(node) };
  }
  return null;
}

/**
 * A fence with no closing line runs to the end of the document, so nothing
 * placed after it ever leaves it: the marker would read as success and be one
 * more line of the diagram.
 */
function unclosedFence(node: SyntaxNode): boolean {
  if (node.name !== 'FencedCode') return false;
  let marks = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeMark') marks += 1;
  }
  return marks < 2;
}

/**
 * Whether a break at `at` — the edge of a line — would cut through inline
 * Markdown that carries on across the line break: `**two words` on one line
 * and `more words**` on the next is one emphasis, and a block between them
 * leaves two lines of stray asterisks.
 */
function cutsInline(tree: Tree, at: number): boolean {
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(at, side); node; node = node.parent) {
      if (node.name === 'Paragraph' || node.name === 'Document') break;
      if (node.from < at && node.to > at) return true;
    }
  }
  return false;
}

/** The paragraph around `pos`, when the tree has one. */
function paragraphAt(tree: Tree, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'Paragraph') return node;
  }
  return null;
}

/**
 * Whether a block can go in at `pos` by splitting the paragraph there.
 *
 * Only a top-level paragraph, only between words, and only outside every
 * inline construct — emphasis, a link, and the app's own `[Cue: …]` and
 * `[Take: …]` directives, which the Markdown parser reads as links. Anywhere
 * else a split would cut something in two.
 */
function splitsAt(tree: Tree, state: EditorState, pos: number): boolean {
  const left = tree.resolveInner(pos, -1);
  const right = tree.resolveInner(pos, 1);
  const between = /\s/.test(state.sliceDoc(pos - 1, pos)) || /\s/.test(state.sliceDoc(pos, pos + 1));
  return (
    between &&
    left.name === 'Paragraph' &&
    right.name === 'Paragraph' &&
    left.from === right.from &&
    left.parent?.name === 'Document'
  );
}

/**
 * Insert Markdown as a block of its own, a blank line away from its neighbours.
 *
 * An image line or a `[Take: …]` marker cannot interrupt a paragraph: written
 * directly under a line of text it is a lazy continuation, and the compiler
 * reads it as the tail of the paragraph above — an inline image in spoken
 * text, a cue chip at the end of a sentence. The blank line between two
 * paragraphs is the obvious place to put one, and it was exactly where this
 * went wrong: only a caret line WITH text earned a leading blank line, so on
 * the empty line under a paragraph the block was glued straight onto it.
 *
 * WHERE IT GOES is where the caret is, as near as the Markdown allows:
 *   - on a blank line, in that line's place (stray spaces and tabs with it);
 *   - at the very start of a line of text, in front of that line;
 *   - between two words of a paragraph, splitting the paragraph there;
 *   - inside a fence, a table or raw HTML, after that whole construct — or
 *     in front of it, for a fence never closed, which nothing can get after;
 *   - anywhere else (inside a word, a heading, a directive, a list item, or
 *     with no syntax tree to consult), after the caret's line.
 * A placement at the edge of a line that would cut an emphasis or a link
 * running on across the line break moves to the end of the paragraph.
 *
 * WHAT IS SELECTED AFTERWARDS: `select` names the part of the block the
 * writer fills in next (the part's name, the diagram's first edge), and it
 * comes out selected so typing replaces it. Without one the caret goes on an
 * empty line of its own a blank line under the block, with a blank line
 * before whatever follows — so typing starts a new paragraph rather than
 * joining the image's, and a second block insert lands a blank line further
 * on. A blank line already below is used rather than another stacked on it.
 */
function insertBlock(view: EditorView, block: string, select?: string): void {
  const { state } = view;
  const pos = state.selection.main.from;
  const tree = ensureSyntaxTree(state, pos, 50);
  const blank = (n: number) => n < 1 || n > state.doc.lines || BLANK_LINE.test(state.doc.line(n).text);
  const line = state.doc.lineAt(pos);
  const atLineStart = BLANK_LINE.test(state.sliceDoc(line.from, pos));
  const sealed = tree ? sealedAt(tree, pos) : null;

  /* `lead` leaves what comes before; `gap` is the break owed to what follows,
     only when it has text and is not already a blank line away. */
  const afterLine = (after: Line): Placement => ({
    from: after.to,
    to: after.to,
    lead: '\n\n',
    gap: blank(after.number + 1) ? '' : '\n',
  });
  const inFront = (before: Line): Placement => ({
    from: before.from,
    to: before.from,
    lead: blank(before.number - 1) ? '' : '\n',
    gap: '\n\n',
  });
  let at: Placement;
  if (sealed && !(atLineStart && line.from === sealed.from)) {
    at = sealed.open ? inFront(state.doc.lineAt(sealed.from)) : afterLine(state.doc.lineAt(sealed.to));
  } else if (BLANK_LINE.test(line.text)) {
    at = {
      from: line.from,
      to: line.to,
      lead: blank(line.number - 1) ? '' : '\n',
      gap: blank(line.number + 1) ? '' : '\n',
    };
  } else if (atLineStart) {
    at = inFront(line);
  } else if (tree && pos < line.to && splitsAt(tree, state, pos)) {
    at = {
      from: pos - (/[ \t]*$/.exec(state.sliceDoc(line.from, pos))?.[0].length ?? 0),
      to: pos + (/^[ \t]*/.exec(state.sliceDoc(pos, line.to))?.[0].length ?? 0),
      lead: '\n\n',
      gap: '\n\n',
    };
  } else {
    at = afterLine(line);
  }
  if (tree && !sealed && at.from === at.to && cutsInline(tree, at.from)) {
    const paragraph = paragraphAt(tree, pos);
    if (paragraph) at = afterLine(state.doc.lineAt(paragraph.to));
  }

  const blockAt = at.from + at.lead.length;
  const pick = select === undefined ? -1 : block.indexOf(select);
  view.dispatch({
    changes: { from: at.from, to: at.to, insert: `${at.lead}${block}${pick >= 0 ? '' : '\n\n'}${at.gap}` },
    selection:
      select !== undefined && pick >= 0
        ? { anchor: blockAt + pick, head: blockAt + pick + select.length }
        : { anchor: blockAt + block.length + 2 },
    scrollIntoView: true,
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
    scrollIntoView: true,
  });
  view.focus();
}

export function insertBold(view: EditorView): void {
  wrapSelection(view, '**', '**', 'bold text');
}

export function insertItalic(view: EditorView): void {
  wrapSelection(view, '*', '*', 'italic text');
}

/** A selection that is already an address rather than words. */
const URL_TEXT = /^(?:https?:\/\/|mailto:)\S+$/i;

/**
 * Wrap the selection as a link, and select whatever is still missing.
 *
 * Words selected: they are the link's text, so the destination is what the
 * writer supplies next, and it comes out selected — pasting the address used
 * to overwrite the words instead. An address selected: it is the destination,
 * so the text is what is missing. Nothing selected: both are, and the text
 * comes first.
 */
export function insertLink(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const isUrl = URL_TEXT.test(selected);
  const text = selected && !isUrl ? selected : 'link text';
  const url = isUrl ? selected : 'https://';
  const [anchor, length] =
    selected && !isUrl
      ? [range.from + text.length + 3, url.length]
      : [range.from + 1, text.length];
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[${text}](${url})` },
    selection: { anchor, head: anchor + length },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertCue(view: EditorView): void {
  wrapSelection(view, '[Cue: ', ']', 'stage direction', { spaced: true });
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

/**
 * Insert Markdown that is already written, one block per entry.
 *
 * For dropped images (§20.2): Rust imports each file and hands back the finished
 * `![alt](assets/…)` string, so there is nothing left to compose — and composing
 * it again here would mean two places that know how an asset reference is
 * spelled. Goes through the same `insertBlock` every toolbar insertion uses, so
 * the blank-line handling and the resulting selection are identical.
 */
export function insertMarkdownBlocks(view: EditorView, blocks: readonly string[]): void {
  if (blocks.length === 0) return;
  insertBlock(view, blocks.join('\n\n'));
}

/** The starter edge comes out selected: it is the example to write over. */
export function insertDiagram(view: EditorView): void {
  insertBlock(view, '```mermaid\nflowchart LR\n  A --> B\n```', 'A --> B');
}

/**
 * A part break: the `[Take: …]` marker, which starts a PART (§parts).
 *
 * The placeholder names the thing that follows the marker rather than the
 * marker itself. `[Take: name this take]` read as an instruction to describe
 * the act of recording; what the author is actually being asked for is the name
 * of the segment that starts here, because that name is what appears in the
 * launch menu, in the Live status bar and on the take summary. It comes out
 * selected, because naming the part is the very next thing to do.
 */
export function insertTakeMarker(view: EditorView): void {
  insertBlock(view, '[Take: name this part]', 'name this part');
}
