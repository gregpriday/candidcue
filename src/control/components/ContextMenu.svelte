<!--
  Right-click menus (desktop refinement §10.6, §20.1).

  ---------------------------------------------------------------------------
  WHY NOT A NATIVE MENU
  ---------------------------------------------------------------------------
  §10.6 asks for native menus "where feasible", and this is the case where it is
  not. Tauri can pop a native menu at a point, but doing so would mean: a new IPC
  command taking screen coordinates and an item list from the webview; a menu
  rebuilt per right-click because the items depend on the row; and a second
  dispatch path back into `runCommand` with its own id vocabulary. That is a
  meaningful widening of the ACL surface (§49's rule is that every command is
  granted deliberately) in exchange for a menu the user cannot tell apart at a
  glance from this one.

  What actually makes a context menu feel native is its BEHAVIOUR, and that is
  what this implements to the letter: right-click selects the row first, the menu
  opens at the pointer, arrows walk it, typeahead jumps, Escape closes it and
  returns focus, and it never opens off-screen.

  ---------------------------------------------------------------------------
  IT IS A SINGLETON, HOSTED ONCE
  ---------------------------------------------------------------------------
  Rendered by the shell rather than by each list, and driven by a store. A menu
  per row would mean one popover component per script in the Library — hundreds
  of subscriptions and event listeners for a thing at most one of which is ever
  open. It also makes "only one context menu at a time" true by construction
  rather than by everybody remembering.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { closeContextMenu, contextMenu, type ContextMenuItem } from '../stores/context-menu';
  import {
    firstEnabledIndex,
    menuItemTabIndex,
    nextMenuIndex,
    typeaheadIndex,
  } from '../../shared/menu-nav';

  let menu: HTMLElement | null = $state(null);
  let activeIndex = $state(-1);
  let highlighted = $state(false);
  /** Resolved after measuring, so the menu never opens past the window edge. */
  let position = $state({ x: 0, y: 0 });

  const open = $derived($contextMenu !== null);
  const items = $derived($contextMenu?.items ?? []);

  /**
   * Hidden until it has been measured and placed.
   *
   * The comment here used to CLAIM this and the style did not implement it, so a
   * menu opened near the right or bottom edge painted one frame out of bounds
   * before `tick()` moved it. `visibility` rather than `display`, because the
   * element still has to be laid out for `getBoundingClientRect` to mean
   * anything.
   */
  let placed = $state(false);

  /*
   * Position AFTER the menu has rendered, from its real size.
   *
   * The overflow menu can predict its own height because its rows are uniform;
   * this one cannot — items carry shortcuts, separators and variable labels, and
   * a wrong guess puts the menu half off the bottom of the window at exactly the
   * moment somebody right-clicked the last row in a list.
   */
  $effect(() => {
    const request = $contextMenu;
    if (request === null) {
      activeIndex = -1;
      highlighted = false;
      placed = false;
      return;
    }
    position = { x: request.x, y: request.y };
    /*
     * NOT seeded to the first item.
     *
     * It was, and that made the first ArrowDown land on the SECOND row: the
     * index already pointed at the first, so "next" moved past it. A native
     * context menu opens with nothing active — the pointer has chosen nothing
     * yet — and the first arrow press should select the first item.
     */
    activeIndex = -1;
    highlighted = false;
    placed = false;
    void tick().then(() => {
      /*
       * Bail if this is no longer the request we were placing.
       *
       * A second right-click before this microtask runs replaces the store's
       * value; without this check the older placement would move and focus the
       * newer menu, putting it at the previous pointer position.
       */
      if (!menu || $contextMenu !== request) return;
      const rect = menu.getBoundingClientRect();
      const margin = 8;
      let { x, y } = request;
      // Flip rather than clamp when there is room on the other side: a menu
      // shoved up against the window edge overlaps the thing it is about.
      if (x + rect.width + margin > window.innerWidth) {
        x = Math.max(margin, x - rect.width);
      }
      if (y + rect.height + margin > window.innerHeight) {
        y = Math.max(margin, y - rect.height);
      }
      position = { x, y };
      placed = true;
    });
  });

  /*
   * Focus the MENU, not an item — once it can take focus.
   *
   * A native context menu opens with nothing highlighted — the pointer has not
   * chosen anything yet, and painting the first item as selected makes a
   * destructive row at the top look one Return away from firing. The container
   * is focusable so the arrows have somewhere to arrive; the first arrow press
   * moves onto an item and highlights it.
   *
   * An effect on `placed`, because effects run after the DOM has caught up.
   * This used to be a `menu.focus()` straight after `placed = true`, while the
   * element was still `visibility: hidden` — and a browser silently refuses
   * focus to a hidden element. So the menu opened with focus left on the row
   * behind it: the arrows walked the Library list under an open menu, and
   * Escape and the letters never reached it. A further `tick()` was not enough
   * either; whether the style had flushed by then depended on timing.
   */
  $effect(() => {
    if (placed) menu?.focus();
  });

  function focusItem(index: number): void {
    activeIndex = index;
    highlighted = true;
    void tick().then(() => {
      if (!menu) return;
      // Both roles: a checkable row is a `menuitemcheckbox`, and a selector that
      // named only `menuitem` would silently skip every one of them — so the
      // arrows would stop moving the moment a menu gained a checkmark.
      menu
        .querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemcheckbox"]')
        [index]?.focus();
    });
  }

  function choose(item: ContextMenuItem): void {
    if (item.disabled) return;
    closeContextMenu(true);
    item.onselect();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      // A menu is not part of the tab ring.
      closeContextMenu(false);
      return;
    }
    // Arrows, then first-letter navigation (§18.3, §7.4) — the arithmetic
    // lives in `menu-nav.ts`, shared with the row's ⋯ menu, which is what keeps
    // the two answering a letter the same way.
    const next =
      nextMenuIndex(items, activeIndex, event.key) ??
      typeaheadIndex(
        items,
        activeIndex,
        event.key,
        event.metaKey || event.ctrlKey || event.altKey,
      );
    if (next === null) return;
    event.preventDefault();
    focusItem(next);
  }

  $effect(() => {
    if (!open) return undefined;
    const dismiss = (event: Event) => {
      if (menu && !menu.contains(event.target as Node)) closeContextMenu(false);
    };
    /*
     * Capture phase, and `contextmenu` as well as `pointerdown`: a second
     * right-click somewhere else must move the menu rather than leave two ideas
     * of where it is. `scroll` and `resize` dismiss because the menu is
     * positioned in viewport coordinates and would otherwise detach from the row
     * it belongs to.
     */
    const onGeometryChange = () => closeContextMenu(false);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('contextmenu', dismiss, true);
    // Named, so the teardown below can actually remove it. It was an inline
    // arrow, which nothing could unregister — one listener leaked per opening,
    // and each one could close a LATER menu after this component's effect had
    // been torn down.
    window.addEventListener('resize', onGeometryChange);
    window.addEventListener('scroll', onGeometryChange, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('contextmenu', dismiss, true);
      window.removeEventListener('resize', onGeometryChange);
      window.removeEventListener('scroll', onGeometryChange, true);
    };
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    aria-label={$contextMenu?.label ?? 'Actions'}
    bind:this={menu}
    style="left: {position.x}px; top: {position.y}px; visibility: {placed
      ? 'visible'
      : 'hidden'};"
    onkeydown={keydown}
  >
    {#each items as item, index (item.label)}
      {#if item.separated}
        <div class="separator" role="separator"></div>
      {/if}
      <button
        type="button"
        class="item"
        class:danger={item.danger}
        class:active={highlighted && index === activeIndex}
        role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={item.checked === undefined ? undefined : item.checked}
        tabindex={menuItemTabIndex(activeIndex, index)}
        disabled={item.disabled}
        onclick={() => choose(item)}
        onpointerenter={() => {
          if (!item.disabled) focusItem(index);
        }}
      >
        <!--
          A checkmark column, not a pill (§18.3). A menu row that carries its
          state as a coloured capsule is a menu row pretending to be a chip; the
          platform convention is a tick in a reserved leading column, and
          reserving it unconditionally keeps every label on the same left edge
          whether or not anything in the menu is checkable.
        -->
        {#if items.some((entry) => entry.checked !== undefined)}
          <span class="check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
        {/if}
        <span class="label">{item.label}</span>
        {#if item.shortcut}<span class="shortcut">{item.shortcut}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 60;
    min-width: 200px;
    max-width: 320px;
    display: flex;
    flex-direction: column;
    /* The ⋯ menu's metrics, row for row. The two draw ONE list of actions
       (`rowMenuItems`), and a right-click that produced a tighter menu with
       squarer highlights read as a second, separately designed control. */
    padding: var(--space-2);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
    /*
     * Nothing here animates, and that has to be said out loud. Under Reduce
     * Motion, tokens.css gives every element a 0.01ms transition, and an
     * element that declares none transitions `all` — `visibility` included. The
     * reveal from `hidden` then starts a transition whose first frame is still
     * hidden, the focus that follows is refused, and the menu opens with the
     * keyboard left on the row behind it.
     */
    transition-property: none;
  }
  .menu:focus {
    outline: none;
  }

  .separator {
    height: 1px;
    /* Inset to the label column, as in OverflowMenu. */
    margin: var(--space-1) var(--space-3);
    background: var(--border-faint);
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    height: 32px;
    text-align: left;
    padding: 0 var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  /* The highlight IS the focus affordance — see the long note in OverflowMenu
     for why a menu row declines both the ring and the quiet edge. */
  .item:focus,
  .item:focus-visible {
    outline: none;
  }
  /* A solid clay fill with an inverse label: the highlight is the only focus
     indicator a menu row has, so it must be seen — see OverflowMenu. */
  .item.active:not(:disabled) {
    background: var(--accent-strong);
    color: var(--accent-contrast);
  }
  .item.danger {
    color: var(--danger);
  }
  .item.danger.active:not(:disabled) {
    background: var(--danger);
    color: var(--danger-contrast);
  }
  .item.active:not(:disabled) .check,
  .item.active:not(:disabled) .shortcut {
    color: inherit;
  }
  /*
   * Disabled items stay VISIBLE. §10.6: a command whose absence would be
   * confusing should remain in the menu, greyed — a Restore that vanishes
   * outside Trash leaves somebody wondering whether the app can restore at all.
   */
  .item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .check {
    flex: 0 0 12px;
    font-size: var(--text-xs);
    color: var(--accent-strong);
  }
  .label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Right-aligned, muted, tabular — the platform convention (§18.3). */
  .shortcut {
    flex: 0 0 auto;
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    padding-left: var(--space-4);
  }
</style>
