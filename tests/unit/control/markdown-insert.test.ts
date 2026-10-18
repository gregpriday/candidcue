/**
 * The insert toolbar (spec §13.6).
 *
 * The heading control could only ever produce an H1: on a line that already
 * began with `#` the old `insertHeading` focused the editor and returned, so
 * the button did nothing and explained nothing. Every level below the top had
 * to be typed by hand.
 *
 * The block inserts — image, dropped images, diagram, part break — glued their
 * block onto the paragraph above when the caret sat on the blank line under
 * it, and Markdown then read the image or marker as part of that paragraph.
 *
 * Driven through a real `EditorState` with a minimal view — CodeMirror's
 * `EditorView` needs a DOM, and none of what is asserted here is about one.
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  cycleHeading,
  insertDiagram,
  insertImage,
  insertMarkdownBlocks,
  insertTakeMarker,
} from '../../../src/control/lib/markdown-insert';
import { compile } from '../../../src/shared/markdown/compile';

/**
 * Enough of an `EditorView` for the insert helpers: they read `state` and call
 * `dispatch` and `focus`, and nothing else.
 */
function fakeView(doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({ doc, selection: { anchor, head } });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorView['dispatch']>[0]) {
      state = state.update(spec as never).state;
    },
    focus() {},
  };
  return {
    view: view as unknown as EditorView,
    text: () => state.doc.toString(),
    selection: () => state.selection.main,
  };
}

describe('cycleHeading', () => {
  it('makes a plain line an H1', () => {
    const { view, text } = fakeView('Opening line', 3);
    cycleHeading(view);
    expect(text()).toBe('# Opening line');
  });

  it('walks every level instead of stopping at H1', () => {
    const { view, text } = fakeView('Opening line', 3);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      cycleHeading(view);
      seen.push(text());
    }
    expect(seen).toEqual([
      '# Opening line',
      '## Opening line',
      '### Opening line',
      '#### Opening line',
      '##### Opening line',
      '###### Opening line',
    ]);
  });

  /* The old behaviour's actual bug: a heading line was a dead end. */
  it('returns an H6 to a plain line rather than doing nothing', () => {
    const { view, text } = fakeView('###### Deep heading', 10);
    cycleHeading(view);
    expect(text()).toBe('Deep heading');
  });

  it('keeps the caret on the same character as the marker grows', () => {
    // Caret immediately before "line".
    const { view, text, selection } = fakeView('Opening line', 8);
    cycleHeading(view);
    expect(text()).toBe('# Opening line');
    expect(text().slice(selection().anchor)).toBe('line');
  });

  it('keeps the caret on the same character as the marker is removed', () => {
    const { view, text, selection } = fakeView('###### Opening line', 15);
    cycleHeading(view);
    expect(text()).toBe('Opening line');
    expect(text().slice(selection().anchor)).toBe('line');
  });

  /* A caret inside the marker has nowhere to land once it is gone, so it goes
     to the start of the text rather than off the front of the line. */
  it('never moves the caret before the start of the line', () => {
    const { view, selection } = fakeView('### Heading', 1);
    cycleHeading(view);
    expect(selection().anchor).toBeGreaterThanOrEqual(0);
  });

  it('leaves the rest of the document alone', () => {
    const { view, text } = fakeView('First\nSecond\nThird', 8);
    cycleHeading(view);
    expect(text()).toBe('First\n# Second\nThird');
  });

  it('does not treat a hash without a space as a heading', () => {
    const { view, text } = fakeView('#hashtag', 3);
    cycleHeading(view);
    expect(text()).toBe('# #hashtag');
  });

  /* A bare run of hashes is a valid EMPTY ATX heading in CommonMark, so it has
     to wrap to plain like any other H6 rather than gain another hash. */
  it('wraps a bare ###### to plain instead of adding a hash', () => {
    const { view, text } = fakeView('######', 6);
    cycleHeading(view);
    expect(text()).toBe('');
  });

  it('treats a bare # as an H1 and cycles it onward', () => {
    const { view, text } = fakeView('#', 1);
    cycleHeading(view);
    expect(text()).toBe('## ');
  });

  /* Up to three spaces of indent is still a heading to CommonMark. */
  it('cycles a heading indented by up to three spaces', () => {
    const { view, text } = fakeView('  ## Title', 6);
    cycleHeading(view);
    expect(text()).toBe('  ### Title');
  });

  it('keeps a plain line’s indentation when it becomes a heading', () => {
    const { view, text } = fakeView('   Indented text', 8);
    cycleHeading(view);
    expect(text()).toBe('   # Indented text');
  });

  it('keeps the indentation when a heading returns to plain', () => {
    const { view, text } = fakeView('  ###### Deep', 12);
    cycleHeading(view);
    expect(text()).toBe('  Deep');
  });

  /* Four spaces is an indented code block, not a heading. */
  it('does not read a four-space-indented line as a heading', () => {
    const { view, text } = fakeView('    ## Not a heading', 10);
    cycleHeading(view);
    expect(text()).toBe('    # ## Not a heading');
  });

  it('accepts a tab after the hashes', () => {
    const { view, text } = fakeView('##\tTabbed', 5);
    cycleHeading(view);
    expect(text()).toBe('### Tabbed');
  });

  it('turns an empty line into an empty heading', () => {
    const { view, text } = fakeView('', 0);
    cycleHeading(view);
    expect(text()).toBe('# ');
  });

  /* Documented behaviour rather than an accident: the control acts on the line
     the caret is on, and a selection spanning several lines changes only that
     one. The far end of the selection still has to survive intact. */
  it('acts on the caret’s line only and keeps the far end of a selection', () => {
    const { view, text, selection } = fakeView('First\nSecond\nThird', 2, 14);
    cycleHeading(view);
    expect(text()).toBe('# First\nSecond\nThird');
    expect(text().slice(selection().head)).toBe('hird');
  });
});

/**
 * A document with its caret drawn in as `|`, so a case reads as a picture of
 * the editor rather than as offset arithmetic.
 */
function caretView(marked: string) {
  const caret = marked.indexOf('|');
  return fakeView(marked.slice(0, caret) + marked.slice(caret + 1), caret);
}

/** The document and its (collapsed) caret, drawn back in as `|`. */
function drawn(text: string, caret: { anchor: number; head: number }): string {
  expect(caret.head).toBe(caret.anchor);
  return text.slice(0, caret.anchor) + '|' + text.slice(caret.anchor);
}

/** What the compiler makes of a document, block by block. */
function blockKinds(source: string): string[] {
  return compile(source, { scriptId: 'test-script' }).blocks.map((block) => block.kind);
}

const IMAGE = '![a](assets/x.png)';

describe('block inserts', () => {
  /* Every row asserts the compiled shape as well as the text: the bug was
     invisible as a string unless you knew the Markdown rule, and plain on the
     glass, where the image became part of the paragraph above it. */
  it.each([
    // The reported case: the blank line between two paragraphs.
    ['P\n|\nQ', `P\n\n${IMAGE}\n\n|\n\nQ`, ['paragraph', 'image', 'paragraph']],
    ['P\n \t|\nQ', `P\n\n${IMAGE}\n\n|\n\nQ`, ['paragraph', 'image', 'paragraph']],
    ['P\n| \t\nQ', `P\n\n${IMAGE}\n\n|\n\nQ`, ['paragraph', 'image', 'paragraph']],
    // Four spaces left in front of the block would make it indented code.
    ['P\n    |\nQ', `P\n\n${IMAGE}\n\n|\n\nQ`, ['paragraph', 'image', 'paragraph']],
    // Already a blank line away from the paragraph: no second one.
    ['P\n\n|\nQ', `P\n\n${IMAGE}\n\n|\n\nQ`, ['paragraph', 'image', 'paragraph']],
    ['P\n \t\n|\nQ', `P\n \t\n${IMAGE}\n\n|\n\nQ`, ['paragraph', 'image', 'paragraph']],
    ['P\n|\n\nQ', `P\n\n${IMAGE}\n\n|\n\nQ`, ['paragraph', 'image', 'paragraph']],
    // Document edges.
    ['|\nQ', `${IMAGE}\n\n|\n\nQ`, ['image', 'paragraph']],
    ['|', `${IMAGE}\n\n|`, ['image']],
    ['P\n|', `P\n\n${IMAGE}\n\n|`, ['paragraph', 'image']],
    // A caret line with text keeps its behaviour: the block goes after it.
    // (With no syntax tree to consult, as here, it never splits a line.)
    ['P|Q\nR', `PQ\n\n${IMAGE}\n\n|\n\nR`, ['paragraph', 'image', 'paragraph']],
    ['P|', `P\n\n${IMAGE}\n\n|`, ['paragraph', 'image']],
    // A no-break space is text to Markdown, so the line is not blank.
    ['P\n |\nQ', `P\n \n\n${IMAGE}\n\n|\n\nQ`, ['paragraph', 'image', 'paragraph']],
  ])('inserts an image into %j as a block of its own', (before, after, kinds) => {
    const { view, text, selection } = caretView(before);
    insertImage(view, 'assets/x.png', 'a');
    expect(drawn(text(), selection())).toBe(after);
    expect(blockKinds(text())).toEqual(kinds);
  });

  /* A block insert has never replaced a selection: it goes in at the
     selection's start, and the blank line it takes over must be the only text
     that leaves the document. */
  it('keeps the selected text when a selection starts on the blank line', () => {
    const { view, text, selection } = fakeView('P\n \t\nQ', 2, 6);
    insertImage(view, 'assets/x.png', 'a');
    expect(drawn(text(), selection())).toBe(`P\n\n${IMAGE}\n\n|\n\nQ`);
    expect(blockKinds(text())).toEqual(['paragraph', 'image', 'paragraph']);
  });

  /* The part's name comes out selected: naming it is the next thing to do. */
  it('makes a part break between two paragraphs a cue of its own', () => {
    const { view, text, selection } = caretView('P\n|\nQ');
    insertTakeMarker(view);
    expect(text()).toBe('P\n\n[Take: name this part]\n\nQ');
    expect(text().slice(selection().from, selection().to)).toBe('name this part');
    expect(blockKinds(text())).toEqual(['paragraph', 'cue', 'paragraph']);
  });

  it('keeps several dropped images apart from the paragraph and each other', () => {
    const { view, text, selection } = caretView('P\n|\nQ');
    insertMarkdownBlocks(view, [IMAGE, '![b](assets/y.png)']);
    expect(drawn(text(), selection())).toBe(`P\n\n${IMAGE}\n\n![b](assets/y.png)\n\n|\n\nQ`);
    expect(blockKinds(text())).toEqual(['paragraph', 'image', 'image', 'paragraph']);
  });

  it('leaves the document alone when nothing was dropped', () => {
    const { view, text, selection } = caretView('P\n|\nQ');
    insertMarkdownBlocks(view, []);
    expect(drawn(text(), selection())).toBe('P\n|\nQ');
  });

  /* A fence interrupts a paragraph anyway; it takes the same spacing all the
     same, so every insert leaves the source looking alike. */
  it('spaces a diagram like every other block', () => {
    const { view, text, selection } = caretView('P\n|\nQ');
    insertDiagram(view);
    expect(text()).toBe('P\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nQ');
    expect(text().slice(selection().from, selection().to)).toBe('A --> B');
    expect(blockKinds(text())).toEqual(['paragraph', 'diagram', 'paragraph']);
  });

  /* The caret ends on an empty line a blank line under the block it just
     wrote, so typing starts a paragraph of its own and a second insert in a
     row starts in exactly the reported position. */
  it('keeps consecutive inserts at the end of a document apart', () => {
    const { view, text } = caretView('P|');
    insertImage(view, 'assets/x.png', 'a');
    insertTakeMarker(view);
    expect(text()).toBe(`P\n\n${IMAGE}\n\n[Take: name this part]`);
    expect(blockKinds(text())).toEqual(['paragraph', 'image', 'cue']);
  });
});
