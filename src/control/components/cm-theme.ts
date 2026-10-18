/**
 * CodeMirror theme built from the design tokens so the editing surface tracks
 * the surrounding shell. Values reference CSS custom properties directly.
 * Editor focus is a quiet surface — no accent outline ever (owner rule).
 *
 * The colours follow one rule a writer can learn in a minute: dark text is
 * what you will say, grey text is what you will not — Markdown punctuation,
 * the bodies of `:::silent` and `:::stage` blocks, code, tables, images, a
 * pronunciation's braces — and amber is an instruction to you. Headings are
 * the exception: they are structure, so they stay dark.
 */
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import {
  Prec,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text,
} from '@codemirror/state';
import {
  ContainerIndex,
  INLINE_SAY_PATTERN,
  type ContainerRegion,
  classifyBracketDirective,
  containerAt,
  resolveContainerSemantics,
  scanContainers,
} from '../../shared/markdown/directives';

const themeSpec = {
  '&': {
    color: 'var(--prose-text-warm, var(--text-primary))',
    backgroundColor: 'transparent',
    /*
     * Sized from the PANE, so View › Larger Editor Text works.
     *
     * It was a hard 15px, which meant the document-scale control had nothing to
     * act on: the pane's font-size changed and CodeMirror ignored it. `1em`
     * inherits the pane's computed size — 15px at scale 1, because
     * `--text-base` is 15px — so the default is unchanged and the control has a
     * lever.
     */
    fontSize: '1em',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    fontFamily: 'var(--font-prose)',
    // Unitless, so it tracks the font size rather than crushing scaled text.
    lineHeight: '1.73',
    letterSpacing: 'var(--ls-prose, 0.01em)',
    /*
     * The column is centred, and measured for prose.
     *
     * It sat against the pane's left edge, so a wide window put the script
     * beside the sidebar and left most of the white empty on the right. A
     * flex item's auto margins take the space left over once the width has
     * hit its cap, so this centres in a wide pane and changes nothing in a
     * narrow one, where the line insets below are the margin.
     */
    width: '100%',
    maxWidth: 'var(--editor-measure, 62ch)',
    marginInline: 'auto',
    /*
     * Room under the last line, in `em` so it grows with the text. Without it
     * the end of a script sat on the bottom edge of the window, and everything
     * typed there was typed at the bottom of the screen. `scrollMargins` below
     * is what keeps the caret off that edge; this is what gives it somewhere to
     * scroll to.
     */
    padding: 'var(--space-6) 0 8em',
  },
  '.cm-line': {
    padding: '0 var(--page-x)',
  },
  /*
   * The drawn cursor (`drawSelection`), at the weight the native caret had.
   * CodeMirror's own is a 1.2px black hairline. `&.cm-editor` because the base
   * theme's cursor rules are as specific as a plain theme rule, and source
   * order between the two is not something to lean on.
   */
  '&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor': {
    borderLeft: '2px solid var(--accent)',
    marginLeft: '-1px',
  },
  /*
   * Selection, drawn rather than native, in two states.
   *
   * WebKit's native selection painted only the glyph runs: a selection across
   * paragraphs broke into islands at every blank line, and it looked exactly
   * the same after focus had gone to the toolbar. Drawn, it is one block that
   * runs to the line end and covers the blank lines inside it, and an editor
   * that no longer has the keyboard says so with a neutral tint. The base
   * theme's selectors are `&light`-scoped, one class more specific than a
   * plain theme rule — hence `&.cm-editor` on the inactive one.
   */
  '&.cm-editor .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection-inactive)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection)',
  },
  /*
   * What is shown but never said: the bodies of `:::silent` and `:::stage`
   * blocks, the `visual:` line of a `:::spoken` block, code, tables, images.
   * Grey, as the preview and the glass both dim it — and grey all the way down,
   * so a bold word inside a stage block does not come back up to spoken weight.
   */
  '.cm-unspoken, .cm-unspoken *': { color: 'var(--text-secondary)' },
  // A block's fence lines read as its label, not as a line of the script.
  '.cm-fence': { color: 'var(--text-faint)', fontWeight: '600' },
  /*
   * `{say="…"}`: the braces, `say=` and quotes are annotation, so markup grey;
   * the value is what will actually be said, so it is prose-dark and upright.
   * (Italic set the spelled-out capital I in "A P I" as a slash.)
   */
  '.cm-say': { color: 'var(--text-faint)' },
  '.cm-say-value': { color: 'var(--prose-text-warm, var(--text-primary))' },
  /*
   * A `:::spoken` block is plain text to the compiler, so Markdown inside it
   * is not formatting and must not look like it.
   */
  '.cm-plain *': {
    color: 'inherit',
    fontWeight: 'inherit',
    fontStyle: 'inherit',
    textDecoration: 'none',
  },
  '.cm-field-label': { color: 'var(--text-faint)' },
  // A cue's brackets: punctuation, like every other piece of Markdown syntax.
  '.cm-directive-bracket': { color: 'var(--text-faint)', fontWeight: '400' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--prose-muted-warm, var(--text-muted))',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--prose-muted-warm, var(--text-muted))' },
  '.cm-scroller': { fontFamily: 'var(--font-prose)', overflow: 'auto' },
  // A cue or part break: the preview's amber chip, as text. Not a link.
  '.cm-directive': { color: 'var(--warning)', fontWeight: '600' },
} as const;

const workspaceBase = EditorView.theme({ ...themeSpec }, { dark: false });

const highlight = HighlightStyle.define([
  {
    tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4],
    color: 'var(--text-primary)',
    fontWeight: '650',
  },
  { tag: t.strong, color: 'var(--text-primary)', fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  /*
   * The URL, not the link text. Lezer reads any bracketed span as a Link —
   * `[Cue: look at the lens]` included — so styling `t.link` dressed every cue
   * and part break as an underlined hyperlink. A real link is recognisable by
   * its `(url)`; the directives get their own mark below.
   */
  { tag: t.url, color: 'var(--accent-strong)', textDecoration: 'underline' },
  // Code is shown, not said (`readInlineCode` is off by default): grey.
  { tag: t.monospace, color: 'var(--text-secondary)' },
  /*
   * No colour for `t.list`, and none for `t.quote`. Lezer tags every node
   * INSIDE a list or a quote with them, not just the marker, so a colour here
   * greyed out whole bullets the presenter will say aloud — and, being the
   * inner span, it repainted any cue or URL nested in them. The `-` and `>`
   * are list and quote marks, and those already carry the punctuation style.
   */
  { tag: t.quote, fontStyle: 'italic' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  /*
   * Markdown punctuation stays visible but restrained (spec §13.2). Reset to
   * regular, upright and undecorated: the marks inherit the style of what they
   * wrap, so `**` came out bold, `*` italic and `~~` struck through, and the
   * punctuation weighed as much as the words it was marking.
   */
  {
    tag: [t.processingInstruction, t.meta],
    color: 'var(--text-faint)',
    fontWeight: '400',
    fontStyle: 'normal',
    textDecoration: 'none',
  },
  { tag: [t.squareBracket, t.bracket], color: 'var(--text-muted)' },
]);

/**
 * The script's `:::` blocks, from the compiler's own scanner — so a fence
 * inside a code block, an unknown block name and an unclosed block are read
 * exactly as the compiler reads them. Rescanned on every edit: one pass over
 * the text, the same pass the compile worker makes on every keystroke.
 */
const containerField = StateField.define<readonly ContainerRegion[]>({
  create: (state) => scanRegions(state.doc),
  update: (regions, tr) => (tr.docChanged ? scanRegions(tr.state.doc) : regions),
});

function scanRegions(doc: Text): readonly ContainerRegion[] {
  const { regions } = scanContainers(doc.toString());
  new ContainerIndex(regions); // stitches `parent`, so nested blocks compose
  return regions;
}

/**
 * Inside a `:::spoken` block, the compiler reads plain text, not Markdown: a
 * bracket there is part of what is said, not a cue.
 */
function isSpokenBodyAt(state: EditorState, pos: number): boolean {
  return state
    .field(containerField)
    .some((region) => region.kind === 'spoken' && pos >= region.contentStart && pos < region.contentEnd);
}

/** Syntax nodes whose text is literal: nothing inside one is an instruction. */
const LITERAL_NODES = new Set([
  'InlineCode',
  'CodeText',
  'FencedCode',
  'CodeBlock',
  'Comment',
  'CommentBlock',
  'URL',
  'Autolink',
]);

function isLiteralAt(state: EditorState, pos: number): boolean {
  if (isSpokenBodyAt(state, pos)) return true;
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (;;) {
    if (LITERAL_NODES.has(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

/** An odd run of backslashes before `pos` escapes the character there. */
function isEscapedAt(state: EditorState, pos: number): boolean {
  let slashes = 0;
  for (let at = pos - 1; at >= 0 && state.sliceDoc(at, at + 1) === '\\'; at--) slashes++;
  return slashes % 2 === 1;
}

/**
 * Marks the script's own syntax — `[Cue: …]`, `[Beat]`, `[Pause]`,
 * `[Breathe]`, `[Take: …]` — so the source says what the preview and the glass
 * will do with it. Classified by the compiler's own table, so a bracket the
 * compiler does not read as a directive is left as ordinary text, and a
 * bracket followed by `(` is a link and is left to the link styling. An
 * escaped `\[Pause]`, a bracket inside code and one inside a `:::spoken` block
 * are literal text to the compiler, so they are left alone here too.
 *
 * The label is amber and the brackets are punctuation, marked here rather
 * than left to the Markdown parser: Lezer reads most bracketed spans as links,
 * but not all of them, and a cue's brackets should not change colour with it.
 */
const directiveMark = Decoration.mark({ class: 'cm-directive' });
const directiveBracketMark = Decoration.mark({ class: 'cm-directive-bracket' });
const directiveMatcher = new MatchDecorator({
  regexp: /\[([^\]\n]+)\](?!\()/g,
  decorate: (add, from, to, match, view) => {
    if (isEscapedAt(view.state, from) || isLiteralAt(view.state, from)) return;
    const kind = classifyBracketDirective(match[1] ?? '').kind;
    if (kind !== 'cue' && kind !== 'take') return;
    add(from, from + 1, directiveBracketMark);
    add(from + 1, to - 1, directiveMark);
    add(to - 1, to, directiveBracketMark);
  },
});

/** `Word{say="spoken form"}`, by the compiler's own pattern. */
const sayMark = Decoration.mark({ class: 'cm-say' });
const sayValueMark = Decoration.mark({ class: 'cm-say-value' });
const SAY_OPEN = '{say="'.length;
const sayMatcher = new MatchDecorator({
  regexp: new RegExp(INLINE_SAY_PATTERN.source, 'g'),
  decorate: (add, from, to, match, view) => {
    if (isLiteralAt(view.state, from)) return;
    add(from, to, sayMark);
    const value = match[1] ?? '';
    if (value) add(from + SAY_OPEN, from + SAY_OPEN + value.length, sayValueMark);
  },
});

/**
 * A `MatchDecorator` as a plugin. Rebuilt in full whenever the syntax tree
 * moves, not only patched: the literal test reads the tree, and the parse of
 * a long script finishes after the first paint.
 */
function matchPlugin(matcher: MatchDecorator) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view);
      }
      update(update: ViewUpdate) {
        this.decorations =
          syntaxTree(update.state) === syntaxTree(update.startState)
            ? matcher.updateDeco(update, this.decorations)
            : matcher.createDeco(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

const fenceLine = Decoration.line({ class: 'cm-fence' });
const unspokenLine = Decoration.line({ class: 'cm-unspoken' });
const plainLine = Decoration.line({ class: 'cm-plain' });
const plainUnspokenLine = Decoration.line({ class: 'cm-plain cm-unspoken' });
const fieldLabelMark = Decoration.mark({ class: 'cm-field-label' });
const unspokenMark = Decoration.mark({ class: 'cm-unspoken' });

/**
 * Decorations for `:::` blocks. A fence line reads as the block's label.
 * Inside a block, a line is grey when the block (or one around it) is silent
 * or stage and nothing nearer makes it spoken again. A `:::spoken` block is
 * plain text: its lines drop the Markdown colouring, its `visual:` and `say:`
 * labels are quiet, and its `visual:` line is grey because it is shown and
 * not said — the `say:` line is the one that stays dark.
 */
function containerDecorations(state: EditorState): DecorationSet {
  const regions = state.field(containerField);
  if (regions.length === 0) return Decoration.none;
  const doc = state.doc;
  const byLine = new Map<number, Decoration>();
  const marks: Range<Decoration>[] = [];
  for (const region of regions) {
    for (let pos = region.start; pos < region.end; ) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      const inner = containerAt(regions, line.from);
      if (!inner) continue;
      if (line.from === inner.start || (inner.closed && line.from === inner.contentEnd)) {
        byLine.set(line.from, fenceLine);
      } else if (inner.kind === 'spoken') {
        const visual = inner.spoken?.visualRange;
        byLine.set(line.from, visual && within(visual[0], line) ? plainUnspokenLine : plainLine);
      } else {
        const semantics = resolveContainerSemantics(inner);
        if (semantics.silent || semantics.stage) byLine.set(line.from, unspokenLine);
        else byLine.delete(line.from);
      }
    }
    // Each field's label runs from its line's start to where its value begins.
    if (region.kind === 'spoken' && region.spoken && region === containerAt(regions, region.contentStart)) {
      for (const [start] of [region.spoken.visualRange, region.spoken.sayRange]) {
        const line = doc.lineAt(start);
        if (start > line.from) marks.push(fieldLabelMark.range(line.from, start));
      }
    }
  }
  const ranges: Range<Decoration>[] = [...marks];
  for (const [from, deco] of byLine) ranges.push(deco.range(from));
  return Decoration.set(ranges, true);
}

function within(pos: number, line: { from: number; to: number }): boolean {
  return pos >= line.from && pos <= line.to;
}

/**
 * The rest of what is shown and never said, by default: an image, a table, a
 * code block, a diagram. (Inline code too, in the highlight style above.) A
 * script can opt in to reading inline code or image descriptions aloud, but
 * those settings default to off and nothing in the app turns them on.
 */
const UNSPOKEN_BLOCKS = new Set(['FencedCode', 'CodeBlock', 'Table']);

function unspokenNodeDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const lines = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'Image') {
          ranges.push(unspokenMark.range(node.from, node.to));
          return false;
        }
        if (!UNSPOKEN_BLOCKS.has(node.name)) return;
        for (let pos = Math.max(node.from, from); pos <= Math.min(node.to, to); ) {
          const line = view.state.doc.lineAt(pos);
          if (!lines.has(line.from)) ranges.push(unspokenLine.range(line.from));
          lines.add(line.from);
          pos = line.to + 1;
        }
        return false;
      },
    });
  }
  return Decoration.set(ranges, true);
}

const unspokenNodeHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = unspokenNodeDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = unspokenNodeDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * The writing surface: theme, Markdown colouring, the script's own syntax,
 * drawn selection, and how the caret keeps clear of the window's edges.
 *
 * The script marks are `Prec.highest` so they are the INNER span. A higher
 * precedence mark sits inside a lower one, and the inner span's colour is the
 * one that shows. The syntax highlighter is already `Prec.high`, so anything
 * less leaves a cue inside a list item or a link in the list's or the link's
 * colour instead of amber.
 */
export const editorTheme: Extension = [
  workspaceBase,
  syntaxHighlighting(highlight),
  containerField,
  Prec.highest([matchPlugin(directiveMatcher), matchPlugin(sayMatcher)]),
  EditorView.decorations.compute(['doc', containerField], containerDecorations),
  unspokenNodeHighlighter,
  drawSelection(),
  /*
   * Typing keeps a few lines between the caret and the window's edges, so the
   * line being written is never the last thing on screen. In lines, from
   * CodeMirror's own measurement, so it scales with View › Larger Editor Text.
   */
  EditorView.scrollMargins.of((view) => ({
    top: 2 * view.defaultLineHeight,
    bottom: 3 * view.defaultLineHeight,
  })),
];
