<!--
  The source list.

  ---------------------------------------------------------------------------
  A SOURCE LIST, NOT A WEBSITE SIDEBAR
  ---------------------------------------------------------------------------
  Each of these is a good SaaS dashboard sidebar and the wrong object here:

    a brand tile or wordmark    repeats identity the native title and icon
                                already carry. Identity lives in the app icon,
                                the titlebar and the Welcome screen.
    a raised New Script CTA     reads as a conversion button. It is a document
                                command, so it looks like one: a source-list row
                                with a plus, at the top of the list where every
                                document app puts it.
    a white raised pill         a selected row in a source list is a tonal fill,
                                not a card floating off the panel. A shadow and
                                a white surface make the rail read as a web nav.
    a Shortcuts row             permanent chrome for a dialog the native menu
                                publishes (⌘/), so it is Help-only. Settings
                                keeps its row (see `activate`).
    a version line              belongs in About, where macOS users look for it.

  ---------------------------------------------------------------------------
  IT IS OPERABLE
  ---------------------------------------------------------------------------
  Draggable trailing edge with a persisted width, arrow-key movement
  through the rows and first-letter navigation, and — the part that is
  easy to get wrong — FOCUS AND SELECTION DRAWN DIFFERENTLY. Arrowing through a
  source list moves focus without navigating; Enter or Space commits. A rail
  where those two look identical tells a keyboard user that they have already
  changed screens when they have not.
-->
<script lang="ts" module>
  /**
   * A source list is ONE tab stop (the roving-tabindex rule).
   *
   * Tabbing into the rail lands on the current route's row and the arrows take
   * over from there. Five separate tab stops would mean four presses of Tab to
   * get past a navigation rail on the way to the content, every time.
   *
   * In the module block because it is pure arithmetic over values the instance
   * already has, which makes it testable without mounting the component.
   */
  export function rovingTabIndex(index: number, activeIndex: number): 0 | -1 {
    // Nothing active (a route the rail does not represent): the first row takes
    // the tab stop, so the rail is never unreachable.
    if (activeIndex < 0) return index === 0 ? 0 : -1;
    return index === activeIndex ? 0 : -1;
  }
</script>

<script lang="ts">
  import Icon from './Icon.svelte';
  import PaneDivider from './PaneDivider.svelte';
  import { windowTitlebar } from '../lib/window-material';
  import { library, setLibraryView } from '../stores/library';
  import { navigate, route, type LibraryView } from '../stores/router';
  import { PANE_LIMITS, setPaneWidth, workspace } from '../stores/workspace';

  const overlayTitlebar = windowTitlebar() === 'overlay';

  interface Props {
    onnew: () => void;
    /** Opens the Settings window — see the note in `activate`. */
    onsettings: () => void;
  }

  let { onnew, onsettings }: Props = $props();

  /** Every row the arrows walk, in visual order. New Script is one of them. */
  type Row =
    | { kind: 'new'; label: string; icon: 'plus' }
    | { kind: 'view'; view: LibraryView; label: string; icon: 'doc' | 'clock' | 'trash' }
    | { kind: 'settings'; label: string; icon: 'settings' };

  const rows: Row[] = [
    { kind: 'new', label: 'New script', icon: 'plus' },
    { kind: 'view', view: 'all', label: 'All scripts', icon: 'doc' },
    { kind: 'view', view: 'recent', label: 'Recent', icon: 'clock' },
    { kind: 'view', view: 'trash', label: 'Trash', icon: 'trash' },
    { kind: 'settings', label: 'Settings', icon: 'settings' },
  ];

  const activeView = $derived($route.name === 'library' ? $library.view : null);
  const inSettings = $derived($route.name === 'settings');

  let list: HTMLElement | null = $state(null);
  /**
   * Which row the arrows are on — NOT which route is current.
   *
   * These are drawn distinctly because they are genuinely
   * different facts: the current route is where you are, and this is where the
   * next Enter would take you. Reset to -1 whenever focus leaves the rail, so
   * returning to it starts from the current route rather than from wherever the
   * cursor was left last time.
   */
  let focusIndex = $state(-1);

  function isActive(row: Row): boolean {
    if (row.kind === 'view') return activeView === row.view;
    if (row.kind === 'settings') return inSettings;
    return false;
  }

  function activate(row: Row): void {
    switch (row.kind) {
      case 'new':
        onnew();
        break;
      case 'view':
        void goToView(row.view);
        break;
      case 'settings':
        /*
         * A WINDOW, not a destination: opening Settings does not take the
         * script off the screen. The row stays in the rail because it aids
         * discovery for anybody who has not learned ⌘,.
         */
        onsettings();
        break;
    }
  }

  async function goToView(view: LibraryView): Promise<void> {
    const moved = await navigate({ name: 'library', view });
    if (moved) setLibraryView(view);
  }

  function buttons(): HTMLElement[] {
    return list ? [...list.querySelectorAll<HTMLElement>('.nav-item')] : [];
  }

  function moveFocus(next: number): void {
    const items = buttons();
    if (items.length === 0) return;
    const index = (next + items.length) % items.length;
    focusIndex = index;
    items[index]?.focus();
  }

  /** First-letter navigation, wrapping from the current row. */
  function typeahead(key: string): boolean {
    const lower = key.toLowerCase();
    for (let step = 1; step <= rows.length; step += 1) {
      const index = (Math.max(focusIndex, 0) + step) % rows.length;
      if (rows[index]?.label.toLowerCase().startsWith(lower)) {
        moveFocus(index);
        return true;
      }
    }
    return false;
  }

  /** The active row's index, or -1 — the roving tab stop's anchor. */
  const activeIndex = $derived(rows.findIndex((row) => isActive(row)));

  function rowTabIndex(index: number): 0 | -1 {
    return rovingTabIndex(index, activeIndex);
  }

  function keydown(event: KeyboardEvent, index: number): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(index - 1);
        return;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        return;
      case 'End':
        event.preventDefault();
        moveFocus(rows.length - 1);
        return;
      default:
        break;
    }
    // Enter and Space reach the button as a click already; only letters are
    // handled here, and only unmodified ones — a modifier means a command.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (typeahead(event.key)) event.preventDefault();
    }
  }
</script>

<aside class="sidebar" style="width: {$workspace.sidebarWidth}px">
  {#if overlayTitlebar}
    <!--
      The traffic lights' place (a Mac, where the titlebar is an overlay — see
      `lib/window-material.ts`): the head of the rail, as tall as the toolbar
      band beside it so the first row starts where the document does, and the
      handle the window is moved by from this side.
    -->
    <div class="titlebar-head" data-tauri-drag-region aria-hidden="true"></div>
  {/if}
  <nav class="nav" aria-label="Library" bind:this={list} onfocusout={() => (focusIndex = -1)}>
    {#each rows as row, index (row.label)}
      {#if row.kind === 'settings'}
        <!-- Ruled off: Settings is a different KIND of destination from the
             collection views above it, and a rule says so more quietly than a
             heading would. -->
        <div class="rule" role="presentation"></div>
      {/if}
      <button
        type="button"
        class="nav-item"
        class:active={isActive(row)}
        class:command={row.kind === 'new'}
        aria-current={isActive(row) ? 'page' : undefined}
        tabindex={rowTabIndex(index)}
        onclick={() => activate(row)}
        onkeydown={(event) => keydown(event, index)}
        onfocus={() => (focusIndex = index)}
      >
        <Icon name={row.icon} size={15} />
        <span class="label">{row.label}</span>
      </button>
    {/each}
  </nav>
</aside>

<!--
  The trailing edge. Outside `<aside>` so it sits BETWEEN the panes rather than
  inside one of them — a divider that belongs to the sidebar would scroll with
  it and would be clipped by its overflow.
-->
<PaneDivider
  orientation="vertical"
  side="leading"
  label="Sidebar width"
  pane="Sidebar"
  value={$workspace.sidebarWidth}
  min={PANE_LIMITS.sidebar.min}
  max={PANE_LIMITS.sidebar.max}
  defaultValue={PANE_LIMITS.sidebar.default}
  onresize={(width) => setPaneWidth('sidebar', width)}
/>

<style>
  .sidebar {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    height: 100%;
    padding: var(--space-2) var(--space-2) var(--space-3);
    background: var(--bg-chrome);
    overflow-y: auto;
    /* No border: the PaneDivider beside it draws the line, and two would be a
       two-pixel rule with a seam down the middle. */
    min-width: 0;
  }

  /* The sidebar's own top padding is part of the band, so the head is the
     band less it: the first row then starts at the toolbar's bottom edge. */
  .titlebar-head {
    flex: 0 0 auto;
    height: calc(var(--toolbar-h) - var(--space-2) - var(--space-1));
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .rule {
    height: 1px;
    margin: var(--space-2) var(--space-2);
    background: var(--divider);
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--source-row-h);
    padding: 0 var(--space-2);
    border: none;
    background: transparent;
    /* 5px, not 8: a source-list row rather than a floating tile,
       and the difference between those two shapes is almost entirely radius. */
    border-radius: 5px;
    /* Primary label colour at a regular weight, the way a Mac source list
       draws every row: grey semibold labels read as disabled beside the one
       that was selected, and 550 is a variable-font weight WebKit and Chromium
       round differently. The icon carries the secondary tone instead. */
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 500;
    text-align: left;
    width: 100%;
    min-width: 0;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .nav-item :global(svg) {
    color: var(--text-secondary);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* No elevation on hover: hover lift belongs to things that float. */
  .nav-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }

  /*
   * Selected: a neutral tonal fill and stronger text. No white surface, no
   * border, no shadow — see the note at the top for why the pill had to go —
   * and no accent wash either (`--bg-source-selected`): the accent is the icon's.
   */
  .nav-item.active,
  .nav-item.active:hover {
    background: var(--bg-source-selected);
    color: var(--text-primary);
    font-weight: 600;
  }
  .nav-item.active :global(svg) {
    color: var(--accent-strong);
  }

  /*
   * New Script reads as a command rather than a destination: a heavier ink
   * label and its plus, in the same row geometry as everything else — a
   * document command, not a marketing CTA. Ink rather than petrol, so the
   * window's one petrol action stays Present.
   */
  .nav-item.command {
    color: var(--text-primary);
    font-weight: 600;
  }
  .nav-item.command :global(svg) {
    color: var(--text-primary);
  }

  /*
   * On the window's material (vibrancy on a Mac, Mica on Windows 11 — see
   * `lib/window-material.ts`), the rail is the system's glass with a light
   * wash of the palette over it, rather than the chrome grey — the side of
   * the glass frame whose top is the toolbar band.
   *
   * The hover and the rule go translucent with it: the opaque chrome greys are
   * tuned for a grey rail, and on glass they read as patches stuck onto it.
   * The selected row needs no change — it is already ink at low strength — and
   * the text keeps its own colours, which `glass-material.test.ts` checks over
   * the tint at its weakest.
   */
  :global(html[data-window-material][data-material-rail]) .sidebar {
    --bg-hover-chrome: var(--material-hover);
    background: var(--material-tint);
  }
  :global(html[data-window-material][data-material-rail]) .nav-item:hover {
    background: var(--material-hover);
  }
  :global(html[data-window-material][data-material-rail]) .nav-item.active,
  :global(html[data-window-material][data-material-rail]) .nav-item.active:hover {
    background: var(--bg-source-selected);
  }
  :global(html[data-window-material][data-material-rail]) .rule {
    background: var(--material-rule);
  }
</style>
