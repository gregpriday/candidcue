/**
 * The application command vocabulary (desktop refinement §6.1).
 *
 * ---------------------------------------------------------------------------
 * ONE ID PER ACTION, AND EVERY SURFACE DERIVES FROM IT
 * ---------------------------------------------------------------------------
 * Before this file the app had two independent action vocabularies: the
 * `ShortcutAction` union in `control/lib/shortcuts.ts`, and whatever each route
 * happened to wire to a button. There was no native menu at all, so nothing
 * forced them to agree — a command could exist as a key and not as a control, or
 * as a control and not as a key, and no test could see the gap.
 *
 * A native menu changes that, because a menu is a PUBLISHED list of what the
 * application can do, with the key beside each entry. It cannot be allowed to
 * drift from what the keys and buttons actually do. So the ids below are the one
 * name for each action, and three surfaces are keyed to them:
 *
 *   - `src-tauri/src/menu.rs`  spells these ids again in Rust, with a label and
 *     an accelerator for each. It does NOT read this file at build time — it
 *     cannot, it is a different language — so what holds the two together is a
 *     pair of tests that `include_str!` this file and `commands.ts` and compare
 *     the id sets and the accelerator sets IN BOTH DIRECTIONS
 *   - `src/control/lib/commands.ts`  binds each id to its execution + availability
 *   - `src/control/components/ShortcutsDialog.svelte`  derives its menu tables
 *     from that registry
 *
 * The ids are string literals rather than a generated enum because Rust has to
 * spell them too, and a Rust test `include_str!`s THIS FILE to assert the two
 * sides still agree (`menu.rs`, `menu_ids_match_typescript_contract`). Keep them
 * grep-able: no interpolation, no computed names.
 *
 * Naming is `category.action`, and the category is the menu the command lives
 * in. That is not decoration — `menuCategory()` reads it, so a command cannot be
 * filed in the menu its id does not name.
 */

/**
 * Every command the application publishes.
 *
 * DELIBERATELY NOT every action the app can perform. A command here appears in
 * the native menu, so each one has to be a thing a user would look for by name,
 * has to be answerable from a menu (no "the control you are hovering"), and has
 * to have an honest disabled state. Transport nudges that only make sense with a
 * hand on the keyboard mid-take stay as plain shortcuts.
 */
export const COMMAND_IDS = [
  // ---- File ----
  'file.new-script',
  'file.import-markdown',
  'file.save',
  'file.duplicate-script',
  'file.rename-script',
  'file.export-markdown',
  'file.reveal-script',
  'file.move-to-trash',
  /**
   * ⌘W, and it is always enabled — which is a deliberate departure from the
   * "disable rather than fail" rule two paragraphs below.
   *
   * A menu accelerator CLAIMS its key from the window: registering ⌘W as "Close
   * Script" and disabling it outside the editor does not hand ⌘W back to the
   * window manager, it makes ⌘W do nothing at all on every other screen. On
   * macOS that is a key every user expects to close a window, so the command
   * covers both meanings: close the open script when one is open, close the
   * window otherwise — and the window close is the ordinary close, so it still
   * runs the save/session shutdown handshake in `windows/shutdown.rs`.
   */
  'file.close-script',
  'file.present',
  'file.present-prompter',
  'file.present-reader',
  /**
   * Rehearse the script in a window, following the voice, reporting nothing.
   *
   * A separate command rather than a third row under "Present As" because it
   * is not a third shape for the window — it is a different ANSWER to a
   * different question. "Present As" asks how the take should be displayed;
   * this one answers whether what is about to happen is a take at all. The
   * two are composed, not ranked: a practice is always in a window, which is
   * what makes it a practice rather than a take somebody labelled one.
   */
  'file.practise',

  // ---- Edit ----
  // Undo/Redo/Cut/Copy/Paste/Select All are Tauri PREDEFINED menu items and are
  // not listed here: predefined items are dispatched by the OS to the focused
  // native control, which is the only way they can target CodeMirror, a text
  // field and a search box correctly without the app guessing which has focus.
  'edit.find',
  'edit.find-next',
  'edit.find-previous',
  'edit.replace',

  // ---- Insert ----
  // §11.4: "Add a clearly discoverable Insert menu in the native menu bar."
  // These are the same commands the editor's formatting row runs, so the two
  // surfaces cannot come to mean different things — and the menu is what gives
  // them names and keys a user can find without hovering every button.
  'insert.heading',
  'insert.bold',
  'insert.italic',
  'insert.link',
  'insert.image',
  'insert.diagram',
  'insert.cue',
  'insert.take-marker',

  // ---- View ----
  /**
   * Settings, which on macOS lives in the application menu under ⌘, rather than
   * under View — but is filed here because `menuCategory` reads the prefix and
   * there is no `app.` menu on the other platforms. The prefix decides which
   * menu the SHORTCUTS DIALOG groups it under; `menu.rs` decides where the
   * native item is placed, and on macOS that is the application menu.
   */
  'view.settings',
  'view.library',
  'view.toggle-sidebar',
  'view.toggle-outline',
  'view.toggle-diagnostics',
  'view.edit-mode',
  'view.preview-mode',
  'view.split-mode',
  'view.zoom-in',
  'view.zoom-out',
  'view.actual-size',
  'view.stage-appearance',

  // ---- Session ----
  'session.start-take',
  'session.play-pause',
  'session.previous-sentence',
  'session.next-sentence',
  'session.previous-chapter',
  'session.next-chapter',
  'session.blank-stage',
  'session.toggle-mirror',
  'session.identify-displays',
  'session.end-take',

  // ---- Window ----
  'window.main',
  /**
   * The Settings window (§20.4).
   *
   * Always LISTED, and always enabled, because choosing it opens the window
   * when there is none — the menu entry and ⌘, are the same action.
   */
  'window.settings',
  /**
   * The Stage window, ENABLED while one exists (§13.4).
   *
   * Listed always — a menu whose items appear and disappear is harder to learn
   * than one whose items grey out — and enabled only when there is a window to
   * bring forward.
   *
   * Production presentation is single-window — the control window becomes the
   * prompter — so most of the time there is no separate stage to list. A real
   * `stage` webview does still get created: by the appearance preview in
   * Settings, and by the calibration wizard. While one of those is up it is a
   * window of this application that the Window menu was silent about.
   *
   * Its enabled state is decided in RUST rather than here, because Rust is the
   * only place that knows whether the window exists — see `menu.rs::apply_state`.
   * The registry entry stays available so that choosing it always does what it
   * says; a menu item the user can reach is one Rust has already decided to
   * enable.
   */
  'window.stage',
  /*
   * NO `window.reopen-stage`.
   *
   * §13.4 also asks for Reopen Stage, and that is a genuine gap rather than a
   * moot one. Recovering a lost stage today means ending the take and
   * presenting again, which is what `Live.svelte` tells the operator to do. A
   * real reopen has to re-enter the presentation state machine mid-take
   * (`windows/present.rs`), and §29.6 is explicit that it should not be
   * disturbed casually. It wants its own change, with its own tests — and an
   * enabled menu item that did nothing would be worse than its absence.
   */

  // ---- Help ----
  'help.keyboard-shortcuts',
  'help.setup-assistant',
  'help.export-support-bundle',
  'help.reveal-logs',
  'help.privacy',
  // The website. Each of these asks Rust for a NAMED destination, never a url —
  // `src-tauri/src/web.rs` owns the mapping, and the webview has no permission
  // to open an address of its own choosing.
  'help.website',
  'help.guide',
  'help.report-problem',
  'help.release-notes',
  'help.download',
  // The one that is not a website: the notices this build shipped, opened from
  // inside the bundle.
  'help.notices',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

/** The native menu a command belongs to. */
export type CommandCategory =
  | 'file'
  | 'edit'
  | 'insert'
  | 'view'
  | 'session'
  | 'window'
  | 'help';

/**
 * The menu a command lives in, read off its own id.
 *
 * Derived rather than declared so a command cannot be filed under one menu and
 * named for another — the failure mode that makes a menu untrustworthy is an
 * entry not being where its name says it is.
 */
export function menuCategory(id: CommandId): CommandCategory {
  return id.slice(0, id.indexOf('.')) as CommandCategory;
}

/**
 * Rust → control: a native menu item was chosen.
 *
 * One event for the whole menu rather than one per command. The payload names
 * the command, the frontend registry decides what that means right now, and the
 * SAME guard that a visible button goes through runs — which is the property
 * that stops a menu item being a second, unguarded way to leave a running take.
 */
export const MENU_COMMAND_EVENT = 'menu://command';

/**
 * The enabled/checked state of one native menu item.
 *
 * Pushed control → Rust (`set_menu_state`) whenever route or session state
 * changes. Rust holds the menu handles and can only be told; it has no view of
 * which script is open or whether a take is running, and giving it one would
 * mean two implementations of "can this happen now".
 */
export interface MenuItemState {
  id: CommandId;
  enabled: boolean;
  /** Present only for commands that show a checkmark (toggles and modes). */
  checked?: boolean;
  /**
   * A label that changes with state — Pause becomes Resume, Blank becomes
   * Unblank. Absent means "keep the label the menu was built with".
   */
  label?: string;
}
