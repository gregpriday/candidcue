<!--
  A primary action with its alternatives one click away.

  ---------------------------------------------------------------------------
  WHY A SPLIT BUTTON AND NOT TWO BUTTONS, OR A SETTING
  ---------------------------------------------------------------------------
  This exists for Present, which has two shapes — take the display, or present
  in an ordinary window — and one of them is right about nine times in ten.

  Two co-equal buttons would make the operator choose on every take, including
  the nine where there is nothing to decide, and would say by their equal weight
  that the choice matters more than it does. A setting alone is what the app had:
  correct, persistent, and three levels away from the button, so in practice the
  only reachable control was the transient mid-take toggle and the launch mode
  looked like it was being forgotten.

  The split button is what Google Slides, and every toolbar that has faced this,
  settles on: the main click does the common thing without asking, and the
  alternative is visible rather than remembered. See `PRESENT_MODE_ITEMS` in the
  Present call sites for the copy.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import {
    firstEnabledIndex,
    menuItemTabIndex,
    nextMenuIndex,
    openIndexForTriggerKey,
  } from '../../shared/menu-nav';

  export interface SplitMenuItem {
    label: string;
    /** A second line, for a choice that is not self-explanatory from its label. */
    description?: string;
    /**
     * Draw a check. This is a menu of MODES rather than of commands, so it owes
     * the operator an answer to "which one am I in?" — without it the menu says
     * what could happen and not what will.
     */
    selected?: boolean;
    disabled?: boolean;
    onselect: () => void;
  }

  interface Props {
    /** The main button's label. */
    label: string;
    /** Accessible name for the menu half, e.g. "Presentation options". */
    menuLabel: string;
    variant?: 'default' | 'primary';
    disabled?: boolean;
    items: SplitMenuItem[];
    onclick?: () => void;
  }

  let {
    label,
    menuLabel,
    variant = 'default',
    disabled = false,
    items,
    onclick,
  }: Props = $props();

  let open = $state(false);
  let activeIndex = $state(-1);
  /**
   * Whether the active item should LOOK chosen — the same split OverflowMenu
   * draws, and for the same reason: the ARIA pattern moves focus into the menu
   * on open, but a menu opened with the mouse has not been told which item the
   * operator wants, and painting one as chosen would arm it invisibly.
   */
  let highlighted = $state(false);
  let root: HTMLElement | null = $state(null);
  let menu: HTMLElement | null = $state(null);

  /**
   * `menuitemradio` for a menu of modes, plain `menuitem` for a menu of
   * commands.
   *
   * `aria-checked` is not a property `menuitem` supports, and the distinction is
   * not pedantry here: a check drawn beside "Present full screen" tells a
   * sighted operator which mode they are defaulted to, and without the radio
   * role there is nothing that tells anybody else. The two members are mutually
   * exclusive and choosing one deselects the other, which is what the role
   * means.
   *
   * Items are only given the radio role when the caller has actually said
   * something about selection, so a future menu of plain actions is unaffected.
   */
  function menuItemRole(item: SplitMenuItem): Record<string, unknown> {
    return item.selected === undefined
      ? { role: 'menuitem' }
      : { role: 'menuitemradio', 'aria-checked': item.selected };
  }

  // Both roles, because one menu may hold both kinds.
  const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"]';

  function itemButtons(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)] : [];
  }

  function focusItem(index: number, highlight = true): void {
    activeIndex = index;
    if (highlight) highlighted = true;
    void tick().then(() => {
      if (open) itemButtons()[index]?.focus();
    });
  }

  function openMenu(index = firstEnabledIndex(items), highlight = true): void {
    open = true;
    focusItem(index, highlight);
  }

  function closeMenu(restoreFocus: boolean): void {
    if (!open) return;
    open = false;
    activeIndex = -1;
    highlighted = false;
    if (restoreFocus) root?.querySelector<HTMLElement>('.caret')?.focus();
  }

  /**
   * `detail` tells a pointer click from a key-synthesised one — see
   * OverflowMenu, which documents why that is the only available discriminator
   * and why getting it wrong leaves a keyboard user inside a menu with nothing
   * drawn to say where they are.
   */
  function toggle(event?: MouseEvent): void {
    if (open) {
      closeMenu(true);
      return;
    }
    openMenu(firstEnabledIndex(items), !event || event.detail === 0);
  }

  function onTriggerKeydown(event: KeyboardEvent): void {
    if (open) return;
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
      closeMenu(false);
      return;
    }
    const index = nextMenuIndex(items, activeIndex, event.key);
    if (index === null) return;
    event.preventDefault();
    focusItem(index);
  }

  function choose(item: SplitMenuItem): void {
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

  // A closed menu must not keep a stale highlight for the next open, and a
  // button that becomes disabled mid-menu (a take starting) must not leave one
  // on screen over a control that no longer does anything.
  $effect(() => {
    if (disabled && open) closeMenu(false);
  });
</script>

<div class="split {variant}" class:open bind:this={root}>
  <button type="button" class="main" data-focus="control" {disabled} onclick={() => onclick?.()}>
    {label}
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button
    type="button"
    class="caret"
    data-focus="control"
    {disabled}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={menuLabel}
    onclick={toggle}
    onkeydown={onTriggerKeydown}
  >
    <Icon name="chevron-down" size={15} />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="menu" role="menu" tabindex="-1" aria-label={menuLabel} bind:this={menu} onkeydown={onMenuKeydown}>
      {#each items as item, index (item.label)}
        <button
          type="button"
          class="item"
          class:active={highlighted && index === activeIndex}
          {...menuItemRole(item)}
          tabindex={menuItemTabIndex(activeIndex, index)}
          disabled={item.disabled}
          onclick={() => choose(item)}
          onpointerenter={() => {
            if (!item.disabled) focusItem(index);
          }}
        >
          <span class="tick" aria-hidden="true">
            {#if item.selected}<Icon name="check" size={15} />{/if}
          </span>
          <span class="text">
            <span class="item-label">{item.label}</span>
            {#if item.description}<span class="item-desc">{item.description}</span>{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  /*
    ONE bordered box with an internal divider, not two adjacent buttons.

    Two buttons would each carry their own rounded border, which is the
    "border inside a border" the workspace avoids — and butting two rounded
    rectangles together produces exactly the one-sided-border look that is
    banned elsewhere in this app. So the container owns the border, the radius
    and the shadow, and the two halves are transparent regions inside it.
  */
  .split {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    min-height: var(--button-h);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-control);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-card);
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      opacity var(--dur-fast) var(--ease-out);
  }

  .main,
  .caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }

  .main {
    padding-inline: 14px;
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    border-start-start-radius: var(--radius-sm);
    border-end-start-radius: var(--radius-sm);
  }
  .caret {
    padding-inline: var(--space-2);
    border-start-end-radius: var(--radius-sm);
    border-end-end-radius: var(--radius-sm);
  }

  /*
    Inset top and bottom so the rule never reaches the rounded corners — a
    divider that ran the full height would read as a seam between two boxes
    rather than as one control with two halves.
  */
  .divider {
    width: 1px;
    margin-block: 5px;
    background: var(--border-control);
    transition: background var(--dur-fast) var(--ease-out);
  }

  .split:not(.disabled):hover {
    border-color: var(--border-strong);
  }
  .main:hover:not(:disabled),
  .caret:hover:not(:disabled) {
    background: var(--bg-hover-surface);
  }
  /* Darkens rather than shrinks (§23.5, §9.3) — see `Button.svelte`. */
  .main:active:not(:disabled),
  .caret:active:not(:disabled) {
    background: var(--bg-secondary);
  }

  /* Primary — the same solid clay fill and 15px hero label as Button. */
  .primary {
    background: var(--accent);
    border-color: var(--accent-strong);
    color: var(--accent-contrast);
  }
  .primary .main {
    font-size: var(--text-base);
  }
  .primary .divider {
    /* A wash of the contrast colour, so the rule reads on the clay fill
       without introducing a second hue. */
    background: color-mix(in srgb, var(--accent-contrast) 34%, transparent);
  }
  .primary .main:hover:not(:disabled),
  .primary .caret:hover:not(:disabled),
  .primary.open .caret {
    background: var(--accent-strong);
  }

  .split:has(.main:disabled) {
    box-shadow: none;
  }
  .primary:has(.main:disabled) {
    background: var(--bg-secondary);
    border-color: var(--border);
    color: var(--text-muted);
  }
  .primary:has(.main:disabled) .divider {
    background: var(--border);
  }
  .split:not(.primary):has(.main:disabled) {
    opacity: 0.5;
  }
  .main:disabled,
  .caret:disabled {
    cursor: not-allowed;
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    /*
      Right-aligned and always downwards. Both Present buttons live in a page
      header at the top of a screen, so there is no case where the room is
      below — the flip arithmetic OverflowMenu needs (it opens on rows in a
      scrolling list) would be dead code here.
    */
    right: 0;
    z-index: 40;
    min-width: 264px;
    display: flex;
    flex-direction: column;
    padding: var(--space-2);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
    /* The trigger may be a clay fill; the menu is never one. */
    color: var(--text-primary);
  }

  .item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    padding: var(--space-2) var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    transition: background var(--dur-fast) var(--ease-out);
  }
  /* A menu highlights, it does not ring — see OverflowMenu's note. */
  .item:focus,
  .item:focus-visible {
    outline: none;
  }
  /* A solid clay fill with an inverse label and description: the highlight is
     the only focus indicator a menu row has — see OverflowMenu. */
  .item.active:not(:disabled) {
    background: var(--accent-strong);
    color: var(--accent-contrast);
  }
  .item.active:not(:disabled) .tick,
  .item.active:not(:disabled) .item-desc {
    color: inherit;
  }
  .item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .tick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Reserved whether or not a check is drawn, so the labels of a checked and
       an unchecked item start at the same x. */
    width: 15px;
    height: 20px;
    flex: none;
    color: var(--accent-strong);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .item-label {
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 20px;
  }
  .item-desc {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    line-height: 1.35;
  }
</style>
