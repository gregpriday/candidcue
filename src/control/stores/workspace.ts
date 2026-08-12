/**
 * Where the panes are, and how wide (desktop refinement §21).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN `settings`
 * ---------------------------------------------------------------------------
 * Everything in `stores/settings.ts` is Rust-backed, revisioned, and part of a
 * document the user can export and restore. That is right for preferences —
 * things somebody chose and would be annoyed to lose — and wrong for this.
 *
 * Pane geometry is not a preference; it is where you left the furniture. It
 * changes many times a minute while somebody drags a divider, it means nothing
 * on another machine, and losing it costs one drag. Putting it through the
 * settings pipeline would mean a revisioned database write per pointer-move
 * frame, a migration for every new pane, and a `patchSettings` conflict toast
 * raised at somebody who was only resizing a rail.
 *
 * So it lives in `localStorage`, which is per-machine, survives relaunch, and
 * costs nothing to write. The one piece of window state that genuinely CANNOT
 * live here is the window's own frame: it has to be applied before the webview
 * exists, so Rust owns it (`commands/shell_cmds.rs`).
 *
 * ---------------------------------------------------------------------------
 * EVERY FIELD IS CLAMPED ON READ
 * ---------------------------------------------------------------------------
 * `localStorage` is user-writable, survives a downgrade, and is the one input to
 * this app that no schema check protects. A stored sidebar width of 40000 is a
 * workspace with no workspace in it, and a stored `NaN` is a layout that never
 * paints. `readState` therefore treats what it finds as a suggestion: every
 * number goes through `clamp`, every enum through an allow-list, and anything
 * unrecognised falls back to the default rather than being kept.
 */
import { writable, type Readable } from 'svelte/store';

/*
 * NOT shared between windows, and not watched for `storage` events.
 *
 * This is pane geometry: which rails are open, how wide they are, the
 * editor/preview split. Adopting another window's copy would move panes under
 * somebody's hands, and there is nothing here a second window edits. The
 * overlay that DOES need cross-window sync is the settings overlay in
 * `services/settings.ts`, which is a different key for a different reason.
 *
 * `settingsSection` is the one field two windows both touch, and it is handed
 * over deliberately — written and flushed before the window opens, and
 * broadcast when it is already open — rather than by watching storage.
 */
const STORAGE_KEY = 'candidcue.workspace.v1';

/** Which panes each route can show, and the range each may be dragged to. */
export const PANE_LIMITS = {
  sidebar: { min: 180, max: 360, default: 224 },
  editorOutline: { min: 200, max: 420, default: 264 },
  editorSplit: { min: 0.25, max: 0.75, default: 0.5 },
  liveOutline: { min: 160, max: 360, default: 220 },
  liveDiagnostics: { min: 240, max: 480, default: 304 },
  librarySidebar: { min: 260, max: 520, default: 320 },
} as const;

export type PaneName = keyof typeof PANE_LIMITS;

/** Editor workspace modes. `split` is the one this refinement adds. */
export type EditorLayout = 'edit' | 'preview' | 'split';

const EDITOR_LAYOUTS: readonly EditorLayout[] = ['edit', 'preview', 'split'];

export interface WorkspaceState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  outlineVisible: boolean;
  outlineWidth: number;
  /** The Library's selection inspector. Off by default — see §10.3. */
  inspectorVisible: boolean;
  inspectorWidth: number;
  diagnosticsVisible: boolean;
  diagnosticsWidth: number;
  liveOutlineWidth: number;
  editorLayout: EditorLayout;
  /** Editor/preview split position as a fraction of the available width. */
  editorSplitRatio: number;
  /**
   * Editor and preview text scale, as a multiplier (§11.3).
   *
   * DELIBERATELY NOT the stage's font size, and the View menu labels say so:
   * "Larger Editor Text", never "Zoom In". A teleprompter user who reads "Zoom
   * In" means the glass, and the glass is governed by optical calibration
   * against a real viewing distance — a menu item that quietly changed it would
   * undo a measurement somebody took with a tape.
   */
  documentScale: number;
  /**
   * Library row density (§10.1).
   *
   * `comfortable` shows one line of excerpt in a 52px row; `compact` drops the
   * excerpt for a 38px one. Offered rather than imposed because the right answer
   * depends entirely on how many scripts somebody has — twelve scripts want the
   * excerpt, four hundred want to be scannable.
   */
  libraryDensity: 'comfortable' | 'compact';
  /** The Settings section to reopen at. */
  settingsSection: string;
}

export const DEFAULT_WORKSPACE: WorkspaceState = {
  sidebarVisible: true,
  sidebarWidth: PANE_LIMITS.sidebar.default,
  outlineVisible: true,
  outlineWidth: PANE_LIMITS.editorOutline.default,
  inspectorVisible: false,
  inspectorWidth: PANE_LIMITS.librarySidebar.default,
  diagnosticsVisible: true,
  diagnosticsWidth: PANE_LIMITS.liveDiagnostics.default,
  liveOutlineWidth: PANE_LIMITS.liveOutline.default,
  editorLayout: 'edit',
  editorSplitRatio: PANE_LIMITS.editorSplit.default,
  documentScale: 1,
  libraryDensity: 'comfortable',
  settingsSection: 'general',
};

/** The document-scale steps View › Larger/Smaller walks through. */
export const DOCUMENT_SCALE_STEPS = [0.85, 0.925, 1, 1.1, 1.25, 1.4, 1.6] as const;

export function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(
  source: Record<string, unknown>,
  key: string,
  limits: { min: number; max: number },
  fallback: number,
): number {
  const value = source[key];
  if (typeof value !== 'number') return fallback;
  return clamp(value, limits.min, limits.max, fallback);
}

/**
 * Parse whatever is in storage into a state this app can lay out with.
 *
 * Exported for tests, and pure: it takes the raw string rather than reading
 * `localStorage` itself, so the clamping can be asserted without a DOM.
 */
export function parseWorkspace(raw: string | null): WorkspaceState {
  if (raw === null) return { ...DEFAULT_WORKSPACE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_WORKSPACE };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_WORKSPACE };
  const source = parsed as Record<string, unknown>;

  const layout = source['editorLayout'];
  const scale = source['documentScale'];
  const section = source['settingsSection'];

  return {
    sidebarVisible: readBoolean(source, 'sidebarVisible', DEFAULT_WORKSPACE.sidebarVisible),
    sidebarWidth: readNumber(source, 'sidebarWidth', PANE_LIMITS.sidebar, DEFAULT_WORKSPACE.sidebarWidth),
    outlineVisible: readBoolean(source, 'outlineVisible', DEFAULT_WORKSPACE.outlineVisible),
    outlineWidth: readNumber(
      source,
      'outlineWidth',
      PANE_LIMITS.editorOutline,
      DEFAULT_WORKSPACE.outlineWidth,
    ),
    inspectorVisible: readBoolean(source, 'inspectorVisible', DEFAULT_WORKSPACE.inspectorVisible),
    inspectorWidth: readNumber(
      source,
      'inspectorWidth',
      PANE_LIMITS.librarySidebar,
      DEFAULT_WORKSPACE.inspectorWidth,
    ),
    diagnosticsVisible: readBoolean(
      source,
      'diagnosticsVisible',
      DEFAULT_WORKSPACE.diagnosticsVisible,
    ),
    diagnosticsWidth: readNumber(
      source,
      'diagnosticsWidth',
      PANE_LIMITS.liveDiagnostics,
      DEFAULT_WORKSPACE.diagnosticsWidth,
    ),
    liveOutlineWidth: readNumber(
      source,
      'liveOutlineWidth',
      PANE_LIMITS.liveOutline,
      DEFAULT_WORKSPACE.liveOutlineWidth,
    ),
    editorLayout: EDITOR_LAYOUTS.includes(layout as EditorLayout)
      ? (layout as EditorLayout)
      : DEFAULT_WORKSPACE.editorLayout,
    editorSplitRatio: readNumber(
      source,
      'editorSplitRatio',
      PANE_LIMITS.editorSplit,
      DEFAULT_WORKSPACE.editorSplitRatio,
    ),
    /*
     * Snapped to a step rather than clamped to a range.
     *
     * Every way a user can change this walks the step table, so a value between
     * two steps came from somewhere else — a hand-edited store, or a build with
     * a different table. Snapping means the next Larger/Smaller press lands on
     * a real step instead of moving to the nearest one and appearing to do
     * nothing.
     */
    documentScale: nearestScaleStep(typeof scale === 'number' ? scale : DEFAULT_WORKSPACE.documentScale),
    libraryDensity: source['libraryDensity'] === 'compact' ? 'compact' : 'comfortable',
    settingsSection:
      typeof section === 'string' && section.length > 0 && section.length < 64
        ? section
        : DEFAULT_WORKSPACE.settingsSection,
  };
}

export function nearestScaleStep(value: number): number {
  if (!Number.isFinite(value)) return 1;
  let best = DOCUMENT_SCALE_STEPS[0] as number;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const step of DOCUMENT_SCALE_STEPS) {
    const distance = Math.abs(step - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = step;
    }
  }
  return best;
}

/**
 * The storage object, or null when there is not one that works.
 *
 * The ACCESS is inside the try, not outside it. `localStorage` is a property
 * getter on `window`, and in a webview with site data disabled — or a Chromium
 * with third-party storage blocked — merely *reading the property* throws a
 * SecurityError. A `typeof localStorage === 'undefined'` guard does not catch
 * that: it throws while evaluating the guard.
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function load(): WorkspaceState {
  try {
    const store = storage();
    if (store === null) return { ...DEFAULT_WORKSPACE };
    return parseWorkspace(store.getItem(STORAGE_KEY));
  } catch {
    // A `localStorage` that throws on read is a webview with storage disabled
    // or a full quota. The app works perfectly well with default panes.
    return { ...DEFAULT_WORKSPACE };
  }
}

const state = writable<WorkspaceState>(load());

export const workspace: Readable<WorkspaceState> = { subscribe: state.subscribe };


/**
 * Write-behind, so a drag does not put one storage write on the main thread per
 * pointer frame.
 *
 * `localStorage.setItem` is synchronous and JSON-serialising: at 120 Hz on a
 * trackpad that is a measurable stall in the middle of the one interaction the
 * user is judging the app's responsiveness by. The store itself updates
 * immediately — only the persistence is deferred.
 */
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** The state the pending timer will write, kept so shutdown can flush it. */
let pending: WorkspaceState | null = null;

function writeNow(next: WorkspaceState): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota, private mode, or storage disabled. The layout still works for
    // this run; it simply will not be there next time. Not worth a toast.
  }
}

function persist(next: WorkspaceState): void {
  pending = next;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const value = pending;
    pending = null;
    if (value !== null) writeNow(value);
  }, 250);
}

/**
 * Write any pending layout change immediately.
 *
 * The debounce is right for a drag and wrong for a quit: resizing a pane and
 * closing the window within 250ms threw the change away, so the one gesture
 * most likely to be followed by "and now I'm done" was the one that did not
 * stick.
 *
 * `pagehide` rather than `beforeunload`: it fires on the paths a webview
 * actually takes, and it is not subject to the "was there a user gesture"
 * rules. Registered once, at module load, because the layout store outlives
 * every component that writes to it.
 */
export function flushWorkspace(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const value = pending;
  pending = null;
  if (value !== null) writeNow(value);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushWorkspace);
}

/** Apply a partial change. The only mutator — everything else calls through it. */
export function updateWorkspace(patch: Partial<WorkspaceState>): void {
  state.update((current) => {
    const next = { ...current, ...patch };
    persist(next);
    return next;
  });
}

/** Set a pane's width, clamped to that pane's declared range. */
export function setPaneWidth(pane: PaneName, width: number): void {
  const limits = PANE_LIMITS[pane];
  const value = clamp(width, limits.min, limits.max, limits.default);
  switch (pane) {
    case 'sidebar':
      updateWorkspace({ sidebarWidth: value });
      break;
    case 'editorOutline':
      updateWorkspace({ outlineWidth: value });
      break;
    case 'editorSplit':
      updateWorkspace({ editorSplitRatio: value });
      break;
    case 'liveOutline':
      updateWorkspace({ liveOutlineWidth: value });
      break;
    case 'liveDiagnostics':
      updateWorkspace({ diagnosticsWidth: value });
      break;
    case 'librarySidebar':
      updateWorkspace({ inspectorWidth: value });
      break;
  }
}

/** Restore a pane to the width it shipped with (double-click a divider). */
export function resetPaneWidth(pane: PaneName): void {
  setPaneWidth(pane, PANE_LIMITS[pane].default);
}

/** Step the document scale one notch, or back to 1. */
export function stepDocumentScale(direction: 1 | -1 | 0): void {
  state.update((current) => {
    if (direction === 0) {
      const next = { ...current, documentScale: 1 };
      persist(next);
      return next;
    }
    const index = DOCUMENT_SCALE_STEPS.indexOf(
      nearestScaleStep(current.documentScale) as (typeof DOCUMENT_SCALE_STEPS)[number],
    );
    const nextIndex = Math.min(
      DOCUMENT_SCALE_STEPS.length - 1,
      Math.max(0, (index === -1 ? 2 : index) + direction),
    );
    const next = { ...current, documentScale: DOCUMENT_SCALE_STEPS[nextIndex] as number };
    persist(next);
    return next;
  });
}

/** Reset everything. Used by tests, and by Settings' "restore workspace layout". */
export function resetWorkspace(): void {
  updateWorkspace({ ...DEFAULT_WORKSPACE });
}
