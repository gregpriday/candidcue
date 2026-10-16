/**
 * The window's native identity, and the menu-state push discipline.
 *
 * `composeWindowTitle` is pure and is what a user with three windows open reads
 * in the task switcher — §5.2's whole subject. The push functions are tested for
 * the two properties that are about correctness rather than cosmetics: an
 * unchanged state is not re-sent, and two pushes cannot land out of order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting, type InvokeFn } from './ipc';
import {
  PREFERENCES_COMMANDS,
  closeControlWindow,
  composeWindowTitle,
  pushMenuState,
  pushWindowTitle,
  resetMenuStateForTesting,
} from './desktop-shell';
import type { CommandContext } from '../lib/commands';
import { COMMAND_IDS, type CommandId } from '../../shared/contracts/commands';

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    route: { name: 'library', view: 'all' },
    sessionActive: false,
    stageRigResolved: false,
    sessionPaused: false,
    stageBlanked: false,
    stageMirrored: false,
    scriptOpen: false,
    saveState: 'idle',
    editorHasUnsavedWork: false,
    librarySelectionId: null,
    libraryInTrash: false,
    sidebarVisible: true,
    outlineVisible: true,
    diagnosticsVisible: true,
    editorLayout: 'edit',
    takeStarting: false,
    ...overrides,
  };
}

describe('composeWindowTitle', () => {
  it('names the open script, document first', () => {
    // The task switcher truncates from the RIGHT, so the document has to come
    // before the product or a long title leaves "CandidCue" and nothing useful.
    expect(
      composeWindowTitle({
        routeName: 'editor',
        scriptTitle: 'Launch keynote',
        sessionActive: false,
      }),
    ).toBe('Launch keynote — CandidCue');
  });

  it('names the take while one is running', () => {
    // During a take the window IS the stage, and an operator switching to it
    // wants to know which take is live.
    expect(
      composeWindowTitle({ routeName: 'live', scriptTitle: 'Launch keynote', sessionActive: true }),
    ).toBe('Launch keynote — Take in progress');
  });

  it('distinguishes the Library views', () => {
    const at = (libraryView: 'all' | 'recent' | 'trash') =>
      composeWindowTitle({
        routeName: 'library',
        scriptTitle: null,
        libraryView,
        sessionActive: false,
      });
    expect(at('all')).toBe('Library — CandidCue');
    expect(at('recent')).toBe('Recent — CandidCue');
    expect(at('trash')).toBe('Trash — CandidCue');
  });

  it('falls back to the product name with no script open', () => {
    expect(
      composeWindowTitle({ routeName: 'editor', scriptTitle: null, sessionActive: false }),
    ).toBe('CandidCue');
    expect(composeWindowTitle({ routeName: 'nonsense', scriptTitle: null, sessionActive: false })).toBe(
      'CandidCue',
    );
  });

  it('uses the platform-standard Settings title', () => {
    expect(
      composeWindowTitle({ routeName: 'settings', scriptTitle: null, sessionActive: false }),
    ).toBe('CandidCue Settings');
  });
});

/**
 * Both pushes are no-ops outside Tauri, and that is deliberate: `pnpm dev` in a
 * browser has no menu bar, and a service that threw there would make the whole
 * frontend untestable in the environment the Playwright suite runs in.
 *
 * `setInvokeForTesting` does not make `isTauriRuntime()` true, so these tests
 * assert the no-op contract rather than the payload. The payload's SHAPE is
 * covered by `menuStateFor` in `commands.test.ts`.
 *
 * DELIVERY IS NOT COVERED. No test invokes `set_window_title` over IPC, and
 * `set_menu_state` is excluded from the MockRuntime roundtrip suite altogether
 * (it is in `PINNED` in `ipc_roundtrip_tests.rs`, because it writes onto
 * `MenuItem<Wry>` handles that no mock runtime has). Both are exercised only by
 * running the packaged app.
 *
 * Nor is the ROUTING covered here. Which window `menu.rs::command_target`
 * picks needs two real windows and a real menu bar; what is asserted here is
 * the list that decides what the Settings window answers once one arrives.
 * That each window hears only the commands addressed to it is asserted in
 * `desktop-shell-menu.test.ts`, against Tauri's delivery rule rather than a
 * real runtime.
 */
describe('pushing state outside a Tauri runtime', () => {
  let calls: Array<{ command: string }> = [];

  beforeEach(() => {
    calls = [];
    resetMenuStateForTesting();
    const record: InvokeFn = async <T,>(command: string): Promise<T> => {
      calls.push({ command });
      return null as T;
    };
    setInvokeForTesting(record);
  });

  afterEach(() => {
    setInvokeForTesting(null);
    resetMenuStateForTesting();
    vi.clearAllMocks();
  });

  it('sends nothing at all', () => {
    // No window to title and no menu to grey out. Silence is the right answer,
    // and it is what keeps browser dev and the E2E shim working.
    return Promise.all([
      pushMenuState(context()),
      pushWindowTitle('Anything — CandidCue', false),
    ]).then(() => {
      expect(calls).toEqual([]);
    });
  });
});

/**
 * The Settings window's menu state, which is a LIST rather than a context.
 *
 * `menu.rs` delivers a menu command to the focused window, so the Settings
 * window really does receive Save, Present and Insert › Link when it is in
 * front. What stops those from reaching a hidden editor is this list: every
 * command absent from it is pushed disabled, and the window answers only what
 * it has a handler for.
 *
 * Asserted against the registry rather than against a copy of the list, so a
 * command added to `PREFERENCES_COMMANDS` without existing fails here.
 */
describe('the Settings window names what it can do', () => {
  it('lists only real commands', () => {
    for (const id of PREFERENCES_COMMANDS) {
      expect(COMMAND_IDS as readonly string[]).toContain(id);
    }
  });

  it('claims Find, because this window has something to find in', () => {
    /* ⌘F means "find in what this window is showing" — the editor's search
       panel, the Library's filter field, and here the Settings search box. One
       chord, one meaning, which is the whole point of §6.1. */
    expect(PREFERENCES_COMMANDS).toContain('edit.find');
  });

  it('claims Close Window, which is the chord it must answer itself', () => {
    /*
     * ⌘W is the one that made this necessary. Its accelerator is taken by the
     * window whether or not the item is enabled, so before menu commands were
     * routed to the focused window it closed the DOCUMENT window from behind
     * Settings.
     */
    expect(PREFERENCES_COMMANDS).toContain('file.close-script');
  });

  it('does not claim anything that needs a document, a library or a take', () => {
    const forbidden: CommandId[] = [
      'file.save',
      'file.present',
      'insert.link',
      'session.end-take',
      'view.library',
    ];
    for (const id of forbidden) {
      expect(PREFERENCES_COMMANDS as readonly string[]).not.toContain(id);
    }
  });
});

/**
 * File › Close Window (#266).
 *
 * The call it replaced, `getCurrentWindow().close()`, was refused by the ACL
 * inside a `try` that read the refusal as "browser dev", so ⌘W off the editor
 * did nothing. What is asserted here is that the browser no-op is now decided
 * by the runtime check and nothing else: inside Tauri the command is sent, and
 * a refusal reaches the caller instead of vanishing.
 *
 * `setInvokeForTesting` does not make `isTauriRuntime()` true, so the runtime
 * marker is stubbed separately — without it every case below would pass by
 * sending nothing.
 */
describe('closeControlWindow', () => {
  let calls: Array<{ command: string; args: unknown }> = [];
  let answer: () => Promise<unknown> = async () => null;

  beforeEach(() => {
    calls = [];
    answer = async () => null;
    const record: InvokeFn = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args });
      return (await answer()) as T;
    };
    setInvokeForTesting(record);
  });

  afterEach(() => {
    setInvokeForTesting(null);
    vi.unstubAllGlobals();
  });

  it('sends nothing outside a Tauri runtime', async () => {
    await closeControlWindow();
    expect(calls).toEqual([]);
  });

  it('asks Rust to close the window, and names no window', async () => {
    // No label travels: Rust closes the CALLER, and refuses one that is not
    // control. A renderer that could name the window could name the stage.
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    await closeControlWindow();
    expect(calls).toEqual([{ command: 'close_control_window', args: undefined }]);
  });

  it('lets a refusal reach the caller', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const refusal = { code: 'WINDOW_CLOSE_FAILED', userMessage: 'The window could not be closed.' };
    answer = async () => {
      throw refusal;
    };
    await expect(closeControlWindow()).rejects.toBe(refusal);
  });
});
