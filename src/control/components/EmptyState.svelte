<!--
  Calm empty-state invitation on the warm empty tokens. No illustrations,
  no feature carousel (spec §12.3).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    body?: string;
    actions?: Snippet;
  }

  let { title, body, actions }: Props = $props();
</script>

<div class="empty">
  <h2 class="title">{title}</h2>
  {#if body}<p class="body">{body}</p>{/if}
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-10) var(--space-8);
    border: 1px solid var(--empty-border);
    border-radius: var(--radius-md);
    background: var(--empty-bg);
    text-align: center;
  }

  .title {
    margin: 0;
    font-family: var(--font-serif);
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }

  .body {
    margin: 0;
    max-width: var(--prose-measure-narrow);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--empty-text);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-2);
    flex-wrap: wrap;
    justify-content: center;
  }
</style>
