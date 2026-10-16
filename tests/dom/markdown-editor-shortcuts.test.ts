/**
 * MarkdownEditor.svelte — Bold and Italic on the keys writers already use, and
 * ⌘↩ left to Present.
 *
 * These two had no keyboard path at all: the toolbar buttons were the only way
 * to wrap a selection, in a Markdown editor (issue #128).
 *
 * The test that matters is the ITALIC one, and it has to go through a real
 * keydown to be worth anything. `Mod-i` is not a free chord — CodeMirror's own
 * `defaultKeymap` binds it to `selectParentSyntax`. The fix is array order
 * inside a single `keymap.of`, which is exactly the kind of thing that is
 * correct in the source and wrong in the built extension. Asserting that
 * `insertItalic` works would prove nothing about that; asserting that pressing
 * the key changes the DOCUMENT proves the binding won.
 *
 * ⌘↩ is the same shape the other way round (issue #268): `defaultKeymap` binds
 * `Mod-Enter` to `insertBlankLine`, and the window shortcut layer reads the same
 * key as Present. The editor has to claim the chord, change nothing, and still
 * let the event reach the window.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchQuery, setSearchQuery } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import MarkdownEditor from '../../src/control/components/MarkdownEditor.svelte';
import {
  installShortcuts,
  isMacPlatform,
  onShortcut,
  type ShortcutAction,
} from '../../src/control/lib/shortcuts';
import { setInitialRoute } from '../../src/control/stores/router';

/** Mount the editor over `doc`, recording every change it reports upward. */
function mount(doc: string) {
  const changes: string[] = [];
  const result = render(MarkdownEditor, {
    props: { value: doc, onchange: (value: string) => changes.push(value) },
  });
  const editor = result.component as unknown as {
    getView: () => EditorView | null;
    openFind: () => void;
  };
  const view = editor.getView();
  if (!view) throw new Error('the editor never built a view');
  return { view, editor, changes };
}

/** Mount the editor over `doc` with `select` selected, and return its view. */
function editorWith(doc: string, select: string) {
  const { view } = mount(doc);
  const from = doc.indexOf(select);
  view.dispatch({ selection: { anchor: from, head: from + select.length } });
  return view;
}

/**
 * Press a key at `target`, with the primary modifier unless told otherwise.
 *
 * CodeMirror binds its keymap to the contenteditable element rather than the
 * window, so the event has to be dispatched there — a window-level dispatch
 * would test nothing but the absence of a global handler. Enter carries the
 * legacy `keyCode` as well, because the search panel's own handler reads that
 * and nothing else.
 */
function press(
  target: EventTarget,
  key: string,
  { primary = true, repeat = false } = {},
): KeyboardEvent {
  const mac = isMacPlatform();
  const enter = key === 'Enter';
  const event = new KeyboardEvent('keydown', {
    key,
    code: enter ? 'Enter' : `Key${key.toUpperCase()}`,
    keyCode: enter ? 13 : 0,
    metaKey: primary && mac,
    ctrlKey: primary && !mac,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function pressPrimary(view: EditorView, key: string): boolean {
  return press(view.contentDOM, key).defaultPrevented;
}

describe('the markdown editor answers the formatting keys', () => {
  it('wraps the selection in bold on the primary modifier + B', () => {
    const view = editorWith('the quick brown fox', 'quick');
    const prevented = pressPrimary(view, 'b');
    expect(view.state.doc.toString()).toBe('the **quick** brown fox');
    expect(prevented).toBe(true);
  });

  /*
   * The one that proves the override. If these bindings had been appended after
   * `...defaultKeymap` instead of placed before it, `selectParentSyntax` would
   * answer this key first, return true, and the document would be untouched —
   * the selection would simply have grown.
   */
  it('wraps the selection in italic on the primary modifier + I, beating selectParentSyntax', () => {
    const view = editorWith('the quick brown fox', 'quick');
    const prevented = pressPrimary(view, 'i');
    expect(view.state.doc.toString()).toBe('the *quick* brown fox');
    expect(prevented).toBe(true);
  });

  it('inserts a placeholder when nothing is selected, as the toolbar buttons do', () => {
    const view = editorWith('', '');
    pressPrimary(view, 'b');
    expect(view.state.doc.toString()).toContain('bold text');
  });
});

describe('the markdown editor leaves the primary modifier + Enter to Present', () => {
  // The issue's own script: a paragraph written across two source lines.
  const script = '# Launch keynote\n\nWelcome everyone\nto the show.\n';

  let bubbled: Event[] = [];
  const recordBubble = (event: Event) => bubbled.push(event);
  beforeEach(() => {
    bubbled = [];
    window.addEventListener('keydown', recordBubble);
  });
  afterEach(() => window.removeEventListener('keydown', recordBubble));

  /*
   * The report, exactly. `insertBlankLine` put an empty line under "Welcome
   * everyone" — a paragraph break in Markdown — and the autosave that followed
   * is what `changes` stands in for. Pressed more than once because each press
   * used to add another, and then held, because a held key arrives as repeats.
   */
  it('does not split the paragraph under the caret, however often it is pressed', () => {
    const { view, changes } = mount(script);
    const caret = script.indexOf('everyone');
    view.dispatch({ selection: { anchor: caret } });

    const events = [false, true, true].map((repeat) =>
      press(view.contentDOM, 'Enter', { repeat }),
    );

    expect(view.state.doc.toString()).toBe(script);
    expect(view.state.selection.main.head).toBe(caret);
    expect(changes).toEqual([]);
    expect(events.every((event) => event.defaultPrevented)).toBe(true);
    // Not stopped: the window listener is what starts the take.
    expect(bubbled).toEqual(events);
  });

  it('adds no blank line with the caret at the end of the script', () => {
    const { view, changes } = mount(script);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    const event = press(view.contentDOM, 'Enter');

    expect(view.state.doc.toString()).toBe(script);
    expect(changes).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).toEqual([event]);
  });

  /*
   * The search panel's handler runs `replaceNext` on any Enter in the Replace
   * field, modifiers or not, and the caret sits on a match here — so without
   * the `search-panel` scope this press would rewrite "Welcome" and then
   * present.
   */
  it('does not replace a match when pressed in the Replace field', () => {
    const { view, editor, changes } = mount(script);
    editor.openFind();
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: 'Welcome', replace: 'Hello' })),
    });
    const from = script.indexOf('Welcome');
    view.dispatch({ selection: { anchor: from, head: from + 'Welcome'.length } });
    const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
    if (!field) throw new Error('the search panel has no replace field');

    const event = press(field, 'Enter');

    expect(view.state.doc.toString()).toBe(script);
    expect(changes).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).toEqual([event]);
  });

  it('does not jump to the next match when pressed in the Find field', () => {
    const { view, editor } = mount(script);
    editor.openFind();
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'show' })) });
    view.dispatch({ selection: { anchor: 0 } });
    const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="search"]');
    if (!field) throw new Error('the search panel has no search field');

    const event = press(field, 'Enter');

    expect(view.state.selection.main.head).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).toEqual([event]);
    // The control: plain Enter in the same field still finds the match.
    press(field, 'Enter', { primary: false });
    expect(view.state.selection.main.from).toBe(script.indexOf('show'));
  });

  it('still breaks the line on a plain Enter', () => {
    const { view, changes } = mount(script);
    view.dispatch({ selection: { anchor: script.indexOf('to the show') } });

    press(view.contentDOM, 'Enter', { primary: false });

    expect(view.state.doc.toString()).toBe(script.replace('\nto the show', '\n\nto the show'));
    expect(changes).toHaveLength(1);
  });

  /*
   * The other half of the contract, through the real shortcut layer rather than
   * a bare listener: an event CodeMirror has already prevented still resolves to
   * Present on the editor route, once. The window listener deliberately ignores
   * `defaultPrevented`, and this is the case that depends on it.
   */
  it('reaches the shortcut layer as exactly one Present', () => {
    const { view } = mount(script);
    view.dispatch({ selection: { anchor: script.indexOf('everyone') } });
    const actions: ShortcutAction[] = [];
    setInitialRoute({ name: 'editor', scriptId: 'script-1' });
    const uninstall = installShortcuts();
    const unsubscribe = onShortcut((action) => actions.push(action));
    try {
      press(view.contentDOM, 'Enter');
    } finally {
      unsubscribe();
      uninstall();
      setInitialRoute({ name: 'library', view: 'all' });
    }

    expect(actions).toEqual(['present']);
    expect(view.state.doc.toString()).toBe(script);
  });
});
