<!--
  Titled content section — sentence-case heading with quiet authority,
  optional description and trailing actions.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    actions?: Snippet;
    children?: Snippet;
  }

  let { title, description, actions, children }: Props = $props();
</script>

<section class="section">
  <div class="header">
    <div class="heading">
      <h2 class="title">{title}</h2>
      {#if description}<p class="description">{description}</p>{/if}
    </div>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </div>
  <div class="body">
    {@render children?.()}
  </div>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .heading {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .title {
    margin: 0;
    font-size: var(--text-section);
    line-height: var(--lh-section);
    font-weight: 600;
    letter-spacing: 0;
    color: var(--text-primary);
  }

  .description {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 0 0 auto;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
</style>
