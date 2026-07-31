/**
 * MarkdownEditor.svelte — Bold and Italic on the keys writers already use.
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
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MarkdownEditor from '../../src/control/components/MarkdownEditor.svelte';
import { isMacPlatform } from '../../src/control/lib/shortcuts';

/** Mount the editor over `doc` with `select` selected, and return its view. */
function editorWith(doc: string, select: string) {
  const result = render(MarkdownEditor, { props: { value: doc } });
  const component = result.component as unknown as {
    getView: () => import('@codemirror/view').EditorView | null;
  };
  const view = component.getView();
  if (!view) throw new Error('the editor never built a view');
  const from = doc.indexOf(select);
  view.dispatch({ selection: { anchor: from, head: from + select.length } });
  return view;
}

/**
 * Press a primary-modifier key at the editing surface.
 *
 * CodeMirror binds its keymap to the contenteditable element rather than the
 * window, so the event has to be dispatched there — a window-level dispatch
 * would test nothing but the absence of a global handler.
 */
function pressPrimary(view: import('@codemirror/view').EditorView, key: string): boolean {
  const mac = isMacPlatform();
  const event = new KeyboardEvent('keydown', {
    key,
    code: `Key${key.toUpperCase()}`,
    metaKey: mac,
    ctrlKey: !mac,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
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
