<!--
  Row/toolbar overflow menu — floating popover with subtle elevation.

  This declares `role="menu"`/`role="menuitem"`, so it owes the full WAI-ARIA
  menu-button behaviour: the trigger says it opens a menu, opening moves focus
  into it, the arrows walk it as a single tab stop, and Escape closes it and
  gives focus back. It previously declared the roles and implemented none of
  that, which is a broken promise rather than a missing feature — and on the
  Live transport this is the only route to "Hard pause — mic off".
-->
<script lang="ts">
  import { tick } from 'svelte';
  import IconButton from './IconButton.svelte';
  import {
    firstEnabledIndex,
    menuItemTabIndex,
    nextMenuIndex,
    openIndexForTriggerKey,
    typeaheadIndex,
  } from '../../shared/menu-nav';

  export interface MenuItem {
    label: string;
    danger?: boolean;
    disabled?: boolean;
    /**
     * A checkmark, for menu rows that report state (§18.3).
     *
     * A tick in a reserved leading column is the platform convention, and the
     * alternative this replaces — an "active" pill inside a menu row — is a menu
     * row pretending to be a status chip. Its PRESENCE (not its value) reserves
     * the column, so a menu with any checkable row keeps every label on one left
     * edge and a menu with none is unaffected.
     */
    checked?: boolean;
    /** A right-aligned key hint, already formatted for this platform. */
    shortcut?: string;
    /**
     * Draw a hairline above this item.
     *
     * A flag on the item rather than a separator entry in the array, because
     * every index in `items` is load-bearing: `menu-nav.ts` walks the array to
     * work out what the arrows do, and a non-item sitting in it would have to be
     * skipped by all of that arithmetic. This way the array stays 1:1 with the
     * focusable items and the rule is purely presentational.
     */
    separated?: boolean;
    onselect: () => void;
  }

  interface Props {
    items: MenuItem[];
    label?: string;
    align?: 'left' | 'right';
    /**
     * The menu opened or closed.
     *
     * Open state is this component's business, except where a host has to stand
     * something else down while the menu owns the keyboard — the presentation
     * stage answers the arrow keys on the window, and would scroll the script
     * behind an open menu somebody is arrowing through.
     */
    onopenchange?: (open: boolean) => void;
    /** The 28px trigger, beside a small button such as a list row's Present. */
    compact?: boolean;
  }

  let {
    items,
    label = 'More actions',
    align = 'right',
    onopenchange,
    compact = false,
  }: Props = $props();

  let open = $state(false);
  let activeIndex = $state(-1);
  /**
   * Whether the active item should LOOK chosen.
   *
   * Separate from `activeIndex` because focus and highlight answer different
   * questions here. The ARIA menu-button pattern requires focus to move into the
   * menu the moment it opens, so `activeIndex` always points at something — but a
   * menu opened with the mouse has not been told which item the operator wants,
   * and macOS menus paint nothing until the pointer or an arrow key says so.
   */
  let highlighted = $state(false);
  let dropUp = $state(false);
  let root: HTMLElement | null = $state(null);
  let menu: HTMLElement | null = $state(null);

  /* Item metrics, mirrored from the style block below so the height of an
     unrendered menu can be predicted. */
  const ITEM_H = 32;
  const SEPARATOR_H = 9;
  const MENU_PAD = 6; // --float-inset

  /**
   * The vertical band the menu can actually be seen in: the window, narrowed
   * by every ancestor that clips its overflow.
   *
   * Measuring the window alone was wrong by exactly the chrome under the list.
   * In the Library the rows scroll inside `.list-area`, which ends at the
   * status bar, so a row's menu with 230px of window below it but only 206px
   * of list opened downwards and lost its last item under the status bar.
   * The clip is the padding box, so the band is taken from the client area.
   */
  function visibleBand(from: HTMLElement): { top: number; bottom: number } {
    let top = 0;
    let bottom = window.innerHeight;
    for (let el = from.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const rect = el.getBoundingClientRect();
      top = Math.max(top, rect.top + el.clientTop);
      bottom = Math.min(bottom, rect.top + el.clientTop + el.clientHeight);
    }
    return { top, bottom };
  }

  /**
   * Open upwards when there is not enough room below.
   *
   * The menu is absolutely positioned, so it is clipped by every ancestor that
   * clips — see `visibleBand` for the one that bit. A menu opened on the last
   * visible row was cut off by the bottom of the list rather than merely
   * running past the window.
   *
   * The height is COMPUTED from the item count rather than measured, because
   * measuring means rendering downwards first and correcting on the next frame,
   * which the operator sees as the menu jumping. Items are `nowrap` and a fixed
   * height, so the arithmetic is exact. The 8px is the 6px gap to the trigger
   * plus the menu's two 1px borders.
   */
  function decideDirection(): void {
    if (!root) return;
    const trigger = root.getBoundingClientRect();
    const band = visibleBand(root);
    const height =
      MENU_PAD * 2 +
      items.length * ITEM_H +
      items.filter((item) => item.separated).length * SEPARATOR_H;
    const below = band.bottom - trigger.bottom - 8;
    const above = trigger.top - band.top - 8;
    // Only flip when up is genuinely better: a menu taller than the band
    // stays put rather than swapping one clipped edge for the other.
    dropUp = height > below && above > below;
  }

  function itemButtons(): HTMLElement[] {
    // Both roles — a checkable row is a `menuitemcheckbox`, and naming only
    // `menuitem` would make the arrows skip every checked entry (the view-options
    // menu is entirely checkable, so they would not move at all).
    return menu
      ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemcheckbox"]')]
      : [];
  }

  function focusItem(index: number, highlight = true): void {
    activeIndex = index;
    // A pointer or an arrow key has now chosen something, so the highlight has
    // an answer to give. See `highlighted` for why opening alone does not.
    if (highlight) highlighted = true;
    // The item only exists after the menu has rendered.
    void tick().then(() => {
      if (open) itemButtons()[index]?.focus();
    });
  }

  function focusTrigger(): void {
    root?.querySelector<HTMLElement>('button')?.focus();
  }

  function openMenu(index = firstEnabledIndex(items), highlight = true): void {
    decideDirection();
    open = true;
    onopenchange?.(true);
    focusItem(index, highlight);
  }

  function closeMenu(restoreFocus: boolean): void {
    if (!open) return;
    open = false;
    activeIndex = -1;
    highlighted = false;
    onopenchange?.(false);
    if (restoreFocus) focusTrigger();
  }

  /**
   * Open or close from the trigger, saying whether the highlight has anything
   * to say.
   *
   * A POINTER opens with nothing highlighted: focus still lands on the first
   * item, because the menu-button pattern requires it and a keyboard user must
   * be able to carry on with the arrows — but painting that item as chosen is a
   * different claim, and a false one, since nobody pointed at it. It also made
   * the top action look pre-armed, one Return away from firing.
   *
   * ENTER or SPACE must highlight, though. Both keys reach a button as a
   * `click`, so treating every click as pointer-originated left a keyboard user
   * with focus inside a menu and NOTHING drawn to say where — the outline that
   * used to do that job is suppressed now. On the Live transport that is the
   * only route to "Hard pause — mic off", so the failure mode is arming a
   * destructive-looking action invisibly.
   */
  function toggle(highlight: boolean): void {
    if (open) {
      closeMenu(true);
      return;
    }
    openMenu(firstEnabledIndex(items), highlight);
  }

  /**
   * Set while the click a handled press will send on release is still to come.
   *
   * Not reset when that click never arrives (the pointer slid off the trigger
   * before release): the next press sets it afresh, and a keyboard click is
   * told apart by its click count, so a stale flag can swallow neither.
   */
  let pressHandled = false;

  /**
   * The menu opens on the PRESS, as a Mac menu does, not when the button is
   * released.
   *
   * The default action is cancelled because it moves focus: onto the trigger in
   * Chromium, and in the Mac's WKWebView — where a click does not focus a plain
   * button — onto the nearest mouse-focusable ancestor, which in the Library is
   * the row. Either one
   * lands after `openMenu` has put focus on the first item, and takes it away
   * again, leaving the arrows and Escape talking to nothing.
   *
   * Control-click is the Mac's secondary click, which opens the row's context
   * menu; it is left to that.
   */
  function onTriggerMouseDown(event: MouseEvent): void {
    pressHandled = false;
    if (event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    pressHandled = true;
    toggle(false);
  }

  /**
   * The click is the keyboard's route in, and the release of a press that has
   * already acted.
   *
   * `detail` is the discriminator: pointer clicks carry a click count of at
   * least one, while a click synthesised from Enter or Space (and one
   * dispatched by assistive technology) carries zero. Modality is not otherwise
   * recoverable from a click event.
   */
  function onTriggerClick(event: MouseEvent): void {
    const fromKeyboard = event.detail === 0;
    if (pressHandled && !fromKeyboard) {
      pressHandled = false;
      return;
    }
    toggle(fromKeyboard);
  }

  function onTriggerKeydown(event: KeyboardEvent): void {
    if (open) return;
    // Enter/Space reach the click handler as well; letting both run would
    // toggle twice, so only the arrows are handled here.
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const index = openIndexForTriggerKey(items, event.key);
    if (index === null) return;
    event.preventDefault();
    openMenu(index);
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      // A menu is not part of the tab ring; Tab dismisses it.
      closeMenu(false);
      return;
    }
    /*
     * Navigate from what the menu SHOWS, not from where focus happens to sit.
     *
     * A pointer-opened menu parks focus on the first item without painting it,
     * so navigating from `activeIndex` made the first ArrowDown skip the top
     * item of a menu that looked unselected — while the same list opened by
     * right-click (ContextMenu, which starts from nothing) landed on it. With
     * nothing drawn, the first Down selects the first item and the first Up
     * the last, as a native menu does.
     *
     * Arrows first, then a typed letter: the same first-letter jump the
     * right-click menu has, so the one list answers the keyboard the same way
     * whichever way it was opened.
     */
    const origin = highlighted ? activeIndex : -1;
    const index =
      nextMenuIndex(items, origin, event.key) ??
      typeaheadIndex(items, origin, event.key, event.metaKey || event.ctrlKey || event.altKey);
    if (index === null) return;
    event.preventDefault();
    focusItem(index);
  }

  function choose(item: MenuItem): void {
    if (item.disabled) return;
    closeMenu(true);
    item.onselect();
  }

  $effect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) closeMenu(false);
    };
    // And when the window stops being the one in front, as a native menu
    // does: an app switch must not leave it open, holding the keyboard, for
    // the return. No focus restore — the user went somewhere else.
    const onBlur = () => closeMenu(false);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
    };
  });
</script>

<div class="wrap" bind:this={root}>
  <IconButton
    icon="dots"
    {label}
    {compact}
    active={open}
    haspopup="menu"
    expanded={open}
    onclick={onTriggerClick}
    onmousedown={onTriggerMouseDown}
    onkeydown={onTriggerKeydown}
  />
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="menu"
      class:left={align === 'left'}
      class:up={dropUp}
      role="menu"
      tabindex="-1"
      aria-label={label}
      bind:this={menu}
      onkeydown={onMenuKeydown}
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
            // Pointer and keyboard drive ONE highlight. Two would mean the
            // arrow-focused item and the hovered item both looking chosen,
            // which is the state that made this menu read as broken.
            if (!item.disabled) focusItem(index);
          }}
        >
          {#if items.some((entry) => entry.checked !== undefined)}
            <span class="check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
          {/if}
          <span class="item-label">{item.label}</span>
          {#if item.shortcut}<span class="shortcut">{item.shortcut}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    display: inline-flex;
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 40;
    min-width: 200px;
    display: flex;
    flex-direction: column;
    /* No gap: the highlight is a full-width wash, and gaps between washes read
       as a list of buttons rather than as a menu. */
    padding: var(--float-inset);
    /* Glass — see GLASS POLICY in tokens.css. Concentric: the 12px corner is
       the rows' 6px plus the 6px inset they sit at. */
    background: var(--glass-fill);
    -webkit-backdrop-filter: var(--glass-backdrop);
    backdrop-filter: var(--glass-backdrop);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-float);
    box-shadow:
      inset 0 0 0 1px var(--glass-inner-edge),
      var(--glass-shadow);
    /* It grows out of the trigger: from the corner nearest it. */
    transform-origin: top right;
    animation: glass-materialize var(--dur-materialize) var(--ease-out);
  }
  .menu.left {
    right: auto;
    left: 0;
    transform-origin: top left;
  }
  .menu.up {
    top: auto;
    bottom: calc(100% + 6px);
    transform-origin: bottom right;
  }
  .menu.up.left {
    transform-origin: bottom left;
  }

  .separator {
    height: 1px;
    /* 4px of air either side inside the 9px the height arithmetic reserves.
       Inset to the label column: run past the highlight's edges and the rule
       reads as a seam across the popover rather than a break in the list. */
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

  /*
   * A menu highlights, it does not ring.
   *
   * Under the opt-in policy in `tokens.css` these unmarked buttons would take
   * the quiet inset edge, not the accent ring — a menu item is a list row, not
   * a compact control, so it deliberately does not carry `data-focus="control"`.
   * This component then declines even the quiet edge, because the highlight
   * below IS the focus affordance here: opening the menu moves focus onto an
   * item, and an outline on that item would read as a second selection sitting
   * underneath the highlight marking the very same row. (The accent ring this
   * replaced was worse still — at +2px offset it consumed the whole 4px of
   * popover padding, sat ON the border and overhung into its neighbour, which
   * is what made the menu look broken.)
   *
   * The highlight is driven by `activeIndex` rather than by `:focus`/`:hover`, so
   * exactly one item is ever marked no matter which device is driving, and it
   * does not depend on how the engine chooses to interpret programmatic focus
   * for `:focus-visible`.
   */
  .item:focus,
  .item:focus-visible {
    outline: none;
  }
  /*
   * The highlight is the menu's focus indicator — the only one, since an
   * outline would draw a second selection under it — so it has to be seen:
   * a solid accent fill with an inverse label, the way a Mac menu marks the item
   * Return would choose. The faint surface wash it replaces measured 1.1:1
   * against the menu, which is no indicator at all to a keyboard user. The
   * same treatment in OverflowMenu, ContextMenu and SplitButton.
   */
  .item.active:not(:disabled) {
    background: var(--accent-strong);
    color: var(--accent-contrast);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
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

  .check {
    flex: 0 0 12px;
    font-size: var(--text-xs);
    color: var(--accent-strong);
  }
  .item-label {
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
