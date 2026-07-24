<!--
  Sticky page header: optional back control, 28px editorial title (optionally
  inline-editable), metadata line, trailing status + actions.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface Props {
    title: string;
    meta?: string;
    backLabel?: string;
    onback?: () => void;
    editableTitle?: boolean;
    ontitlechange?: (title: string) => void;
    status?: Snippet;
    actions?: Snippet;
  }

  let { title, meta, backLabel, onback, editableTitle = false, ontitlechange, status, actions }: Props =
    $props();

  function commitTitle(event: Event): void {
    const next = (event.currentTarget as HTMLInputElement).value.trim();
    if (next && next !== title) ontitlechange?.(next);
  }

  function titleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
  }
</script>

<header class="header">
  {#if onback}
    <button type="button" class="back" onclick={onback}>
      <Icon name="chevron-left" size={15} />
      <span>{backLabel ?? 'Back'}</span>
    </button>
  {/if}
  <div class="bar">
    <div class="title-block">
      {#if editableTitle}
        <input
          class="title-input"
          value={title}
          aria-label="Script title"
          onblur={commitTitle}
          onkeydown={titleKeydown}
        />
      {:else}
        <h1 class="title">{title}</h1>
      {/if}
      {#if meta}<p class="meta">{meta}</p>{/if}
    </div>
    <div class="right">
      {#if status}<div class="status">{@render status()}</div>{/if}
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </div>
  </div>
</header>

<style>
  .header {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4) var(--page-x);
    background: var(--bg-canvas);
    border-bottom: 1px solid var(--border);
  }

  .back {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: 28px;
    padding: 0 var(--space-2) 0 var(--space-1);
    margin-left: calc(-1 * var(--space-1));
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 600;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .back:hover {
    color: var(--text-primary);
    background: var(--bg-hover-chrome);
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    min-width: 0;
  }

  .title-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .title {
    margin: 0;
    font-size: var(--text-page-title);
    line-height: var(--lh-page-title);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Editable title looks identical at rest; focus is a quiet surface shift. */
  .title-input {
    margin: 0;
    padding: 0 var(--space-2);
    margin-left: calc(-1 * var(--space-2));
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    font-family: inherit;
    font-size: var(--text-page-title);
    line-height: var(--lh-page-title);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
    min-width: 0;
    width: 100%;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .title-input:hover {
    background: var(--bg-hover-chrome);
  }
  .title-input:focus,
  .title-input:focus-visible {
    outline: none;
    background: var(--bg-panel);
    border-color: var(--border);
  }

  .meta {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 18px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }

  .right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 0 0 auto;
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
