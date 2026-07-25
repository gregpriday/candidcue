<!--
  Generic list row on a white panel: quiet surface-fill hover, no lift, no
  one-sided borders. Selection is a quiet wash + firmer full border.

  A single click selects AND opens.

  It used to select on click and open on double-click, which read as a dead
  row: the only feedback a click produced was a quiet background wash, so
  clicking a script in the library looked like nothing had happened. Nothing
  needed the two-step — every row carries its own Present button, so opening on
  click costs no other action — and it also made the row's keyboard behaviour
  wrong, since Enter on a focused row fired `click` and therefore only ever
  selected.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    meta?: string;
    excerpt?: string;
    selected?: boolean;
    leading?: Snippet;
    trailing?: Snippet;
    onopen?: () => void;
    onselect?: () => void;
  }

  let { title, meta, excerpt, selected = false, leading, trailing, onopen, onselect }: Props =
    $props();
</script>

<div class="row" class:selected class:interactive={Boolean(onopen ?? onselect)}>
  <button
    type="button"
    class="main"
    onclick={() => {
      // Select first: a caller may open by navigating, and the selection is
      // what the library remembers for when the user comes back.
      onselect?.();
      onopen?.();
    }}
    aria-current={selected ? 'true' : undefined}
  >
    {#if leading}<span class="leading">{@render leading()}</span>{/if}
    <span class="text">
      <span class="title">{title}</span>
      {#if excerpt}<span class="excerpt">{excerpt}</span>{/if}
      {#if meta}<span class="meta">{meta}</span>{/if}
    </span>
  </button>
  {#if trailing}
    <div class="trailing">{@render trailing()}</div>
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .interactive:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover-surface);
  }
  .selected,
  .selected:hover {
    border-color: var(--border-strong);
    background: var(--accent-wash);
  }

  .main {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: transparent;
    padding: 0;
    text-align: left;
    color: inherit;
    border-radius: var(--radius-sm);
    /* Row focus is a quiet surface shift, not an accent ring (owner rule). */
    outline: none;
  }
  .main:focus-visible {
    outline: none;
  }
  .row:has(.main:focus-visible) {
    border-color: var(--border-strong);
    background: var(--bg-hover-surface);
  }

  .leading {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-muted);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .title {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .excerpt {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }

  .trailing {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 0 0 auto;
  }
</style>
