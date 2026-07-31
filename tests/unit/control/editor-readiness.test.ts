/**
 * When the editor is allowed to come out from behind the loading panel.
 *
 * The panel exists so the editor arrives in one piece (issue #140), and the
 * rule that decides it has two edges that are easy to get wrong in opposite
 * directions. Uncover too early and the header gains its metadata line a moment
 * later, grows, and shoves the insert toolbar down — the exact jump the panel
 * was added to remove. Uncover too late — or re-cover — and a working editor
 * gets torn down mid-session, which costs the CodeMirror instance and the undo
 * history with it.
 *
 * So these assert the whole truth table, and in particular the two rows that
 * are not obvious: a compile that FAILED still hands the editor over, and a
 * compile that starts again while typing does NOT take it back.
 */
import { describe, expect, it } from 'vitest';
import {
  isCompileSettledForScript,
  isEditorOpening,
  type CompileOpenSnapshot,
  type EditorOpenSnapshot,
} from '../../../src/control/lib/editor-readiness';

const A = 'script-a';
const B = 'script-b';

function ed(over: Partial<EditorOpenSnapshot> = {}): EditorOpenSnapshot {
  return { scriptId: A, loading: false, ...over };
}

function comp(over: Partial<CompileOpenSnapshot> = {}): CompileOpenSnapshot {
  return { scriptId: A, status: 'ready', ...over };
}

/** The steady state: open started, document in hand, first compile landed. */
function open(over: Partial<{ openStarted: boolean; firstCompileSettled: boolean }> = {}) {
  return { openStarted: true, firstCompileSettled: true, ...over };
}

describe('is the first compile settled for this script', () => {
  it('settles on a compile that succeeded', () => {
    expect(isCompileSettledForScript(A, ed(), comp({ status: 'ready' }))).toBe(true);
  });

  it('settles on a compile that FAILED', () => {
    // A script that cannot be rendered is still one the author has to be able
    // to see and fix. Leaving the panel up would hide the text from the only
    // person who can repair it.
    expect(isCompileSettledForScript(A, ed(), comp({ status: 'error' }))).toBe(true);
  });

  it('does not settle while the compile is still running', () => {
    expect(isCompileSettledForScript(A, ed(), comp({ status: 'compiling' }))).toBe(false);
  });

  it('does not settle on an idle compile store', () => {
    // `openScript` resets the compile store before it fetches, so `idle` is the
    // state between the reset and the request — not a finished compile.
    expect(isCompileSettledForScript(A, ed(), comp({ status: 'idle', scriptId: null }))).toBe(false);
  });

  it('does not settle while the document is still loading', () => {
    expect(isCompileSettledForScript(A, ed({ loading: true }), comp())).toBe(false);
  });

  it('ignores a settled compile belonging to a different script', () => {
    expect(isCompileSettledForScript(A, ed(), comp({ scriptId: B }))).toBe(false);
    expect(isCompileSettledForScript(A, ed(), comp({ scriptId: B, status: 'error' }))).toBe(false);
  });

  it('ignores an editor store still holding a different script', () => {
    expect(isCompileSettledForScript(A, ed({ scriptId: B }), comp())).toBe(false);
  });
});

describe('is the editor still opening', () => {
  it('covers the editor before this component has started its own open', () => {
    // Nothing resets the stores when the editor unmounts, so leaving a script
    // and coming straight back finds both stores settled on that same id. The
    // first render must not show the previous visit's document.
    expect(isEditorOpening(A, ed(), open({ openStarted: false }))).toBe(true);
  });

  it('covers the editor while the store still holds the previous script', () => {
    expect(isEditorOpening(A, ed({ scriptId: B }), open())).toBe(true);
  });

  it('covers the editor while the document is loading', () => {
    expect(isEditorOpening(A, ed({ loading: true }), open())).toBe(true);
  });

  it('covers the editor until the first compile has settled', () => {
    expect(isEditorOpening(A, ed(), open({ firstCompileSettled: false }))).toBe(true);
  });

  it('uncovers once the document and its first compile are both in hand', () => {
    expect(isEditorOpening(A, ed(), open())).toBe(false);
  });

  it('stays uncovered when a later compile starts, because the latch is not a live reading', () => {
    /*
     * The row this whole shape exists for. Typing re-runs the compile, which
     * returns the compile store to `compiling`; reading that status live would
     * raise the panel over a working editor on a keystroke and destroy
     * CodeMirror. `firstCompileSettled` is set once per open and only an open
     * clears it, so a mid-session compile cannot reach back through it.
     */
    const settledOnce = open();
    expect(isCompileSettledForScript(A, ed(), comp({ status: 'compiling' }))).toBe(false);
    expect(isEditorOpening(A, ed(), settledOnce)).toBe(false);
  });
});
