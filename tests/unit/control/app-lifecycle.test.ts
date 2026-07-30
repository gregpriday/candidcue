/**
 * The two lifecycle decisions that used to be inline expressions in App.svelte.
 *
 * Both were wrong for the same reason: nothing could reach them. The boot route
 * ignored a setting the operator had switched on, and the leave guard returned
 * true whether or not the save it had just awaited had actually worked. Neither
 * fact is visible from a test that has to mount the shell, so neither was ever
 * asserted. These are the same decisions as functions.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  editorNavigationDecision,
  initialRouteForBoot,
  isFatalBootCode,
  recentScriptIdForBoot,
} from '../../../src/control/lib/app-lifecycle';

describe('isFatalBootCode', () => {
  it('treats an unmigratable database as fatal', () => {
    expect(isFatalBootCode('DATABASE_MIGRATION_FAILED')).toBe(true);
  });

  it('treats a database that failed its integrity check as fatal', () => {
    expect(isFatalBootCode('DATABASE_CORRUPT')).toBe(true);
  });

  /*
   * The name says integrity, but Rust maps EVERY `AppError::Database` to this
   * code, so a busy timeout arrives under it too. Stopping the app for one
   * would trade a transient hiccup for a screen with no way forward.
   */
  it('does not treat the generic database error as fatal', () => {
    expect(isFatalBootCode('DATABASE_INTEGRITY_FAILED')).toBe(false);
  });

  it('lets every other failure boot on defaults', () => {
    expect(isFatalBootCode('SETTINGS_READ_FAILED')).toBe(false);
    expect(isFatalBootCode('BACKEND_UNAVAILABLE')).toBe(false);
  });

  it('treats an unidentifiable failure as recoverable', () => {
    // An error with no stable code is far more likely to be a transient IPC
    // problem than a corrupt database, and refusing to start is the costlier
    // mistake of the two.
    expect(isFatalBootCode(null)).toBe(false);
  });

  /* Matching is exact: normalising a code is `errorCode()`'s job, not this. */
  it('matches codes exactly', () => {
    expect(isFatalBootCode('')).toBe(false);
    expect(isFatalBootCode('database_migration_failed')).toBe(false);
    expect(isFatalBootCode(' DATABASE_MIGRATION_FAILED ')).toBe(false);
  });
});

describe('initialRouteForBoot', () => {
  it('shows Welcome on a first launch even when asked for the recent script', () => {
    // The setting exists, but somebody who has never opened the app has not
    // been shown the screen that offers it.
    expect(
      initialRouteForBoot({
        firstLaunch: true,
        launchBehavior: 'recent',
        recentScriptId: 'script-1',
      }),
    ).toEqual({ name: 'welcome' });
  });

  it('opens the most recent script when that is the stated preference', () => {
    expect(
      initialRouteForBoot({
        firstLaunch: false,
        launchBehavior: 'recent',
        recentScriptId: 'script-1',
      }),
    ).toEqual({ name: 'editor', scriptId: 'script-1' });
  });

  it('falls back to the library when there is no recent script', () => {
    expect(
      initialRouteForBoot({
        firstLaunch: false,
        launchBehavior: 'recent',
        recentScriptId: null,
      }),
    ).toEqual({ name: 'library', view: 'all' });
  });

  it('ignores an available recent script when the preference is the library', () => {
    expect(
      initialRouteForBoot({
        firstLaunch: false,
        launchBehavior: 'library',
        recentScriptId: 'script-1',
      }),
    ).toEqual({ name: 'library', view: 'all' });
  });
});

describe('recentScriptIdForBoot', () => {
  it('takes the first item of the recent page', async () => {
    const listRecent = vi.fn(async () => ({ items: [{ id: 'script-1' }, { id: 'script-2' }] }));
    await expect(
      recentScriptIdForBoot({ firstLaunch: false, launchBehavior: 'recent', listRecent }),
    ).resolves.toBe('script-1');
    expect(listRecent).toHaveBeenCalledTimes(1);
  });

  it('resolves null when nothing has ever been opened', async () => {
    await expect(
      recentScriptIdForBoot({
        firstLaunch: false,
        launchBehavior: 'recent',
        listRecent: async () => ({ items: [] }),
      }),
    ).resolves.toBeNull();
  });

  it('never rejects when the lookup fails', async () => {
    // Boot is the one sequence where an unhandled rejection costs the whole
    // app: the shell would sit on the wordmark with no way out but force-quit.
    await expect(
      recentScriptIdForBoot({
        firstLaunch: false,
        launchBehavior: 'recent',
        listRecent: async () => {
          throw new Error('list_scripts failed');
        },
      }),
    ).resolves.toBeNull();
  });

  it('does not look anything up on a first launch', async () => {
    const listRecent = vi.fn(async () => ({ items: [{ id: 'script-1' }] }));
    await expect(
      recentScriptIdForBoot({ firstLaunch: true, launchBehavior: 'recent', listRecent }),
    ).resolves.toBeNull();
    expect(listRecent).not.toHaveBeenCalled();
  });

  it('does not look anything up when the library is the preference', async () => {
    const listRecent = vi.fn(async () => ({ items: [{ id: 'script-1' }] }));
    await expect(
      recentScriptIdForBoot({ firstLaunch: false, launchBehavior: 'library', listRecent }),
    ).resolves.toBeNull();
    expect(listRecent).not.toHaveBeenCalled();
  });
});

describe('editorNavigationDecision', () => {
  const editor = { name: 'editor', scriptId: 'script-1' } as const;
  const library = { name: 'library', view: 'all' } as const;
  const live = { name: 'live', sessionId: 'session-1', scriptId: 'script-1' } as const;

  it('allows leaving an editor with nothing outstanding', () => {
    expect(editorNavigationDecision({ to: library, from: editor, hasUnsavedWork: false })).toBe(
      'allow',
    );
  });

  it('asks before abandoning unsaved work', () => {
    expect(editorNavigationDecision({ to: library, from: editor, hasUnsavedWork: true })).toBe(
      'confirm',
    );
  });

  it('asks on the way to Settings too, not just the library', () => {
    expect(
      editorNavigationDecision({
        to: { name: 'settings', section: 'general' },
        from: editor,
        hasUnsavedWork: true,
      }),
    ).toBe('confirm');
  });

  it('vetoes rather than asks on the way to Live', () => {
    // The presentation cover is already up by then and clears the dialog host,
    // so a confirmation raised here would be asked for behind an opaque black
    // rectangle — a frozen screen with no visible question.
    expect(editorNavigationDecision({ to: live, from: editor, hasUnsavedWork: true })).toBe('veto');
  });

  it('still allows Live when the editor is clean', () => {
    expect(editorNavigationDecision({ to: live, from: editor, hasUnsavedWork: false })).toBe(
      'allow',
    );
  });

  it('leaves navigations that did not start in the editor alone', () => {
    expect(editorNavigationDecision({ to: editor, from: library, hasUnsavedWork: true })).toBe(
      'allow',
    );
  });

  /*
   * Over the whole Route union rather than one representative each, because
   * the guard is registered globally and every one of these is a real
   * transition somebody can make.
   */
  const everyRoute = [
    { name: 'welcome' },
    library,
    { name: 'editor', scriptId: 'script-2' },
    live,
    { name: 'settings', section: 'general' },
    { name: 'calibrate', displayFingerprint: 'fp-1', rigName: 'Rig' },
  ] as const;

  it('confirms on the way to every destination except Live', () => {
    for (const to of everyRoute) {
      const expected = to.name === 'live' ? 'veto' : 'confirm';
      expect(editorNavigationDecision({ to, from: editor, hasUnsavedWork: true })).toBe(expected);
    }
  });

  it('asks before opening a different script over unsaved work', () => {
    // Editor → editor is a real transition: the library opens another script
    // without leaving the route, and the work in the first one is just as gone.
    expect(
      editorNavigationDecision({
        to: { name: 'editor', scriptId: 'script-2' },
        from: editor,
        hasUnsavedWork: true,
      }),
    ).toBe('confirm');
  });

  it('never interferes when the editor is not what is being left', () => {
    for (const from of everyRoute) {
      if (from.name === 'editor') continue;
      expect(editorNavigationDecision({ to: library, from, hasUnsavedWork: true })).toBe('allow');
    }
  });
});
