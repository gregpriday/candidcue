/**
 * The command registry's availability matrix and menu-state projection.
 *
 * These tests exist because a native menu is a promise. Every entry claims the
 * application can do a thing, and every greyed entry claims it cannot — so the
 * predicates are user-facing behaviour, not internal plumbing, and the one that
 * matters most is the negative case: a command that stays enabled during a take
 * is a way to disturb a presenter that only exists because the menu was added.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  COMMAND_IDS,
  commandsByCategory,
  formatAccelerator,
  menuCategory,
  menuStateFor,
  runCommand,
  type CommandActions,
  type CommandContext,
  type CommandId,
} from './commands';

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

/** An actions object that records which method was called. */
function recordingActions(): { calls: string[]; actions: CommandActions } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(args.length > 0 ? `${name}:${JSON.stringify(args)}` : name);
    };
  const actions = new Proxy({} as CommandActions, {
    get: (_target, property: string) => record(property),
  });
  return { calls, actions };
}

const LIVE = context({
  route: { name: 'live', sessionId: 's', scriptId: 'script-1' },
  sessionActive: true,
});

describe('the command registry', () => {
  it('defines every id the shared contract declares', () => {
    for (const id of COMMAND_IDS) {
      expect(COMMANDS[id], `no definition for ${id}`).toBeDefined();
      expect(COMMANDS[id].id).toBe(id);
    }
  });

  it('files every command in the menu its id names', () => {
    for (const id of COMMAND_IDS) {
      const category = menuCategory(id);
      expect(['file', 'edit', 'insert', 'view', 'session', 'window', 'help']).toContain(category);
    }
  });

  it('gives every command a non-empty label', () => {
    for (const id of COMMAND_IDS) {
      expect(COMMANDS[id].label.length).toBeGreaterThan(0);
    }
  });

  /**
   * Two commands may share an ACTION, but never a key.
   *
   * `view.settings` and `window.settings` are deliberately the same thing
   * reached two ways — ⌘, and the Window menu — so only one of them carries the
   * accelerator. The check below is what stops a second one quietly acquiring
   * it, which on a native menu means one of the two simply never fires.
   */
  it('never lists the same accelerator on two commands', () => {
    const seen = new Map<string, CommandId>();
    for (const id of COMMAND_IDS) {
      const accelerator = COMMANDS[id].accelerator;
      if (accelerator === undefined) continue;
      const previous = seen.get(accelerator);
      expect(previous, `${accelerator} is on both ${previous} and ${id}`).toBeUndefined();
      seen.set(accelerator, id);
    }
  });
});

describe('availability during a take', () => {
  /**
   * The rule §6.3 asks for, asserted as a rule rather than command by command.
   *
   * Written as an allow-list of what a take may legitimately offer: anything not
   * named here must be greyed out while a presenter is reading. A new command
   * that forgets to check `sessionActive` therefore fails this test on the day
   * it is added rather than on the day somebody uses it mid-take.
   */
  const ALLOWED_DURING_A_TAKE = new Set<CommandId>([
    'file.close-script', // always enabled; the accelerator would otherwise die
    'session.play-pause',
    'session.previous-sentence',
    'session.next-sentence',
    'session.previous-chapter',
    'session.next-chapter',
    'session.blank-stage',
    'session.toggle-mirror',
    'session.take-marker',
    'session.identify-displays',
    'session.end-take',
    'view.stage-appearance',
    'view.toggle-outline',
    // Both panes live on the OPERATOR plane, not the presenter's. Showing or
    // hiding them mid-take changes nothing the presenter can see, and hunting a
    // fault is exactly when an operator reaches for diagnostics.
    'view.toggle-diagnostics',
    'window.main',
    /*
     * Window › Stage names a window that may exist during a take (the
     * appearance preview, the calibration wizard). Whether it is enabled is
     * decided in Rust from the live window list, not here — see the entry in
     * `contracts/commands.ts` — so the registry answers "yes" unconditionally
     * and Rust greys it when there is nothing to bring forward.
     */
    'window.stage',
    /*
     * ⌘+ / ⌘− DURING a take, because during a take they mean the STAGE type
     * size — Live's own transport keys, routed through the same menu items.
     * Leaving them editor-only did not make them safe, it made them dead: a
     * menu accelerator is claimed by the window whether or not the item is
     * enabled, so the disabled Larger Editor Text swallowed ⌘= and the
     * presenter's type size stopped answering in the packaged app.
     */
    'view.zoom-in',
    'view.zoom-out',
    /*
     * Settings is reachable mid-take, and that is a change from the route it
     * replaced. As a ROUTE it had to be refused: opening it took the stage off
     * the screen. As a WINDOW it opens beside the take without disturbing it —
     * and an operator hunting a microphone problem mid-take is exactly who needs
     * it. The controls that would be unsafe to change during a take refuse
     * individually, which is §14.1's own rule.
     */
    'window.settings',
    // Same action, same answer — see the note on `view.settings`.
    'view.settings',
    'help.keyboard-shortcuts',
    'help.export-support-bundle',
    'help.reveal-logs',
  ]);

  for (const id of COMMAND_IDS) {
    it(`${id} is ${ALLOWED_DURING_A_TAKE.has(id) ? 'available' : 'unavailable'} mid-take`, () => {
      expect(COMMANDS[id].available(LIVE)).toBe(ALLOWED_DURING_A_TAKE.has(id));
    });
  }

  it('treats a take that is still opening as a take', () => {
    // The window between pressing Present and the stage being up is the one in
    // which a second Present, or a navigation, does the most damage.
    const starting = context({ takeStarting: true, librarySelectionId: 'script-1' });
    expect(COMMANDS['file.present'].available(starting)).toBe(false);
    expect(COMMANDS['session.start-take'].available(starting)).toBe(false);
    // Settings is NOT in this list: it is a window now and opening one disturbs
    // nothing. See the note on `view.settings`.
    expect(COMMANDS['view.settings'].available(starting)).toBe(true);
  });
});

describe('availability by route', () => {
  it('offers no document command with nothing selected', () => {
    const empty = context();
    expect(COMMANDS['file.present'].available(empty)).toBe(false);
    expect(COMMANDS['file.export-markdown'].available(empty)).toBe(false);
    expect(COMMANDS['file.move-to-trash'].available(empty)).toBe(false);
    expect(COMMANDS['file.duplicate-script'].available(empty)).toBe(false);
  });

  it('acts on the selected row in the Library', () => {
    const selected = context({ librarySelectionId: 'script-1' });
    expect(COMMANDS['file.present'].available(selected)).toBe(true);
    expect(COMMANDS['file.move-to-trash'].available(selected)).toBe(true);
  });

  /**
   * Practise is Present's availability, verbatim.
   *
   * A practice is a take — same script, same microphone, same recogniser — so
   * anything that makes a take impossible makes a practice impossible for the
   * same reason. Offering a rehearsal where a take is refused would be an
   * invitation to the same failure under a friendlier name.
   */
  it('offers Practise exactly where it offers Present', () => {
    const cases = [
      context(),
      context({ librarySelectionId: 'script-1' }),
      context({ librarySelectionId: 'script-1', libraryInTrash: true }),
      context({ takeStarting: true, librarySelectionId: 'script-1' }),
      context({ route: { name: 'editor', scriptId: 'script-1' }, scriptOpen: true }),
      LIVE,
    ];
    for (const c of cases) {
      expect(COMMANDS['file.practise'].available(c)).toBe(COMMANDS['file.present'].available(c));
    }
  });

  it('runs the practice action rather than a present with a mode', () => {
    /*
     * The distinction the whole feature rests on: a practice is not a third
     * shape for the window, so it must not arrive as `present('reader')` — that
     * would present in a window AND write the window back to Settings.
     */
    const { calls, actions } = recordingActions();
    expect(runCommand('file.practise', actions, context({ librarySelectionId: 'script-1' }))).toBe(
      true,
    );
    expect(calls).toEqual(['practise']);
  });

  it('offers nothing to act on for a selected row in Trash', () => {
    // A trashed script cannot be presented or trashed again, and the Library
    // withholds its open handler entirely — so the menu must agree.
    const trashed = context({ librarySelectionId: 'script-1', libraryInTrash: true });
    expect(COMMANDS['file.present'].available(trashed)).toBe(false);
    expect(COMMANDS['file.move-to-trash'].available(trashed)).toBe(false);
  });

  it('offers Save whenever a script is open, even when it is already saved', () => {
    const saved = context({
      route: { name: 'editor', scriptId: 'script-1' },
      scriptOpen: true,
      saveState: 'saved',
    });
    expect(COMMANDS['file.save'].available(saved)).toBe(true);
  });

  /**
   * Being on the editor ROUTE is not the same as having a document in it.
   *
   * The route mounts, shows "Opening script…", and only then does the document
   * arrive. Save and Find were enabled over that empty editor until `editing()`
   * learned to ask — Rename already asked, so the two were inconsistent too.
   */
  it('withholds Save and Find while the editor is still opening', () => {
    const opening = context({ route: { name: 'editor', scriptId: 'a' }, scriptOpen: false });
    expect(COMMANDS['file.save'].available(opening)).toBe(false);
    expect(COMMANDS['edit.find'].available(opening)).toBe(false);
    expect(COMMANDS['file.rename-script'].available(opening)).toBe(false);
  });

  it('gives Find to the editor AND the Library, and to nothing else', () => {
    /*
     * One Find chord per window rather than one per screen. It opens the
     * editor's search panel and focuses the Library's filter field, which is
     * what freed ⌘K for Insert › Link — the two used to collide, invisibly,
     * because a menu accelerator is taken by the window even when the item is
     * greyed.
     */
    expect(
      COMMANDS['edit.find'].available(
        context({ route: { name: 'editor', scriptId: 'a' }, scriptOpen: true }),
      ),
    ).toBe(true);
    expect(COMMANDS['edit.find'].available(context({ route: { name: 'library', view: 'all' } }))).toBe(
      true,
    );
    expect(COMMANDS['edit.find'].available(context({ route: { name: 'welcome' } }))).toBe(false);
    // Find NEXT stays editor-only: there is nothing to step through in a list.
    expect(
      COMMANDS['edit.find-next'].available(context({ route: { name: 'library', view: 'all' } })),
    ).toBe(false);
  });

  it('confines Diagnostics to Live and the outline to Live and the editor', () => {
    expect(COMMANDS['view.toggle-diagnostics'].available(context())).toBe(false);
    expect(COMMANDS['view.toggle-diagnostics'].available(LIVE)).toBe(true);
    expect(COMMANDS['view.toggle-outline'].available(context())).toBe(false);
    expect(
      COMMANDS['view.toggle-outline'].available(context({ route: { name: 'editor', scriptId: 'a' } })),
    ).toBe(true);
  });

  it('does not start a new script from inside the calibration wizard', () => {
    // Calibration holds a live stage window against a real panel and carries
    // step state that is not on disk; leaving mid-wizard abandons a measurement.
    const calibrating = context({
      route: { name: 'calibrate', displayFingerprint: 'fp', rigName: 'rig' },
    });
    expect(COMMANDS['file.new-script'].available(calibrating)).toBe(false);
    expect(COMMANDS['file.import-markdown'].available(calibrating)).toBe(false);
  });

  it('keeps Close Script enabled everywhere', () => {
    // A disabled accelerator does not hand ⌘W back to the window manager — it
    // makes ⌘W dead. See the note on the id in the shared contract.
    for (const route of [
      context(),
      context({ route: { name: 'editor', scriptId: 'a' } }),
      LIVE,
      context({ route: { name: 'settings', section: 'general' } }),
    ]) {
      expect(COMMANDS['file.close-script'].available(route)).toBe(true);
    }
  });
});

describe('menu state projection', () => {
  it('reports every command on every push', () => {
    const items = menuStateFor(context());
    expect(items).toHaveLength(COMMAND_IDS.length);
    expect(new Set(items.map((item) => item.id)).size).toBe(COMMAND_IDS.length);
  });

  it('carries checkmarks only for commands that have them', () => {
    const items = menuStateFor(context({ sidebarVisible: false }));
    const sidebar = items.find((item) => item.id === 'view.toggle-sidebar');
    expect(sidebar?.checked).toBe(false);
    const save = items.find((item) => item.id === 'file.save');
    expect(save && 'checked' in save).toBe(false);
  });

  it('reports the editor layout as exactly one checked mode', () => {
    const items = menuStateFor(context({ editorLayout: 'split' }));
    const modes = items.filter((item) =>
      ['view.edit-mode', 'view.preview-mode', 'view.split-mode'].includes(item.id),
    );
    expect(modes.filter((item) => item.checked === true)).toHaveLength(1);
    expect(modes.find((item) => item.checked === true)?.id).toBe('view.split-mode');
  });

  it('renames Pause to Resume and Blank to Show', () => {
    const paused = menuStateFor({ ...LIVE, sessionPaused: true, stageBlanked: true });
    expect(paused.find((item) => item.id === 'session.play-pause')?.label).toBe('Resume');
    expect(paused.find((item) => item.id === 'session.blank-stage')?.label).toBe('Show Stage');

    const running = menuStateFor(LIVE);
    expect(running.find((item) => item.id === 'session.play-pause')?.label).toBe('Pause');
    expect(running.find((item) => item.id === 'session.blank-stage')?.label).toBe('Blank Stage');
  });

  it('renames Close Script to Close Window off the editor', () => {
    expect(
      menuStateFor(context()).find((item) => item.id === 'file.close-script')?.label,
    ).toBe('Close Window');
    expect(
      menuStateFor(context({ route: { name: 'editor', scriptId: 'a' } })).find(
        (item) => item.id === 'file.close-script',
      )?.label,
    ).toBe('Close Script');
  });

  it('reports the mirror checkmark from the take', () => {
    expect(
      menuStateFor({ ...LIVE, stageMirrored: true }).find(
        (item) => item.id === 'session.toggle-mirror',
      )?.checked,
    ).toBe(true);
  });
});

describe('runCommand', () => {
  it('refuses a command the context does not allow', () => {
    const { calls, actions } = recordingActions();
    // The menu's enabled flags are a snapshot pushed milliseconds ago; a take
    // can start between the push and the click.
    expect(runCommand('file.present', actions, context())).toBe(false);
    expect(calls).toEqual([]);
  });

  it('runs a command the context allows', () => {
    const { calls, actions } = recordingActions();
    expect(runCommand('file.new-script', actions, context())).toBe(true);
    expect(calls).toEqual(['newScript']);
  });

  it('passes the selected script to document commands', () => {
    const { calls, actions } = recordingActions();
    runCommand('file.move-to-trash', actions, context({ librarySelectionId: 'script-7' }));
    expect(calls).toEqual(['moveToTrash:["script-7"]']);
  });

  it('prefers the open script over the Library selection', () => {
    const { calls, actions } = recordingActions();
    runCommand(
      'file.export-markdown',
      actions,
      context({
        route: { name: 'editor', scriptId: 'open-1' },
        scriptOpen: true,
        librarySelectionId: 'other',
      }),
    );
    expect(calls).toEqual(['exportMarkdown:["open-1"]']);
  });

  it('sends Close Script to the script off the editor and to the window elsewhere', () => {
    const inEditor = recordingActions();
    runCommand('file.close-script', inEditor.actions, context({ route: { name: 'editor', scriptId: 'a' } }));
    expect(inEditor.calls).toEqual(['closeScript']);

    const inLibrary = recordingActions();
    runCommand('file.close-script', inLibrary.actions, context());
    expect(inLibrary.calls).toEqual(['closeWindow']);
  });
});

describe('formatAccelerator', () => {
  it('uses glyphs on macOS in the platform order', () => {
    expect(formatAccelerator('Mod+N', true)).toBe('⌘N');
    expect(formatAccelerator('Mod+Shift+G', true)).toBe('⇧⌘G');
    expect(formatAccelerator('Mod+Alt+F', true)).toBe('⌥⌘F');
    expect(formatAccelerator('Mod+Return', true)).toBe('⌘⏎');
    expect(formatAccelerator('Alt+Left', true)).toBe('⌥←');
  });

  it('uses words elsewhere, with Mod spelled Ctrl', () => {
    expect(formatAccelerator('Mod+N', false)).toBe('Ctrl+N');
    expect(formatAccelerator('Mod+Shift+G', false)).toBe('Ctrl+Shift+G');
    expect(formatAccelerator('Mod+Return', false)).toBe('Ctrl+Enter');
    expect(formatAccelerator('Alt+Down', false)).toBe('Alt+↓');
  });

  it('shows the plus key as +, not =', () => {
    // The accelerator has to be spelled `=` because that is the key that is
    // physically pressed, but nobody reads "⌘=" as "make it bigger".
    expect(formatAccelerator('Mod+=', true)).toBe('⌘+');
  });
});

describe('commandsByCategory', () => {
  it('groups every command exactly once, in menu order', () => {
    const groups = commandsByCategory();
    expect(groups.map((group) => group.category)).toEqual([
      'file',
      'edit',
      'insert',
      'view',
      'session',
      'window',
      'help',
    ]);
    const total = groups.reduce((sum, group) => sum + group.commands.length, 0);
    expect(total).toBe(COMMAND_IDS.length);
  });
});

describe('stage type size on a calibrated rig (§17.2)', () => {
  /*
   * The take that sizes its own type. Live already declined this and explained
   * in a toast, which is right for a key press and wrong for a menu item: §6.3
   * asks for an impossible action to be visibly impossible, and somebody who
   * opened the View menu read "Larger Stage Text" as available on the way to
   * choosing it.
   */
  const LIVE_RIG = context({
    route: { name: 'live', sessionId: 's', scriptId: 'a' },
    sessionActive: true,
    stageRigResolved: true,
  });
  const LIVE_FREE = context({
    route: { name: 'live', sessionId: 's', scriptId: 'a' },
    sessionActive: true,
  });

  it('greys Larger and Smaller Stage Text when the rig decides the size', () => {
    expect(COMMANDS['view.zoom-in'].available(LIVE_RIG)).toBe(false);
    expect(COMMANDS['view.zoom-out'].available(LIVE_RIG)).toBe(false);
  });

  it('offers them on a take that is not rig-resolved', () => {
    expect(COMMANDS['view.zoom-in'].available(LIVE_FREE)).toBe(true);
    expect(COMMANDS['view.zoom-out'].available(LIVE_FREE)).toBe(true);
  });
});
