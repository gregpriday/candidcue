/**
 * What the EDITOR does when a library mutation fails under it.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECTS THESE EXIST FOR
 * ---------------------------------------------------------------------------
 * 1. `trashFromEditor` awaited `moveScriptToTrash(scriptId)` and threw the
 *    answer away, then navigated to the library unconditionally. Before the
 *    store was hardened, a rejection short-circuited that navigate by escaping
 *    the function; once the store started catching and reporting its own
 *    failures, the navigate stopped being guarded by anything. A trash that did
 *    NOT happen ejected the author out of the document anyway — the script
 *    still there, and the person who tried to delete it no longer in it. The
 *    mutator's boolean exists for precisely this caller.
 *
 * 2. Duplicate called `scriptsService.duplicateScript(...)` directly, going
 *    around the hardened store. No `try`, no toast, nothing: the last library
 *    mutation in the app that could still fail in total silence.
 *
 * Only a mounted route can prove either one, because both are about what the
 * route does with the answer — not about what the store returns, which
 * `tests/unit/control/library-mutations.test.ts` already pins.
 *
 * No jest-dom here (see `vitest.dom.config.ts`) — assertions are plain DOM
 * reads.
 */
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting, type InvokeFn } from '../../src/control/services/ipc';
import { closeScript, saveNow, setSource } from '../../src/control/stores/editor';
import { loadLibrary, setLibraryQuery, setLibraryView } from '../../src/control/stores/library';
import { showToast } from '../../src/control/stores/toasts';
import { navigate } from '../../src/control/stores/router';
import Editor from '../../src/control/routes/Editor.svelte';
import type { ScriptSummary } from '../../src/shared/contracts';

vi.mock('../../src/control/stores/toasts', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
  dismissToastByKey: vi.fn(),
  clearConditionToasts: vi.fn(),
  toasts: { subscribe: () => () => {} },
}));

// The route's own escape hatch, and the thing fix 1 is about: whether the
// editor leaves the document. Mocked so the test can watch it rather than
// letting the real router swap the screen out from under the assertions.
vi.mock('../../src/control/stores/router', () => ({
  navigate: vi.fn(async () => true),
  route: { subscribe: () => () => {} },
  currentRoute: () => ({ name: 'editor', scriptId: 'a' }),
  registerNavigationGuard: () => () => {},
  setInitialRoute: vi.fn(),
}));

const confirm = vi.hoisted(() => ({
  requestConfirm: vi.fn(async (_request: { title: string; body: string }) => true),
}));
vi.mock('../../src/control/stores/confirm', () => ({
  requestConfirm: confirm.requestConfirm,
  pendingConfirm: { subscribe: () => () => {} },
  settleConfirm: vi.fn(),
}));

vi.mock('../../src/control/lib/shortcuts', () => ({ onShortcut: () => () => {} }));
vi.mock('../../src/control/lib/start-take', () => ({
  startTake: vi.fn(async () => {}),
  takeStarting: { subscribe: (run: (v: boolean) => void) => (run(false), () => {}) },
}));

const SCRIPT_ID = 'a';

/*
 * The compile path is a Web Worker behind a service, and none of it is under
 * test here. Stubbing the store keeps the route mountable in jsdom.
 *
 * It reports a compile that has SETTLED for this script, carrying nothing:
 * `result` stays null, so every derived value falls back to empty exactly as
 * before and no compile is pretended to have produced anything. The status has
 * to settle because the editor waits for its first compile before it draws
 * (§13, issue #140) — and a permanently idle store is not a state the real app
 * can be in anyway, since adopting a document always requests a compile.
 */
vi.mock('../../src/control/stores/compiled', () => ({
  compiled: readable({
    status: 'ready' as const,
    editorRevision: 0,
    result: null,
    error: null,
    scriptId: 'a',
  }),
  requestCompile: vi.fn(async () => {}),
  resetCompiled: vi.fn(),
}));

const toast = vi.mocked(showToast);
const navigated = vi.mocked(navigate);

/** An AppError payload — the shape a real Tauri command rejection arrives in. */
const conflict = { code: 'SCRIPT_CONFLICT', userMessage: 'stale revision' };

function summary(id: string, title = id): ScriptSummary {
  return {
    id,
    title,
    status: 'draft',
    language: 'en',
    spokenWordCount: 10,
    estimatedDurationSeconds: 4,
    updatedAt: '2026-07-30T10:00:00.000Z',
    previewText: 'Some narration.',
    hasWarnings: false,
    scriptRevision: 3,
  };
}

function scriptDocument(id: string): Record<string, unknown> {
  return {
    ...summary(id, 'Keynote'),
    source: '# Keynote\n\nSome narration.\n',
    sourceHash: 'hash',
    settings: {
      schemaVersion: 1,
      readHeadings: false,
      readImageAltText: false,
      readInlineCode: false,
      cueVisibility: 'subtle',
      silentBlockVisibility: 'dim',
      wordsPerMinuteEstimate: 150,
    },
  };
}

/** Every command the fake backend was asked to run, in order. */
let commands: string[] = [];

/** The source of every save that reached the backend, in order. */
let saved: string[] = [];

/** The revision the script is at. Every save and every trash moves it on. */
let revision = 3;

function installBackend(fail: Record<string, unknown> = {}): void {
  const fake: InvokeFn = async <T,>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    commands.push(command);
    if (command in fail) throw fail[command];
    if (command === 'list_scripts') {
      return { items: [{ ...summary(SCRIPT_ID), scriptRevision: revision }], total: 1 } as T;
    }
    if (command === 'get_script') {
      return { ...scriptDocument(SCRIPT_ID), scriptRevision: revision } as T;
    }
    if (command === 'save_script') {
      saved.push(args?.source as string);
      revision += 1;
      return {
        status: 'saved',
        scriptRevision: revision,
        savedAt: '2026-07-30T10:00:01.000Z',
      } as T;
    }
    if (command === 'trash_script') {
      // A compare-and-swap, as `repo.rs` makes it: a revision the script has
      // moved past is refused, which is how #255 reached the author.
      if (args?.expectedRevision !== revision) throw conflict;
      revision += 1;
      return { ...summary(args?.scriptId as string), scriptRevision: revision } as T;
    }
    if (command === 'duplicate_script') return summary('copy') as T;
    throw new Error(`unexpected command ${command}`);
  };
  setInvokeForTesting(fake);
}

/** Every message of one tone the route put up, in order. */
function messages(tone: string): string[] {
  return toast.mock.calls.filter((call) => call[1] === tone).map((call) => String(call[0]));
}

/**
 * The same shape `tests/unit/control/library-mutations.test.ts` uses: opens
 * with the authored sentence, carries no machine token, and says more than its
 * own prefix. The second half comes from `describeError`, which owns that
 * wording (§44.12), so it is not pinned to an exact string.
 */
function expectReadableFailure(shown: string | undefined, opening: string): void {
  expect(typeof shown).toBe('string');
  const message = shown ?? '';
  expect(message.startsWith(opening)).toBe(true);
  expect(message).not.toContain('[object Object]');
  expect(message).not.toMatch(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/);
  expect(message.length).toBeGreaterThan(opening.length + 1);
}

/**
 * Open the Script actions menu and choose one item by its visible label — the
 * same two clicks the author makes.
 */
async function chooseOverflowItem(label: string): Promise<void> {
  const trigger = [...document.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Script actions',
  );
  expect(trigger, 'the editor header must offer the Script actions menu').toBeTruthy();
  trigger?.click();
  await tick();
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(item, `the Script actions menu must offer "${label}"`).toBeTruthy();
  (item as HTMLElement).click();
  // The handler is async through the store and a library reload behind it.
  await tick();
  await Promise.resolve();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

beforeEach(async () => {
  commands = [];
  saved = [];
  revision = 3;
  installBackend();
  setLibraryQuery('');
  setLibraryView('all');
  // The library store is a module singleton and `revisionOf` reads it, so the
  // route is driven from the state it really has when you arrive from Library.
  await loadLibrary();
  toast.mockClear();
  navigated.mockClear();
  confirm.requestConfirm.mockClear();
});

afterEach(() => {
  setInvokeForTesting(null);
  vi.clearAllMocks();
});

async function mountEditor(): Promise<void> {
  render(Editor, { props: { scriptId: SCRIPT_ID } });
  // `openScript` runs in an effect; let the document land before acting on it.
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  navigated.mockClear();
  toast.mockClear();
}

describe('a trash that failed leaves the author in the script', () => {
  it('does not navigate to the library when the trash was refused', async () => {
    installBackend({ trash_script: conflict });
    await mountEditor();

    await chooseOverflowItem('Move to Trash');

    expect(confirm.requestConfirm).toHaveBeenCalledTimes(1);
    // The whole point: the script is still there, so the author still is too.
    expect(navigated).not.toHaveBeenCalled();
  });

  it('says what happened rather than failing quietly', async () => {
    installBackend({ trash_script: conflict });
    await mountEditor();

    await chooseOverflowItem('Move to Trash');

    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expectReadableFailure(shown[0], 'The script could not be moved to Trash.');
  });

  it('still leaves for the library when the trash actually happened', async () => {
    await mountEditor();

    await chooseOverflowItem('Move to Trash');

    expect(navigated).toHaveBeenCalledWith({ name: 'library', view: 'all' });
    expect(messages('danger')).toEqual([]);
  });

  it('neither navigates nor reports when the confirmation was declined', async () => {
    confirm.requestConfirm.mockResolvedValueOnce(false);
    await mountEditor();

    await chooseOverflowItem('Move to Trash');

    expect(navigated).not.toHaveBeenCalled();
    expect(messages('danger')).toEqual([]);
  });
});

/*
 * Issue #255. Once autosave had moved the revision on, the trash named the one
 * the Library loaded, and Rust refused it as an external change: the author was
 * left in the script they had just deleted, reading about an edit made outside
 * CandidCue that never happened. The fake refuses a stale revision, so these
 * fail exactly the way the app did.
 */
describe('Move to Trash works on a script that has been edited', () => {
  const typed = '# Keynote\n\nSome narration.\n\nAnd a word typed since it opened.\n';

  afterEach(() => {
    closeScript();
  });

  it('trashes it after an autosave, and leaves for the library', async () => {
    await mountEditor();
    setSource(typed);
    await saveNow();

    await chooseOverflowItem('Move to Trash');

    expect(messages('danger')).toEqual([]);
    expect(messages('info')).toContain('Moved to Trash');
    expect(navigated).toHaveBeenCalledWith({ name: 'library', view: 'all' });
  });

  it('saves what was just typed before it trashes', async () => {
    await mountEditor();
    setSource(typed);

    await chooseOverflowItem('Move to Trash');

    expect(saved).toEqual([typed]);
    expect(commands.indexOf('save_script')).toBeLessThan(commands.indexOf('trash_script'));
    expect(messages('danger')).toEqual([]);
    expect(navigated).toHaveBeenCalledWith({ name: 'library', view: 'all' });
  });

  it('stays in the script, and says why, when the edits cannot be saved', async () => {
    installBackend({ save_script: new Error('Disk unavailable') });
    await mountEditor();
    setSource(typed);

    await chooseOverflowItem('Move to Trash');

    expect(commands).not.toContain('trash_script');
    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expectReadableFailure(shown[0], 'The script could not be moved to Trash.');
    expect(shown[0]).toContain('Disk unavailable');
    expect(navigated).not.toHaveBeenCalled();
  });
});

describe('a duplicate that failed is not silent', () => {
  it('reports the failure instead of doing nothing at all', async () => {
    installBackend({ duplicate_script: conflict });
    await mountEditor();

    await chooseOverflowItem('Duplicate');

    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expectReadableFailure(shown[0], 'The script could not be duplicated.');
    // A failed duplicate is not a reason to leave the document either.
    expect(navigated).not.toHaveBeenCalled();
  });

  it('confirms the copy when it worked', async () => {
    await mountEditor();

    await chooseOverflowItem('Duplicate');

    expect(messages('success')).toContain('Script duplicated');
    expect(messages('danger')).toEqual([]);
  });
});

/*
 * Issue #245: Duplicate copied the file on disk without saving the editor
 * first, so the copy was the last save rather than the text on screen — and
 * while saves were failing, it was an old version under "Script duplicated".
 */
describe('Duplicate copies the text on screen, not the last save', () => {
  const typed = '# Keynote\n\nSome narration.\n\nAnd the line I just typed.\n';

  afterEach(() => {
    // Unmounting the route does not reset the editor store, and a dirty
    // buffer leaves an autosave timer armed.
    closeScript();
  });

  it('saves what was just typed before the copy is made', async () => {
    await mountEditor();
    setSource(typed);

    await chooseOverflowItem('Duplicate');

    expect(saved).toEqual([typed]);
    expect(commands.indexOf('save_script')).toBeLessThan(commands.indexOf('duplicate_script'));
    expect(messages('success')).toContain('Script duplicated');
    expect(messages('danger')).toEqual([]);
  });

  it('makes no copy, and says why, when the edits cannot be saved', async () => {
    installBackend({ save_script: new Error('Disk unavailable') });
    await mountEditor();
    setSource(typed);

    await chooseOverflowItem('Duplicate');

    expect(commands).not.toContain('duplicate_script');
    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expectReadableFailure(shown[0], 'The script could not be duplicated.');
    expect(shown[0]).toContain('Disk unavailable');
    expect(messages('success')).toEqual([]);
    expect(navigated).not.toHaveBeenCalled();
  });
});
