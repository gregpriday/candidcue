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
    onselect: () => void;
  }

  interface Props {
    items: MenuItem[];
    label?: string;
    align?: 'left' | 'right';
  }

  let { items, label = 'More actions', align = 'right' }: Props = $props();

  let open = $state(false);
  let activeIndex = $state(-1);
  let root: HTMLElement | null = $state(null);
  let menu: HTMLElement | null = $state(null);

  function itemButtons(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
  }

  function focusItem(index: number): void {
    activeIndex = index;
    // The item only exists after the menu has rendered.
    void tick().then(() => {
      if (open) itemButtons()[index]?.focus();
    });
  }

  function focusTrigger(): void {
    root?.querySelector<HTMLElement>('button')?.focus();
  }

  function openMenu(index = firstEnabledIndex(items)): void {
    open = true;
    focusItem(index);
  }

  function closeMenu(restoreFocus: boolean): void {
    if (!open) return;
    open = false;
    activeIndex = -1;
    if (restoreFocus) focusTrigger();
  }

  function toggle(): void {
    if (open) closeMenu(true);
    else openMenu();
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
      role="menu"
      tabindex="-1"
      aria-label={label}
      bind:this={menu}
      onkeydown={onMenuKeydown}
    >
      {#each items as item, index (item.label)}
        <button
          type="button"
          class="item"
          class:danger={item.danger}
          role="menuitem"
          tabindex={menuItemTabIndex(activeIndex, index)}
          disabled={item.disabled}
          onclick={() => choose(item)}
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
    top: calc(100% + 4px);
    right: 0;
    z-index: 40;
    min-width: 180px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-1);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-pop);
  }
  .menu.left {
    right: auto;
    left: 0;
  }

  .item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 7px var(--space-3);
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .item:hover:not(:disabled) {
    background: var(--bg-hover-surface);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .item.danger {
    color: var(--danger);
  }
  .item.danger:hover:not(:disabled) {
    background: var(--danger-soft);
  }
</style>
