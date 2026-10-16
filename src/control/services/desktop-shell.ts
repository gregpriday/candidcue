/**
 * The bridge between the application and its native window chrome
 * (desktop refinement §5, §6, §20.4).
 *
 * Three one-way pushes and one inbound event:
 *
 *   out  the native menu's enabled/checked/label state, whenever it can change;
 *   out  the window title, whenever the open document or route changes;
 *   out  a forced window-frame write at moments Rust's own debounce would miss;
 *   in   `menu://command`, when the user picks something from the menu bar.
 *
 * Everything here degrades to nothing outside Tauri. `pnpm dev` in a browser has
 * no menu bar and no window title worth setting, and a service that threw there
 * would make the whole frontend untestable in the environment the Playwright
 * suite runs in.
 */
import {
  COMMAND_IDS,
  MENU_COMMAND_EVENT,
  type CommandId,
  type MenuItemState,
} from '../../shared/contracts/commands';
import {
  COMMANDS,
  menuStateFor,
  runCommand,
  type CommandActions,
  type CommandContext,
  type WebDestination,
} from '../lib/commands';
import { ipcInvoke, isTauriRuntime } from './ipc';

/**
 * The last state actually sent, so an identical one is not sent again.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT AN OPTIMISATION
 * ---------------------------------------------------------------------------
 * The shell's `commandContext` is a `$derived` over whole stores, and during a
 * take the session store updates about ten times a second (the voice pill's
 * cadence). Dragging a pane divider invalidates it on every pointer frame.
 * Without this guard each of those became a real IPC round trip that walked
 * ~45 menu items and called three native setters on each — during a take, on
 * the thread that is also driving the glass.
 *
 * It is also a CORRECTNESS guard. These calls are fire-and-forget, so two in
 * flight can complete out of order and leave the menu showing the older of two
 * states. Sending only on change makes that vanishingly rare, and the serialised
 * queue below makes it impossible WITHIN ONE WINDOW.
 *
 * Across windows it cannot: each webview is its own JavaScript realm with its
 * own queue, and Rust accepts a state push without being told which window sent
 * it. What keeps the two from fighting is `windowHasFocus` — only the window in
 * front describes the menu — and that is a policy rather than a proof. A push
 * admitted while focused is re-checked before each IPC call below, so a window
 * that loses focus mid-queue stops rather than finishing a description of a
 * window nobody is looking at.
 */
let lastMenuJson: string | null = null;
/**
 * Whether THIS window is the one in front.
 *
 * ---------------------------------------------------------------------------
 * WHY A PUSH HAS TO ASK
 * ---------------------------------------------------------------------------
 * The menu bar is one object and two windows describe it. The control window
 * pushes whenever its command context changes — which during a take is about
 * ten times a second — and none of that is an instruction to the menu while
 * Settings is the window in front. Without this gate a background take
 * repeatedly overwrote the Settings window's menu with the take's, so File
 * flickered between "Close Window" and a set of items about a document nobody
 * could see.
 *
 * Starts `true` and is only ever corrected by a real focus event: a window that
 * never installed the listener — recovery, browser dev, a webview whose focus
 * events are unavailable — must go on pushing rather than fall silent, because
 * a menu that is never described is entirely grey.
 *
 * The consequences of that default, said plainly. A window that never receives
 * a focus event keeps pushing while it is in the background — the pre-existing
 * behaviour, and the one that fails safe. A window that observes a blur and
 * then misses the matching focus stops pushing until the next focus arrives;
 * the menu it leaves behind is the other window's, which is the window the user
 * is looking at. Neither is a deadlock, and the second is the failure worth
 * having.
 */
let windowHasFocus = true;
/** One push at a time; the newest pending state wins. */
let menuPushInFlight: Promise<void> | null = null;
let menuPushQueued: string | null = null;
/** Logged once — a persistent failure must not fill the log at 10 Hz. */
let menuFailureLogged = false;

/**
 * Push menu state.
 *
 * Failures are swallowed after one log. A menu whose greying is a beat stale is
 * a cosmetic problem — `runCommand` re-checks availability before it acts, so a
 * stale-enabled item still cannot do the impossible — and a toast every time an
 * IPC hiccup ate a state push would be noise about nothing the user can fix.
 */
export async function pushMenuState(context: CommandContext): Promise<void> {
  if (!isTauriRuntime()) return;
  /* Not while another window is in front — see `windowHasFocus`. */
  if (!windowHasFocus) return;
  const items: MenuItemState[] = menuStateFor(context);
  const json = JSON.stringify(items);
  if (json === lastMenuJson) return;
  lastMenuJson = json;

  if (menuPushInFlight !== null) {
    // Replace whatever was waiting: only the newest state is worth sending.
    menuPushQueued = json;
    return;
  }
  menuPushInFlight = drainMenuPush(json);
  await menuPushInFlight;
}

async function drainMenuPush(first: string): Promise<void> {
  let payload: string | null = first;
  try {
    while (payload !== null) {
      const items = JSON.parse(payload) as MenuItemState[];
      payload = null;
      /* Focus can move while a queue drains, and a state that was true when it
         was admitted describes the wrong window by the time it is sent. */
      if (!windowHasFocus) {
        menuPushQueued = null;
        return;
      }
      try {
        await ipcInvoke('set_menu_state', { items });
      } catch (err) {
        if (!menuFailureLogged) {
          menuFailureLogged = true;
          console.debug('menu state could not be pushed', err);
        }
      }
      if (menuPushQueued !== null) {
        payload = menuPushQueued;
        menuPushQueued = null;
      }
    }
  } finally {
    menuPushInFlight = null;
  }
}

/**
 * Push the menu state for a window that is NOT the document window.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND ENTRY POINT RATHER THAN A SECOND CONTEXT
 * ---------------------------------------------------------------------------
 * A macOS menu bar belongs to the application and describes whatever window is
 * in front. `pushMenuState` above answers that question for the control window,
 * from a `CommandContext` built out of the route, the library and the session —
 * none of which exist in the Settings window. Handing it a fabricated context
 * would mean inventing a route Settings is not on and a script it does not
 * have, and the answer would still be wrong: the question is not "what is the
 * app doing" but "what can THIS window do".
 *
 * So Settings names its own short list. Everything absent from it is disabled,
 * which is the honest reading — with Settings in front there is no document to
 * save, no script to present and no take to end, and a menu that offered those
 * would be describing a window the user cannot see.
 *
 * `Close Window` stays enabled for the reason `file.close-script` documents:
 * a disabled item does not give its accelerator back to the window manager, it
 * makes the chord dead. ⌘W has to be answered by the window it is pressed over.
 */
export async function pushWindowMenuState(enabled: readonly CommandId[]): Promise<void> {
  if (!isTauriRuntime()) return;
  /* Not while another window is in front — see `windowHasFocus`. */
  if (!windowHasFocus) return;
  const wanted = new Set<string>(enabled);
  const items: MenuItemState[] = COMMAND_IDS.map((id) => ({
    id,
    enabled: wanted.has(id),
    checked: false,
    /*
     * The label this window would give it, not the base one.
     *
     * `file.close-script` reads "Close Script" in an editor and "Close Window"
     * everywhere else, and everywhere else includes here — there is no script
     * in this window to close. Sending the base label put "Close Script" in the
     * menu over a window that has never had one.
     */
    label: labelForWindow(id),
  }));
  const json = JSON.stringify(items);
  if (json === lastMenuJson) return;
  lastMenuJson = json;
  if (menuPushInFlight !== null) {
    menuPushQueued = json;
    return;
  }
  menuPushInFlight = drainMenuPush(json);
  await menuPushInFlight;
}

/**
 * What a command is CALLED in a window that has no route.
 *
 * `dynamicLabel` takes a `CommandContext` — a route, a library, a session —
 * none of which exist here. Rather than fabricate one, the two labels that
 * actually vary are answered directly: Close Script is Close Window without a
 * document, and Find is Find in Settings.
 */
function labelForWindow(id: CommandId): string {
  if (id === 'file.close-script') return 'Close Window';
  if (id === 'edit.find') return 'Find in Settings…';
  return COMMANDS[id].label;
}

/**
 * The commands the Settings window answers.
 *
 * Deliberately tiny, and deliberately not "everything Settings might one day
 * want". Each of these has a handler in `PreferencesApp.svelte`; a command
 * listed here without one would be an enabled menu item that does nothing,
 * which is worse than a greyed one.
 */
export const PREFERENCES_COMMANDS = [
  'file.close-script',
  /*
   * Window › Stage, because RUST enables it whatever this list says.
   *
   * `menu.rs::apply_state` overrides this item from the live window list — no
   * renderer knows whether a stage window exists — so leaving it out of here
   * did not disable it, it made it an enabled item with no handler in the
   * window that was in front. Listing it is what gives it one.
   */
  'window.stage',
  /* ⌘F is the Search settings field in the toolbar — the same "find in what
     this window is showing" the Library and the editor answer. */
  'edit.find',
  'window.main',
  'window.settings',
  'view.settings',
  'help.reveal-logs',
] as const satisfies readonly CommandId[];

/**
 * Receive the native menu commands addressed to THIS window, and no others.
 *
 * `menu.rs::command_target` decides which window a command is for and delivers
 * it with `emit_to(label, …)`. Listening with the global `listen()` from
 * `@tauri-apps/api/event` undid that: with no target it registers as
 * `{ kind: 'Any' }`, and Tauri hands an `emit_to` to every `Any` listener
 * whatever label it named. Both windows then ran every command — ⌘W over
 * Settings closed Settings AND the script in the editor behind it.
 *
 * Listening on the current webview window registers
 * `{ kind: 'WebviewWindow', label }`, which an `emit_to` matches only when it
 * names this window. The fallback over the stage still arrives, because Rust
 * addresses those commands to `control` by name.
 *
 * One subscription for both installers so the choice is made once. Do not copy
 * the global-`listen` pattern of the other inbound events here: several of
 * those (the Settings window's model-download progress among them) rely on
 * hearing events addressed to another window.
 */
function listenForMenuCommands(onId: (id: unknown) => void): () => void {
  if (!isTauriRuntime()) return () => {};

  let disposed = false;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const stop = await getCurrentWebviewWindow().listen<{ id: string }>(
        MENU_COMMAND_EVENT,
        (event) => onId(event.payload?.id),
      );
      if (disposed) stop();
      else unlisten = stop;
    } catch (err) {
      console.warn('native menu commands are not connected', err);
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Answer native menu commands in a window that is not the document window.
 *
 * `installMenuCommands` runs the command registry, which needs the whole
 * application context; this one takes a plain map and ignores every id that is
 * not in it. That difference matters because Rust delivers a menu command to
 * the FOCUSED window (`menu.rs::command_target`): the Settings window really
 * does receive Insert › Link when it is in front, and the right response is to
 * do nothing rather than to reach into a hidden editor.
 */
export function installWindowMenuCommands(
  handlers: Partial<Record<CommandId, () => void>>,
): () => void {
  return listenForMenuCommands((id) => {
    if (typeof id !== 'string') return;
    handlers[id as CommandId]?.();
  });
}

/**
 * Re-push this window's menu state whenever it comes to the front.
 *
 * The menu is one shared object with two windows describing it, so the last
 * push wins and "the last push" is not the same as "the front window". Without
 * this, switching from Settings back to the document window left the menu
 * describing Settings — every File item greyed over an open script — until
 * something happened to invalidate the control window's command context.
 *
 * The dedupe in `pushMenuState` is defeated on purpose here: the state has not
 * changed from this window's point of view, and it is exactly the state that
 * needs sending again.
 */
export function installMenuStateOnFocus(push: () => void): () => void {
  if (!isTauriRuntime()) return () => {};

  let disposed = false;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const stop = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        windowHasFocus = focused;
        if (!focused) return;
        lastMenuJson = null;
        push();
      });
      if (disposed) stop();
      else unlisten = stop;
    } catch (err) {
      console.debug('window focus is not observable', err);
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Test seam: forget what was last sent, so the next push is unconditional. */
export function resetMenuStateForTesting(): void {
  lastMenuJson = null;
  windowHasFocus = true;
  menuPushQueued = null;
  menuPushInFlight = null;
  menuFailureLogged = false;
  lastTitleKey = null;
  titleFailureLogged = false;
}

/**
 * The window's title, and the macOS document-modified dot.
 *
 * The title is composed here rather than in the component that knows the script,
 * so every route produces a title in the same shape and nothing has to remember
 * to append the product name. The em dash and the ordering are the platform
 * convention on both: document first, application last, because the task
 * switcher truncates from the right.
 */
export function composeWindowTitle(input: {
  routeName: string;
  scriptTitle: string | null;
  libraryView?: 'all' | 'recent' | 'trash';
  sessionActive: boolean;
}): string {
  if (input.sessionActive && input.scriptTitle) {
    // A running take names itself, because during one the window IS the stage
    // and the operator switching to it wants to know which take is live.
    return `${input.scriptTitle} — Take in progress`;
  }
  switch (input.routeName) {
    case 'editor':
      return input.scriptTitle ? `${input.scriptTitle} — CandidCue` : 'CandidCue';
    case 'settings':
      return 'CandidCue Settings';
    case 'calibrate':
      return 'Display Calibration — CandidCue';
    case 'welcome':
      return 'Welcome to CandidCue';
    case 'library':
      switch (input.libraryView) {
        case 'trash':
          return 'Trash — CandidCue';
        case 'recent':
          return 'Recent — CandidCue';
        default:
          return 'Library — CandidCue';
      }
    default:
      return 'CandidCue';
  }
}

let lastTitleKey: string | null = null;
let titleFailureLogged = false;

/**
 * Set the window title, only when it has actually changed.
 *
 * Same reason as the menu: the caller is a `$derived` over the session store,
 * which ticks about ten times a second during a take. Setting an unchanged title
 * is not free — on macOS it is an AppKit call that redraws the titlebar — and
 * the modified dot flickering at 10 Hz was visible.
 */
export async function pushWindowTitle(title: string, edited: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  const key = `${edited ? '1' : '0'} ${title}`;
  if (key === lastTitleKey) return;
  lastTitleKey = key;
  try {
    await ipcInvoke('set_window_title', { title, edited });
  } catch (err) {
    if (!titleFailureLogged) {
      titleFailureLogged = true;
      console.debug('the window title could not be set', err);
    }
  }
}

/**
 * Open the Settings window, or bring it forward (§14.1).
 *
 * Single-instance is enforced in Rust (`windows/preferences.rs`), not here: a
 * renderer that asks twice gets the same window both times, and no renderer can
 * create a second one.
 */
export async function openPreferences(): Promise<void> {
  if (!isTauriRuntime()) return;
  await ipcInvoke('open_preferences');
}

/** Close the Settings window, from inside it. */
export async function closePreferences(): Promise<void> {
  if (!isTauriRuntime()) return;
  await ipcInvoke('close_preferences');
}



/**
 * Bring one of the application's windows forward (the Window menu).
 *
 * RUST does it. `getCurrentWindow().setFocus()` is the obvious call and it does
 * not work: `core:window:default` grants the window plugin's read half and
 * neither `allow-set-focus` nor `allow-unminimize`, so the call is rejected by
 * the ACL — inside a `try` that had been reading the rejection as "this is
 * browser dev". Window › CandidCue was a silent no-op for exactly that reason.
 *
 * See `focus_app_window` in `shell_cmds.rs` for why the capability is not
 * simply widened instead.
 */
export async function focusAppWindow(target: 'control' | 'stage'): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await ipcInvoke('focus_app_window', { target });
  } catch (err) {
    console.debug('a window could not be focused', err);
  }
}

/** Reveal the log directory (Help › Reveal Logs). */
export async function revealLogs(): Promise<void> {
  await ipcInvoke('reveal_logs');
}

/**
 * Open one of CandidCue's own pages in the browser (Help › the website group).
 *
 * The payload is a NAME. Rust holds the table that turns it into a URL under a
 * single compile-time origin (`src-tauri/src/web.rs`), which is what lets the
 * control window keep having no permission to open an arbitrary address — the
 * `opener:default` grant was removed in the 1.0 readiness pass and this is
 * deliberately not a way to get it back.
 */
export async function openWebDestination(destination: WebDestination): Promise<void> {
  await ipcInvoke('open_web_destination', { name: destination });
}

/** Open the third-party notices this build shipped with (Help › Licences). */
export async function openThirdPartyNotices(): Promise<void> {
  await ipcInvoke('open_third_party_notices');
}

/** Rust → control, from `windows/drag_drop.rs`. */
export const DRAG_HOVER_EVENT = 'app://drag-hover';
export const DRAG_IMPORTED_EVENT = 'app://drag-imported';

export interface DragHoverPayload {
  active: boolean;
  /** How many hovering files Rust would accept. Zero means "not this kind". */
  accepted: number;
  /** The set contains images AND a script is open to receive them. */
  acceptsImages: boolean;
}

export interface DragImportedPayload {
  scriptId: string | null;
  imported: number;
  /** File NAMES only — Rust never sends the renderer a path (§50.7). */
  failed: string[];
  rejected: string[];
  warnings: string[];
  /** Markdown for images that landed in the open script's asset folder. */
  images: string[];
  /**
   * The script those images were imported INTO.
   *
   * The renderer refuses to insert them anywhere else: importing is slow enough
   * for the route to change while it runs, and a reference written into a
   * different script points at an asset that script does not own.
   */
  imageScriptId: string | null;
}

/**
 * Tell Rust which script a dropped image belongs to.
 *
 * A script id, not a path — see `windows/drag_drop.rs`. Pushed when the editor
 * opens a document and cleared when it leaves, so an image dropped on the
 * Library is refused rather than filed into whatever was last edited.
 */
export async function setDropTargetScript(scriptId: string | null): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await ipcInvoke('set_drop_target_script', { scriptId });
  } catch (err) {
    console.debug('the drop target could not be set', err);
  }
}

/**
 * Listen for dropped files.
 *
 * The renderer's whole part in drag-and-drop is drawing the target and reporting
 * the outcome. It is not told where the files came from and cannot ask for one —
 * see `windows/drag_drop.rs` for why that separation is not optional.
 */
export function installDragDrop(handlers: {
  onhover: (payload: DragHoverPayload) => void;
  onimported: (payload: DragImportedPayload) => void;
}): () => void {
  if (!isTauriRuntime()) return () => {};

  let disposed = false;
  const stops: Array<() => void> = [];

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const hover = await listen<DragHoverPayload>(DRAG_HOVER_EVENT, (event) =>
        handlers.onhover(event.payload),
      );
      const imported = await listen<DragImportedPayload>(DRAG_IMPORTED_EVENT, (event) =>
        handlers.onimported(event.payload),
      );
      if (disposed) {
        hover();
        imported();
      } else {
        stops.push(hover, imported);
      }
    } catch (err) {
      console.warn('drag-and-drop import is not connected', err);
    }
  })();

  return () => {
    disposed = true;
    for (const stop of stops) stop();
  };
}

/**
 * Listen for the native menu commands addressed to the document window.
 *
 * `context()` and `actions()` are read at DISPATCH TIME rather than captured, so
 * the handler always acts on the application as it is when the item was clicked
 * — not as it was when the shell mounted. That is the whole reason they are
 * thunks: a menu bar outlives every route.
 */
export function installMenuCommands(
  context: () => CommandContext,
  actions: () => CommandActions,
): () => void {
  return listenForMenuCommands((id) => {
    if (typeof id !== 'string' || !(id in COMMANDS)) {
      // A menu carrying an id this build does not know is a version skew
      // between the packaged binary and the bundled frontend. Logged, not
      // toasted: the user did nothing wrong and can do nothing about it.
      console.warn('a native menu sent an unknown command', id);
      return;
    }
    runCommand(id as CommandId, actions(), context());
  });
}
