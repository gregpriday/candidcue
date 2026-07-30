/**
 * The insert toolbar's heading control (spec §13.6).
 *
 * It could only ever produce an H1: on a line that already began with `#` the
 * old `insertHeading` focused the editor and returned, so the button did
 * nothing and explained nothing. Every level below the top had to be typed by
 * hand.
 *
 * Driven through a real `EditorState` with a minimal view — CodeMirror's
 * `EditorView` needs a DOM, and none of what is asserted here is about one.
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { cycleHeading } from '../../../src/control/lib/markdown-insert';

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
});
