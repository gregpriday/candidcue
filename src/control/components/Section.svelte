<!--
  Titled content section — sentence-case heading with quiet authority,
  optional description and trailing actions.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    /** An anchor, for a link that has to land on this section rather than on the page. */
    id?: string;
    actions?: Snippet;
    children?: Snippet;
  }

  let { title, description, id, actions, children }: Props = $props();
</script>

<section class="section" {id}>
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
    /* Lands with air above it when a link scrolls it into view. */
    scroll-margin-top: var(--space-6);
  }

  /*
   * The actions WRAP under the heading when the row is short of room.
   *
   * They used to be `flex: 0 0 auto` beside a heading that could shrink to
   * nothing, and a button label is `white-space: nowrap` — so one long action
   * ("Re-calibrate Elgato Prompter (9-inch) (identified by its 1024 x 600
   * panel)…") crushed "This rig" and its description into a column one word
   * wide, with the rest of the panel empty. The heading now keeps a readable
   * floor and the actions drop to their own line, right-aligned, when the two
   * cannot share one.
   *
   * Aligned to the TOP, beside the title. Bottom-aligned, the actions sat level
   * with the last line of a long description, detached from the heading they
   * belong to.
   */
  .header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3) var(--space-4);
  }

  .heading {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    /* The floor: below this the actions wrap rather than the heading. */
    flex: 1 1 28ch;
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

  /* The prose measure every paragraph in Settings keeps, so an introduction
     and the notes below it wrap at the same width. */
  .description {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
    max-width: var(--prose-measure);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    /* Shrinks and wraps; `margin-left: auto` keeps it on the right once it
       has a line of its own. */
    flex: 0 1 auto;
    min-width: 0;
    max-width: 100%;
    margin-left: auto;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
</style>
