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
  } from './menu-nav';

  export interface MenuItem {
    label: string;
    danger?: boolean;
    disabled?: boolean;
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
  }

  let { items, label = 'More actions', align = 'right', onopenchange }: Props = $props();

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
  const MENU_PAD = 8;

  /**
   * Open upwards when there is not enough room below.
   *
   * The menu is absolutely positioned, so it is clipped by the nearest
   * scrolling ancestor — and in the library that is `.page`, which scrolls. A
   * menu opened on the last visible row was cut off by the bottom of the list
   * rather than merely running past the window.
   *
   * The height is COMPUTED from the item count rather than measured, because
   * measuring means rendering downwards first and correcting on the next frame,
   * which the operator sees as the menu jumping. Items are `nowrap` and a fixed
   * height, so the arithmetic is exact.
   */
  function decideDirection(): void {
    const trigger = root?.getBoundingClientRect();
    if (!trigger) return;
    const height =
      MENU_PAD * 2 +
      items.length * ITEM_H +
      items.filter((item) => item.separated).length * SEPARATOR_H;
    const below = window.innerHeight - trigger.bottom - 8;
    const above = trigger.top - 8;
    // Only flip when up is genuinely better: a menu taller than the window
    // stays put rather than swapping one clipped edge for the other.
    dropUp = height > below && above > below;
  }

  function itemButtons(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
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
   * Open from the trigger, deciding whether the highlight has anything to say.
   *
   * A POINTER click opens with nothing highlighted: focus still lands on the
   * first item, because the menu-button pattern requires it and a keyboard user
   * must be able to carry on with the arrows — but painting that item as chosen
   * is a different claim, and a false one, since nobody pointed at it. It also
   * made the top action look pre-armed, one Return away from firing.
   *
   * ENTER or SPACE must highlight, though, and that is the whole reason this
   * function inspects the event. Both keys reach a button as a `click`, so
   * treating every click as pointer-originated left a keyboard user with focus
   * inside a menu and NOTHING drawn to say where — the outline that used to do
   * that job is suppressed now. On the Live transport that is the only route to
   * "Hard pause — mic off", so the failure mode is arming a destructive-looking
   * action invisibly.
   *
   * `detail` is the discriminator: pointer clicks carry a click count of at least
   * one, while a click synthesised from a key press (and one dispatched by
   * assistive technology) carries zero. Modality is not otherwise recoverable
   * from a click event.
   */
  function toggle(event?: MouseEvent): void {
    if (open) {
      closeMenu(true);
      return;
    }
    const fromKeyboard = !event || event.detail === 0;
    openMenu(firstEnabledIndex(items), fromKeyboard);
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
    const index = nextMenuIndex(items, activeIndex, event.key);
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
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });
</script>

<div class="wrap" bind:this={root}>
  <IconButton
    icon="dots"
    {label}
    active={open}
    haspopup="menu"
    expanded={open}
    onclick={toggle}
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
          role="menuitem"
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
          {item.label}
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
    padding: var(--space-2);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
  }
  .menu.left {
    right: auto;
    left: 0;
  }
  .menu.up {
    top: auto;
    bottom: calc(100% + 6px);
  }

  .separator {
    height: 1px;
    /* 4px of air either side inside the 9px the height arithmetic reserves. */
    margin: var(--space-1) calc(-1 * var(--space-1));
    background: var(--border-faint);
  }

  .item {
    display: flex;
    align-items: center;
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
  .item.active:not(:disabled) {
    background: var(--bg-hover-surface);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .item.danger {
    color: var(--danger);
  }
  .item.danger.active:not(:disabled) {
    background: var(--danger-soft);
  }
</style>
