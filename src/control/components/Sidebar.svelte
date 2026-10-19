<!--
  The source list (desktop refinement §7).

  ---------------------------------------------------------------------------
  WHAT CHANGED, AND WHY EACH THING WAS A "WEBSITE" TELL
  ---------------------------------------------------------------------------
  This was a 224px branded rail with a wordmark, a raised call-to-action button,
  36px navigation rows, and a white raised pill for the selected row. Each of
  those is a good SaaS dashboard sidebar and each is the wrong object here:

    the brand tile + wordmark   repeated identity the native titlebar already
                                carries. §7.1: let the native title and icon do
                                it. A small mark outlived the wordmark on the
                                theory that the macOS traffic lights floated
                                over this rail and needed something beside
                                them — they do not: the page content starts
                                below the titlebar (`App.svelte`, `.shell`), so
                                the mark was a microphone-shaped tile that
                                looked like a button and did nothing. Identity
                                lives in the app icon, the titlebar and the
                                Welcome screen.
    the raised New Script CTA   read as a conversion button. It is a document
                                command, so it looks like one: a source-list row
                                with a plus, at the top of the list where every
                                document app puts it.
    the white raised pill       a selected row in a source list is a tonal fill,
                                not a card floating off the panel. The shadow and
                                the white surface were what made the rail read as
                                a web nav.
    Settings + Shortcuts rows   permanent chrome for two things the native menu
                                now publishes (⌘, and ⌘/). §31.4: let native
                                menus reduce visible chrome. Settings stays,
                                because it is a place you go; Shortcuts is a
                                dialog and is now Help-only.
    the version line            moved to About, which is where a version belongs
                                and where macOS users look for it.

  ---------------------------------------------------------------------------
  IT IS NOW OPERABLE
  ---------------------------------------------------------------------------
  Draggable trailing edge with a persisted width (§7.2), arrow-key movement
  through the rows and first-letter navigation (§7.4), and — the part that is
  easy to get wrong — FOCUS AND SELECTION DRAWN DIFFERENTLY. Arrowing through a
  source list moves focus without navigating; Enter or Space commits. A rail
  where those two look identical tells a keyboard user that they have already
  changed screens when they have not.
-->
<script lang="ts" module>
  /**
   * A source list is ONE tab stop (§23.1's roving-tabindex rule).
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
  import { library, setLibraryView } from '../stores/library';
  import { navigate, route, type LibraryView } from '../stores/router';
  import { PANE_LIMITS, setPaneWidth, workspace } from '../stores/workspace';

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
   * §7.4 asks for these to be visually distinct, and they are genuinely
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
         * A WINDOW, not a destination (§14.1).
         *
         * The row stays in the rail because §7.1 only asked to move it out
         * "if user testing shows the sidebar entry does not aid discovery" —
         * and it plainly does, for anybody who has not learned ⌘,. What changed
         * is what it does: opening Settings no longer takes the script off the
         * screen, so the row is no longer a place you go.
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

  /** First-letter navigation, wrapping from the current row (§7.4). */
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
    /* 5px, not 8: §7.1 asks for a source-list row rather than a floating tile,
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

  /* No elevation on hover. §9.3: hover lift belongs to things that float. */
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
   * New Script reads as a command rather than a destination: accent-coloured
   * label, but the same row geometry as everything else. §7.1 — a document
   * command, not a marketing CTA.
   */
  .nav-item.command {
    color: var(--accent-strong);
    font-weight: 600;
  }
  .nav-item.command :global(svg) {
    color: var(--accent-strong);
  }
</style>
