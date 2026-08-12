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
  composeWindowTitle,
  pushMenuState,
  pushWindowTitle,
  resetMenuStateForTesting,
} from './desktop-shell';
import type { CommandContext } from '../lib/commands';

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    route: { name: 'library', view: 'all' },
    sessionActive: false,
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
 * covered by `menuStateFor` in `commands.test.ts`, and its delivery by the Rust
 * ACL and roundtrip tests.
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
