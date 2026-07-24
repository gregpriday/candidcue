<!--
  Row/toolbar overflow menu — floating popover with subtle elevation; closes
  on outside click and Escape.
-->
<script lang="ts">
  import IconButton from './IconButton.svelte';

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
  let root: HTMLElement | null = $state(null);

  function toggle(): void {
    open = !open;
  }

  function choose(item: MenuItem): void {
    if (item.disabled) return;
    open = false;
    item.onselect();
  }

  $effect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) open = false;
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') open = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeydown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeydown, true);
    };
  });
</script>

<div class="wrap" bind:this={root}>
  <IconButton icon="dots" {label} active={open} onclick={toggle} />
  {#if open}
    <div class="menu" class:left={align === 'left'} role="menu" aria-label={label}>
      {#each items as item (item.label)}
        <button
          type="button"
          class="item"
          class:danger={item.danger}
          role="menuitem"
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
