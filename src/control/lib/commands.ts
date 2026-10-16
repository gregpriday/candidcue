/**
 * The application command registry (desktop refinement §6.1).
 *
 * ---------------------------------------------------------------------------
 * ONE DEFINITION — AND WHAT STILL READS ITS OWN COPY
 * ---------------------------------------------------------------------------
 * A command is defined once here and reaches the user through the native menu,
 * `runCommand`, the Shortcuts dialog's menu tables, and (for some) a toolbar
 * button or context-menu row. Before this file each of those was wired
 * independently, which is exactly the arrangement in which a menu item, a key
 * and a button end up meaning three slightly different things.
 *
 * Two surfaces are NOT generated from this file, and saying otherwise would be
 * the drift this file exists to prevent:
 *
 *   - the native menu STRUCTURE in `menu.rs` — ids, labels and accelerators —
 *     is written out in Rust, because it crosses a language boundary. What
 *     keeps it honest is `menu_accelerators_match_the_typescript_registry`,
 *     which now compares the two sets in BOTH directions: a chord Rust binds
 *     must be the chord declared here, and a chord declared here must be bound;
 *   - the transport keys — Space, B, T, `[`, `]` — are resolved by
 *     `lib/shortcuts.ts`, which is a different mechanism rather than a second
 *     copy: they are unmodified keys owned by whichever screen is up, and they
 *     have no menu item to be an accelerator for.
 *
 * The Shortcuts dialog prints both halves, and its own test refuses to let one
 * chord stand for two different things across them.
 *
 * ---------------------------------------------------------------------------
 * AVAILABILITY IS ASKED, NEVER ASSUMED
 * ---------------------------------------------------------------------------
 * Every command declares `available(context)`. That predicate does three jobs at
 * once, and they must not be separated:
 *
 *   1. it greys the native menu item out, so an impossible action is visibly
 *      impossible rather than failing after it is chosen (§6.3);
 *   2. it is checked again inside `runCommand` before the action fires, because
 *      a menu's enabled state is a snapshot pushed some milliseconds ago and the
 *      session can end in between;
 *   3. it is what the Shortcuts dialog reads for its menu tables, through
 *      `commandsByCategory()`. Its remaining rows — the transport — come from
 *      `SHORTCUT_OWNERSHIP` in `lib/shortcuts.ts`, for the reason above.
 *
 * ---------------------------------------------------------------------------
 * COMMANDS DO NOT BYPASS GUARDS
 * ---------------------------------------------------------------------------
 * Every command that leaves a screen calls `navigate()`, which runs the same
 * unsaved-work and end-take guards a sidebar click does. This is the single
 * most important property of the file: a native menu that could end a running
 * take without the confirmation the button shows would be a way to lose a take
 * that only exists because the menu was added.
 */
import {
  COMMAND_IDS,
  menuCategory,
  type CommandCategory,
  type CommandId,
  type MenuItemState,
} from '../../shared/contracts/commands';
import { PRACTICE_LABEL } from '../../shared/take-vocabulary';
import type { Route, SettingsSection } from '../stores/router';
import type { SaveState } from '../stores/editor';
import type { EditorLayout } from '../stores/workspace';

/**
 * The insertions the native Insert menu offers.
 *
 * A union rather than eight separate action methods: they are one family, the
 * editor answers all of them the same way, and a new one should not mean a new
 * field on `CommandActions` that every caller has to implement.
 */
export type InsertKind =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'link'
  | 'image'
  | 'diagram'
  | 'cue'
  | 'take-marker';

export type { CommandId, CommandCategory, MenuItemState };
export { COMMAND_IDS, menuCategory };

/**
 * Everything a command needs to know about the application right now.
 *
 * A flat snapshot rather than a bundle of store references, and that is
 * deliberate: it makes every `available` predicate a pure function of plain
 * data, so the whole availability matrix is testable without mounting a single
 * component or faking a store.
 */
export interface CommandContext {
  route: Route;
  /** A take is running. Not the same as being on the Live route. */
  sessionActive: boolean;
  /**
   * The running take sizes its type from a measured viewing distance (§17.2).
   *
   * In the context because it decides an AVAILABILITY, and §6.3's rule is that
   * an impossible action is greyed rather than refused after it is chosen.
   * Larger/Smaller Stage Text has nothing to move on a calibrated rig — Live
   * already declined and explained in a toast, which is the right answer for a
   * key press and the wrong one for a menu item somebody had to open a menu to
   * reach and read as available on the way.
   */
  stageRigResolved: boolean;
  /** The take is paused (so Pause reads Resume). */
  sessionPaused: boolean;
  /** The stage is blanked (so Blank reads Unblank). */
  stageBlanked: boolean;
  /** The stage is mirrored (menu checkmark). */
  stageMirrored: boolean;
  /** A script is open in the editor. */
  scriptOpen: boolean;
  /** The editor's save state, so Save can be greyed out when there is nothing to do. */
  saveState: SaveState;
  editorHasUnsavedWork: boolean;
  /** A row is selected in the Library, so File commands can act on it. */
  librarySelectionId: string | null;
  /** The Library is showing Trash, where Present and Rename mean nothing. */
  libraryInTrash: boolean;
  sidebarVisible: boolean;
  outlineVisible: boolean;
  diagnosticsVisible: boolean;
  editorLayout: EditorLayout;
  /** A presentation transition is in flight; nothing may start another. */
  takeStarting: boolean;
}

/** What a command needs at the moment it runs — the doing half of the registry. */
export interface CommandActions {
  newScript(): void;
  importMarkdown(): void;
  save(): void;
  duplicate(scriptId: string): void;
  rename(scriptId: string): void;
  exportMarkdown(scriptId: string): void;
  revealScript(scriptId: string): void;
  moveToTrash(scriptId: string): void;
  closeScript(): void;
  closeWindow(): void;
  present(mode?: 'prompter' | 'reader'): void;
  /** Rehearse in a window: voice following on, nothing reported (§practice). */
  practise(): void;
  find(): void;
  findNext(): void;
  findPrevious(): void;
  replace(): void;
  showLibrary(): void;
  toggleSidebar(): void;
  toggleOutline(): void;
  toggleDiagnostics(): void;
  setEditorLayout(layout: EditorLayout): void;
  stepScale(direction: 1 | -1 | 0): void;
  stageAppearance(): void;
  settings(): void;
  /** One of the editor's insertions, by name (§11.4). */
  insert(what: InsertKind): void;
  startTake(): void;
  playPause(): void;
  moveSentence(delta: -1 | 1): void;
  moveChapter(delta: -1 | 1): void;
  blankStage(): void;
  toggleMirror(): void;
  takeMarker(): void;
  identifyDisplays(): void;
  endTake(): void;
  showMainWindow(): void;
  /** Window › Stage — bring the preview/calibration stage window forward. */
  showStageWindow(): void;
  keyboardShortcuts(): void;
  setupAssistant(): void;
  exportSupportBundle(): void;
  revealLogs(): void;
  privacy(): void;
  /**
   * Open one of the project's pages, BY NAME.
   *
   * The name is the whole contract. Rust maps it to a fixed page of the one
   * compile-time repository (`src-tauri/src/web.rs`); the control window has no
   * permission to open an address it chose, and this signature is where that
   * stays true — the moment this takes a URL, the restriction is gone.
   */
  openWebDestination(name: WebDestination): void;
  /** Open the third-party notices this build shipped with. */
  thirdPartyNotices(): void;
}

/**
 * The names `open_web_destination` answers to.
 *
 * Spelled out rather than `string`, so a typo is a compile error here instead
 * of a menu item that opens nothing at runtime. Keep in step with `DESTINATIONS`
 * in `src-tauri/src/web.rs`.
 */
export type WebDestination = 'website' | 'guide' | 'support' | 'release-notes' | 'download';

export interface CommandDefinition {
  id: CommandId;
  /** The label the native menu was BUILT with. */
  label: string;
  /**
   * A label that replaces it under some state (Pause → Resume).
   *
   * Returning `null` means "keep the built label". Absent means the label never
   * changes, which is the case for all but three commands.
   */
  dynamicLabel?: (context: CommandContext) => string | null;
  /** Shown as a checkmark in the native menu. Absent means "not a check item". */
  checked?: (context: CommandContext) => boolean;
  available: (context: CommandContext) => boolean;
  run: (actions: CommandActions, context: CommandContext) => void;
  /**
   * The key, in the app's own display spelling, for the Shortcuts dialog.
   *
   * Written with the platform-neutral `Mod` token and rendered per platform by
   * `formatAccelerator`, so this file never has to know which machine it is on.
   */
  accelerator?: string;
}

/** True while a script is open somewhere a File command can act on it. */
function targetScriptId(context: CommandContext): string | null {
  if (context.route.name === 'editor') return context.route.scriptId;
  if (context.route.name === 'library' && !context.libraryInTrash) return context.librarySelectionId;
  return null;
}

/**
 * A take is on the glass and must not be disturbed.
 *
 * Used as a blanket veto on the document commands. Not because they would
 * crash — most would work — but because they all end by changing what is on
 * screen, and what is on screen is being read aloud by somebody standing at a
 * camera. §6.3's rule is that a menu must not offer an action whose consequence
 * the user cannot see.
 */
function presenting(context: CommandContext): boolean {
  return context.sessionActive || context.takeStarting;
}

/**
 * On the editor, with a document actually loaded, and not mid-take.
 *
 * `scriptOpen` is the part that was missing. Being on the editor ROUTE is not
 * the same as having a script in it: the route mounts, shows "Opening script…",
 * and only then does the document arrive. Without this check Save and the whole
 * Find family were enabled over an editor that had nothing in it — and Rename
 * already asked the question, so the two were inconsistent as well as wrong.
 */
function editing(context: CommandContext): boolean {
  return context.route.name === 'editor' && context.scriptOpen && !presenting(context);
}

export const COMMANDS: Record<CommandId, CommandDefinition> = {
  // ------------------------------------------------------------------ File --
  'file.new-script': {
    id: 'file.new-script',
    label: 'New Script',
    accelerator: 'Mod+N',
    /*
     * Available on the Library and the Editor, not during a take, and NOT on
     * the calibration wizard. Calibration holds a live stage window against a
     * real panel and its steps carry state that is not on disk yet; dropping
     * somebody into a new script from there abandons a measurement halfway.
     */
    available: (c) => !presenting(c) && c.route.name !== 'calibrate',
    run: (a) => a.newScript(),
  },
  'file.import-markdown': {
    id: 'file.import-markdown',
    label: 'Import Markdown…',
    accelerator: 'Mod+Shift+I',
    available: (c) => !presenting(c) && c.route.name !== 'calibrate',
    run: (a) => a.importMarkdown(),
  },
  'file.save': {
    id: 'file.save',
    label: 'Save',
    accelerator: 'Mod+S',
    /*
     * Enabled whenever a script is open, including when everything is already
     * saved.
     *
     * Greying Save out on a saved document is technically honest and practically
     * hostile: ⌘S is a reflex, and a reflex that silently does nothing teaches
     * people the app does not save. It is a flush — it costs a no-op write at
     * worst — and the status bar reports the outcome either way.
     */
    available: (c) => editing(c),
    run: (a) => a.save(),
  },
  'file.duplicate-script': {
    id: 'file.duplicate-script',
    label: 'Duplicate Script',
    accelerator: 'Mod+D',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a, c) => {
      const id = targetScriptId(c);
      if (id !== null) a.duplicate(id);
    },
  },
  'file.rename-script': {
    id: 'file.rename-script',
    label: 'Rename Script',
    // Editor only. Renaming from the Library would need an inline edit on the
    // row, and a menu item whose effect is invisible (the field it focuses is
    // on another screen) is worse than one that is greyed out.
    available: (c) => editing(c),
    run: (a, c) => {
      if (c.route.name === 'editor') a.rename(c.route.scriptId);
    },
  },
  'file.export-markdown': {
    id: 'file.export-markdown',
    label: 'Export Markdown…',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a, c) => {
      const id = targetScriptId(c);
      if (id !== null) a.exportMarkdown(id);
    },
  },
  'file.reveal-script': {
    id: 'file.reveal-script',
    label: 'Reveal in Finder',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a, c) => {
      const id = targetScriptId(c);
      if (id !== null) a.revealScript(id);
    },
  },
  'file.move-to-trash': {
    id: 'file.move-to-trash',
    label: 'Move to Trash',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a, c) => {
      const id = targetScriptId(c);
      if (id !== null) a.moveToTrash(id);
    },
  },
  'file.close-script': {
    id: 'file.close-script',
    label: 'Close Script',
    accelerator: 'Mod+W',
    dynamicLabel: (c) => (c.route.name === 'editor' ? 'Close Script' : 'Close Window'),
    /*
     * ALWAYS ENABLED. See the note on this id in the shared contract: a menu
     * accelerator takes its key from the window whether or not the item is
     * enabled, so a disabled Close Script does not give ⌘W back to the window
     * manager — it makes ⌘W dead everywhere else in the app.
     */
    available: () => true,
    run: (a, c) => {
      if (c.route.name === 'editor') a.closeScript();
      else a.closeWindow();
    },
  },
  'file.present': {
    id: 'file.present',
    label: 'Present',
    accelerator: 'Mod+Return',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a) => a.present(),
  },
  'file.present-prompter': {
    id: 'file.present-prompter',
    label: 'Prompter',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a) => a.present('prompter'),
  },
  'file.present-reader': {
    id: 'file.present-reader',
    label: 'Reader Window',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a) => a.present('reader'),
  },
  /*
   * ⌘⇧↩ — deliberately next to Present's ⌘↩.
   *
   * The two are the same gesture with the same precondition and differ only in
   * what the app then does with what happens, which is exactly the relationship
   * a shift modifier expresses. Availability is `file.present`'s verbatim: a
   * practice is a take, so anything that makes a take impossible makes a
   * practice impossible for the same reason, and a rehearsal offered where a
   * take is refused would be an invitation to the same failure by another name.
   */
  'file.practise': {
    id: 'file.practise',
    label: PRACTICE_LABEL,
    accelerator: 'Mod+Shift+Return',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a) => a.practise(),
  },

  // ------------------------------------------------------------------ Edit --
  /*
   * ONE Find chord, whatever the window is showing.
   *
   * ⌘F opens the search panel in the editor and focuses the Library's filter
   * field in the Library. That is not a convenience — it is what freed ⌘K,
   * which the Library used to own as "quick search" while `insert.link` also
   * claimed it for the universal editor chord.
   *
   * Two surfaces cannot share a chord here even when they are never on screen
   * at the same time: a menu accelerator is taken by the WINDOW, enabled or
   * not (see the note on `file.close-script`), so the Insert item would have
   * swallowed the Library's ⌘K in the packaged app while both looked fine in
   * the browser. Collapsing the Library's search onto Find is the fix that
   * leaves one chord per meaning rather than one chord per screen.
   */
  'edit.find': {
    id: 'edit.find',
    label: 'Find…',
    accelerator: 'Mod+F',
    dynamicLabel: (c) => (c.route.name === 'library' ? 'Find in Library…' : 'Find…'),
    available: (c) => editing(c) || c.route.name === 'library',
    run: (a) => a.find(),
  },
  'edit.find-next': {
    id: 'edit.find-next',
    label: 'Find Next',
    accelerator: 'Mod+G',
    available: (c) => editing(c),
    run: (a) => a.findNext(),
  },
  'edit.find-previous': {
    id: 'edit.find-previous',
    label: 'Find Previous',
    accelerator: 'Mod+Shift+G',
    available: (c) => editing(c),
    run: (a) => a.findPrevious(),
  },
  'edit.replace': {
    id: 'edit.replace',
    label: 'Find and Replace…',
    accelerator: 'Mod+Alt+F',
    available: (c) => editing(c),
    run: (a) => a.replace(),
  },

  // ---------------------------------------------------------------- Insert --
  /*
   * Every one of these is the SAME function the formatting row calls, reached
   * through the route command bus so it lands on the live CodeMirror view
   * (§11.4). They share `editing()`, so the whole menu greys out together the
   * moment there is no document to insert into.
   *
   * `insert.bold` and `insert.italic` carry ⌘B and ⌘I — the keys CodeMirror's
   * own keymap already answers. Naming them here is what makes them
   * discoverable; the keymap is what makes them work whether or not the menu is
   * ever opened.
   */
  'insert.heading': {
    id: 'insert.heading',
    label: 'Heading',
    available: (c) => editing(c),
    run: (a) => a.insert('heading'),
  },
  'insert.bold': {
    id: 'insert.bold',
    label: 'Bold',
    accelerator: 'Mod+B',
    available: (c) => editing(c),
    run: (a) => a.insert('bold'),
  },
  'insert.italic': {
    id: 'insert.italic',
    label: 'Italic',
    accelerator: 'Mod+I',
    available: (c) => editing(c),
    run: (a) => a.insert('italic'),
  },
  'insert.link': {
    id: 'insert.link',
    label: 'Link',
    accelerator: 'Mod+K',
    available: (c) => editing(c),
    run: (a) => a.insert('link'),
  },
  'insert.image': {
    id: 'insert.image',
    label: 'Image…',
    available: (c) => editing(c),
    run: (a) => a.insert('image'),
  },
  'insert.diagram': {
    id: 'insert.diagram',
    label: 'Diagram',
    available: (c) => editing(c),
    run: (a) => a.insert('diagram'),
  },
  'insert.cue': {
    id: 'insert.cue',
    label: 'Cue',
    available: (c) => editing(c),
    run: (a) => a.insert('cue'),
  },
  'insert.take-marker': {
    id: 'insert.take-marker',
    label: 'Part Break',
    available: (c) => editing(c),
    run: (a) => a.insert('take-marker'),
  },

  // ------------------------------------------------------------------ View --
  'view.settings': {
    id: 'view.settings',
    label: 'Settings…',
    accelerator: 'Mod+,',
    /*
     * AVAILABLE DURING A TAKE, and that is what changed when Settings became a
     * window (§14.1).
     *
     * As a ROUTE it had to be refused: opening it navigated the control window,
     * which during a take means taking the stage off the screen. As a window it
     * opens beside the take and disturbs nothing — and an operator hunting a
     * microphone fault mid-take is precisely the person who needs it.
     *
     * §14.1 states the rule directly: keep Settings available while the main
     * window is in a non-destructive session state, and disable UNSAFE CHANGES
     * during an active take. That second half belongs to the individual
     * controls, next to the thing each one would break, not to the door.
     *
     * `window.settings` is the same action from the Window menu and must agree.
     */
    available: () => true,
    run: (a) => a.settings(),
  },
  'view.library': {
    id: 'view.library',
    label: 'Show Library',
    accelerator: 'Mod+Shift+L',
    available: (c) => !presenting(c) && c.route.name !== 'library',
    run: (a) => a.showLibrary(),
  },
  'view.toggle-sidebar': {
    id: 'view.toggle-sidebar',
    label: 'Show Sidebar',
    accelerator: 'Mod+Alt+S',
    checked: (c) => c.sidebarVisible,
    // The sidebar is not rendered during a take, so the toggle would be a
    // checkmark describing something that is not on screen.
    available: (c) => !presenting(c),
    run: (a) => a.toggleSidebar(),
  },
  'view.toggle-outline': {
    id: 'view.toggle-outline',
    label: 'Show Outline',
    accelerator: 'Mod+Alt+O',
    checked: (c) => c.outlineVisible,
    available: (c) => c.route.name === 'editor' || c.route.name === 'live',
    run: (a) => a.toggleOutline(),
  },
  'view.toggle-diagnostics': {
    id: 'view.toggle-diagnostics',
    label: 'Show Diagnostics',
    accelerator: 'Mod+Alt+D',
    checked: (c) => c.diagnosticsVisible,
    available: (c) => c.route.name === 'live',
    run: (a) => a.toggleDiagnostics(),
  },
  'view.edit-mode': {
    id: 'view.edit-mode',
    label: 'Edit',
    accelerator: 'Mod+1',
    checked: (c) => c.editorLayout === 'edit',
    available: (c) => editing(c),
    run: (a) => a.setEditorLayout('edit'),
  },
  'view.preview-mode': {
    id: 'view.preview-mode',
    label: 'Preview',
    accelerator: 'Mod+2',
    checked: (c) => c.editorLayout === 'preview',
    available: (c) => editing(c),
    run: (a) => a.setEditorLayout('preview'),
  },
  'view.split-mode': {
    id: 'view.split-mode',
    label: 'Edit and Preview',
    accelerator: 'Mod+3',
    checked: (c) => c.editorLayout === 'split',
    available: (c) => editing(c),
    run: (a) => a.setEditorLayout('split'),
  },
  'view.zoom-in': {
    id: 'view.zoom-in',
    label: 'Larger Editor Text',
    dynamicLabel: (c) => (presenting(c) ? 'Larger Stage Text' : 'Larger Editor Text'),
    accelerator: 'Mod+=',
    /*
     * Editing OR presenting. The stage's type size answers the same two keys —
     * see the note on `stepScale` in `App.svelte` — and leaving this
     * editor-only meant the disabled menu item ate ⌘= during a take.
     *
     * Except on a CALIBRATED rig, which sizes its type from a measured viewing
     * distance and has nothing for this to move (§17.2, §6.3).
     */
    available: (c) => editing(c) || (presenting(c) && !c.stageRigResolved),
    run: (a) => a.stepScale(1),
  },
  'view.zoom-out': {
    id: 'view.zoom-out',
    label: 'Smaller Editor Text',
    dynamicLabel: (c) => (presenting(c) ? 'Smaller Stage Text' : 'Smaller Editor Text'),
    accelerator: 'Mod+-',
    available: (c) => editing(c) || (presenting(c) && !c.stageRigResolved),
    run: (a) => a.stepScale(-1),
  },
  'view.actual-size': {
    id: 'view.actual-size',
    label: 'Actual Size',
    accelerator: 'Mod+0',
    available: (c) => editing(c),
    run: (a) => a.stepScale(0),
  },
  'view.stage-appearance': {
    id: 'view.stage-appearance',
    label: 'Stage Appearance…',
    /*
     * LIVE ONLY, and that is a correction rather than a restriction.
     *
     * It was `live || editor`, on the reasoning that the appearance sheet is
     * useful from either. But the sheet BELONGS TO LIVE — it is the take's own
     * appearance, seeded from what the stage is prompting at right now — and the
     * editor has no such sheet to open. So the menu item was enabled on the
     * editor and did nothing at all when chosen: `dispatchRouteCommand` drops a
     * command with no listener, silently.
     *
     * §6.3's rule is to disable rather than let an impossible action fail after
     * it is invoked, and an item that fails INVISIBLY is the worst version of
     * that. The saved defaults live in Settings › Teleprompter, which is where
     * an editor-time adjustment belongs.
     */
    available: (c) => c.route.name === 'live',
    run: (a) => a.stageAppearance(),
  },

  // --------------------------------------------------------------- Session --
  'session.start-take': {
    id: 'session.start-take',
    label: 'Start Take',
    available: (c) => !presenting(c) && targetScriptId(c) !== null,
    run: (a) => a.startTake(),
  },
  'session.play-pause': {
    id: 'session.play-pause',
    label: 'Pause',
    dynamicLabel: (c) => (c.sessionPaused ? 'Resume' : 'Pause'),
    available: (c) => c.sessionActive,
    run: (a) => a.playPause(),
  },
  'session.previous-sentence': {
    id: 'session.previous-sentence',
    label: 'Previous Sentence',
    accelerator: 'Alt+Left',
    available: (c) => c.sessionActive,
    run: (a) => a.moveSentence(-1),
  },
  'session.next-sentence': {
    id: 'session.next-sentence',
    label: 'Next Sentence',
    accelerator: 'Alt+Right',
    available: (c) => c.sessionActive,
    run: (a) => a.moveSentence(1),
  },
  'session.previous-chapter': {
    id: 'session.previous-chapter',
    label: 'Previous Section',
    accelerator: 'Alt+Up',
    available: (c) => c.sessionActive,
    run: (a) => a.moveChapter(-1),
  },
  'session.next-chapter': {
    id: 'session.next-chapter',
    label: 'Next Section',
    accelerator: 'Alt+Down',
    available: (c) => c.sessionActive,
    run: (a) => a.moveChapter(1),
  },
  'session.blank-stage': {
    id: 'session.blank-stage',
    label: 'Blank Stage',
    dynamicLabel: (c) => (c.stageBlanked ? 'Show Stage' : 'Blank Stage'),
    available: (c) => c.sessionActive,
    run: (a) => a.blankStage(),
  },
  'session.toggle-mirror': {
    id: 'session.toggle-mirror',
    label: 'Mirror Stage',
    checked: (c) => c.stageMirrored,
    available: (c) => c.sessionActive,
    run: (a) => a.toggleMirror(),
  },
  'session.take-marker': {
    id: 'session.take-marker',
    label: 'Add Take Marker',
    available: (c) => c.sessionActive,
    run: (a) => a.takeMarker(),
  },
  'session.identify-displays': {
    id: 'session.identify-displays',
    label: 'Identify Displays',
    // Available at rest too: working out which physical panel is "Display 2" is
    // a thing you do while SETTING UP, not only mid-take.
    available: () => true,
    run: (a) => a.identifyDisplays(),
  },
  'session.end-take': {
    id: 'session.end-take',
    /*
     * "End Take" (CCUX-002). The one verb is still the point — this chord, the
     * menu item and the shortcuts sheet must not be three names — but the noun
     * was wrong: a session is the RECORD, and what the presenter ends is the
     * attempt they just made in front of a camera. The command's own id has
     * said `end-take` all along.
     */
    label: 'End Take',
    accelerator: 'Mod+.',
    available: (c) => c.sessionActive,
    run: (a) => a.endTake(),
  },

  // ---------------------------------------------------------------- Window --
  'window.main': {
    id: 'window.main',
    label: 'CandidCue',
    available: () => true,
    run: (a) => a.showMainWindow(),
  },
  'window.stage': {
    id: 'window.stage',
    label: 'Stage',
    /*
     * Available here, DISABLED BY RUST when no stage window exists.
     *
     * The registry cannot answer this one: whether a `stage` webview is up is a
     * fact about the process, not about the route or the session, and the
     * control window does not create it — the appearance preview and the
     * calibration wizard do, from the Settings window. `menu.rs::apply_state`
     * overrides the enabled flag from the live window list, which is the only
     * place that can be right about it.
     */
    available: () => true,
    run: (a) => a.showStageWindow(),
  },
  'window.settings': {
    id: 'window.settings',
    label: 'CandidCue Settings',
    /*
     * Always enabled, because choosing it OPENS the window if it is not there.
     * §20.4: "Bring an existing window forward instead of creating duplicates"
     * — the Window menu entry and ⌘, are the same action, and Rust enforces the
     * single instance.
     */
    available: () => true,
    run: (a) => a.settings(),
  },

  // ------------------------------------------------------------------ Help --
  'help.keyboard-shortcuts': {
    id: 'help.keyboard-shortcuts',
    label: 'Keyboard Shortcuts',
    accelerator: 'Mod+/',
    available: () => true,
    run: (a) => a.keyboardShortcuts(),
  },
  'help.setup-assistant': {
    id: 'help.setup-assistant',
    label: 'Setup Assistant',
    available: (c) => !presenting(c),
    run: (a) => a.setupAssistant(),
  },
  'help.export-support-bundle': {
    id: 'help.export-support-bundle',
    label: 'Export Support Bundle…',
    available: () => true,
    run: (a) => a.exportSupportBundle(),
  },
  'help.reveal-logs': {
    id: 'help.reveal-logs',
    label: 'Reveal Logs',
    available: () => true,
    run: (a) => a.revealLogs(),
  },
  'help.privacy': {
    id: 'help.privacy',
    label: 'Privacy and Local Processing',
    available: (c) => !presenting(c),
    run: (a) => a.privacy(),
  },
  /*
   * The web destinations, all unavailable while presenting.
   *
   * That is not tidiness. Every one of these launches a browser, which takes
   * focus, and taking focus during a take puts another application's window in
   * front of the operator while they are being filmed. The stage would keep
   * running — it is always-on-top — but the person driving it would be looking
   * at a web page.
   */
  'help.website': {
    id: 'help.website',
    label: 'CandidCue on GitHub',
    available: (c) => !presenting(c),
    run: (a) => a.openWebDestination('website'),
  },
  'help.guide': {
    id: 'help.guide',
    label: 'Project README',
    available: (c) => !presenting(c),
    run: (a) => a.openWebDestination('guide'),
  },
  'help.report-problem': {
    id: 'help.report-problem',
    label: 'Report a Problem',
    available: (c) => !presenting(c),
    run: (a) => a.openWebDestination('support'),
  },
  'help.release-notes': {
    id: 'help.release-notes',
    label: 'Release Notes',
    available: (c) => !presenting(c),
    run: (a) => a.openWebDestination('release-notes'),
  },
  'help.download': {
    id: 'help.download',
    label: 'Download Latest Version',
    available: (c) => !presenting(c),
    run: (a) => a.openWebDestination('download'),
  },
  'help.notices': {
    id: 'help.notices',
    label: 'Third-Party Notices',
    available: (c) => !presenting(c),
    run: (a) => a.thirdPartyNotices(),
  },
};

/**
 * Run a command, re-checking availability first.
 *
 * The second check is not belt-and-braces. The native menu's enabled flags were
 * pushed some milliseconds ago — a take can end, a script can close, and a save
 * can fail between the push and the click — and the menu has no way to know.
 * Returns false when the command stood down, so a caller that wants to explain
 * itself can.
 */
export function runCommand(
  id: CommandId,
  actions: CommandActions,
  context: CommandContext,
): boolean {
  const command = COMMANDS[id];
  if (!command.available(context)) return false;
  command.run(actions, context);
  return true;
}

/**
 * The whole menu's state, for one `set_menu_state` push.
 *
 * Every command every time, rather than a diff. A diff would mean the menu's
 * correctness depended on the frontend's memory of what it last sent, and the
 * one bug that model produces — a stale item nobody re-sent — is invisible until
 * somebody clicks the thing that should have been greyed out.
 */
export function menuStateFor(context: CommandContext): MenuItemState[] {
  return COMMAND_IDS.map((id) => {
    const command = COMMANDS[id];
    const state: MenuItemState = { id, enabled: command.available(context) };
    if (command.checked) state.checked = command.checked(context);
    const label = command.dynamicLabel?.(context);
    if (label !== null && label !== undefined) state.label = label;
    return state;
  });
}

/**
 * Render an accelerator for the platform it will be pressed on (§25.3).
 *
 * macOS uses the glyphs because that is what macOS menus show and what users
 * scan for; everywhere else uses words, because Windows and Linux menus do. The
 * order is the platform's too — macOS is ⌃⌥⇧⌘, Windows is Ctrl+Alt+Shift.
 */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parts = accelerator.split('+');
  const key = parts[parts.length - 1] ?? '';
  const modifiers = new Set(parts.slice(0, -1));

  const displayKey = (() => {
    switch (key) {
      case 'Return':
        return isMac ? '⏎' : 'Enter';
      case 'Left':
        return '←';
      case 'Right':
        return '→';
      case 'Up':
        return '↑';
      case 'Down':
        return '↓';
      case '=':
        return '+';
      default:
        return key.length === 1 ? key.toUpperCase() : key;
    }
  })();

  if (isMac) {
    let out = '';
    if (modifiers.has('Ctrl')) out += '⌃';
    if (modifiers.has('Alt')) out += '⌥';
    if (modifiers.has('Shift')) out += '⇧';
    if (modifiers.has('Mod')) out += '⌘';
    return out + displayKey;
  }

  const words: string[] = [];
  if (modifiers.has('Mod')) words.push('Ctrl');
  if (modifiers.has('Ctrl')) words.push('Ctrl');
  if (modifiers.has('Alt')) words.push('Alt');
  if (modifiers.has('Shift')) words.push('Shift');
  words.push(displayKey);
  return words.join('+');
}

/** Commands grouped by menu, for the Shortcuts dialog. */
export function commandsByCategory(): Array<{
  category: CommandCategory;
  commands: CommandDefinition[];
}> {
  const order: CommandCategory[] = [
    'file',
    'edit',
    'insert',
    'view',
    'session',
    'window',
    'help',
  ];
  return order
    .map((category) => ({
      category,
      commands: COMMAND_IDS.map((id) => COMMANDS[id]).filter(
        (command) => menuCategory(command.id) === category,
      ),
    }))
    .filter((group) => group.commands.length > 0);
}

/** Settings sections, so `view.settings` can restore the last one. */
export function isSettingsSection(value: string): value is SettingsSection {
  return (
    value === 'general' ||
    value === 'speech' ||
    value === 'audio' ||
    value === 'stage' ||
    value === 'teleprompter' ||
    value === 'following' ||
    value === 'privacy'
  );
}
