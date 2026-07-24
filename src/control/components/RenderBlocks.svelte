<!--
  Rendered preview of CompiledScript blocks (spec §13.2). Consumes only the
  compiler contract's SafeRenderNode structure — never raw HTML.
-->
<script lang="ts">
  import type { CompiledBlock, SafeRenderNode } from '../../shared/contracts';
  import RenderNodes from './RenderNodes.svelte';

  interface Props {
    blocks: CompiledBlock[];
    onblockclick?: (block: CompiledBlock) => void;
  }

  let { blocks, onblockclick }: Props = $props();

  function headingLevel(block: CompiledBlock): number {
    const hint = block.layoutHints?.['level'];
    const level = typeof hint === 'number' ? hint : 2;
    return Math.min(6, Math.max(1, level));
  }

  function nodesOf(block: CompiledBlock): SafeRenderNode[] {
    return block.renderNodes;
  }
</script>

<div class="doc">
  {#each blocks as block (block.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
    <div
      class="block kind-{block.kind}"
      data-block-id={block.id}
      class:silent={!block.spoken && block.kind !== 'cue'}
      role={onblockclick ? 'button' : undefined}
      tabindex={onblockclick ? 0 : undefined}
      onclick={() => onblockclick?.(block)}
      onkeydown={(e) => {
        if (onblockclick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onblockclick(block);
        }
      }}
    >
      {#if block.kind === 'heading'}
        {#if headingLevel(block) === 1}
          <h1 class="h h1"><RenderNodes nodes={nodesOf(block)} /></h1>
        {:else if headingLevel(block) === 2}
          <h2 class="h h2"><RenderNodes nodes={nodesOf(block)} /></h2>
        {:else}
          <h3 class="h h3"><RenderNodes nodes={nodesOf(block)} /></h3>
        {/if}
      {:else if block.kind === 'cue'}
        <p class="cue"><RenderNodes nodes={nodesOf(block)} /></p>
      {:else if block.kind === 'divider'}
        <hr class="divider" />
      {:else if block.kind === 'code' || block.kind === 'diagram'}
        <pre class="code"><RenderNodes nodes={nodesOf(block)} /></pre>
      {:else if block.kind === 'blockquote'}
        <blockquote class="quote"><RenderNodes nodes={nodesOf(block)} /></blockquote>
      {:else if block.kind === 'table'}
        <!-- Not wrapped in <p>: a table inside a paragraph is invalid HTML and
             the browser breaks it out of the element, so the card must be its
             own scroll container. -->
        <div class="table-card"><RenderNodes nodes={nodesOf(block)} /></div>
      {:else}
        <p class="para"><RenderNodes nodes={nodesOf(block)} /></p>
      {/if}
    </div>
  {/each}
</div>

<style>
  .doc {
    max-width: var(--prose-measure);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .block[role='button'] {
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast) var(--ease-out);
    /* Focus on a preview block: quiet surface shift, not an accent ring. */
    outline: none;
  }
  .block[role='button']:hover,
  .block[role='button']:focus-visible {
    background: var(--bg-hover-surface);
  }

  .h {
    margin: 0;
    color: var(--text-primary);
    letter-spacing: var(--ls-title);
    font-weight: 650;
  }
  .h1 {
    font-family: var(--font-serif);
    font-size: var(--text-3xl);
    line-height: 1.25;
    margin-top: var(--space-4);
  }
  .h2 {
    font-size: var(--text-2xl);
    line-height: 1.3;
    margin-top: var(--space-3);
  }
  .h3 {
    font-size: var(--text-xl);
    line-height: var(--lh-section);
  }

  .para {
    margin: 0;
    font-size: var(--text-lg);
    line-height: var(--lh-transcript);
    color: var(--prose-text-warm);
    letter-spacing: var(--ls-prose);
  }

  /* Cue chip — visually distinct, clearly not spoken text (spec §23.2). */
  .cue {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-pill);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: var(--text-sm);
    font-weight: 600;
    width: fit-content;
  }

  .silent {
    opacity: 0.62;
  }

  .quote {
    margin: 0;
    position: relative;
    padding-left: var(--space-4);
    color: var(--prose-secondary-warm);
    font-style: italic;
  }
  /* Leading rule as an inset bar — never a one-sided border on a rounded box. */
  .quote::before {
    content: '';
    position: absolute;
    left: 0;
    top: 2px;
    bottom: 2px;
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--border-strong);
  }

  .code {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    border: 1px solid var(--border-faint);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    overflow-x: auto;
  }

  .table-card {
    overflow-x: auto;
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }

  .divider {
    border: none;
    height: 1px;
    background: var(--border);
    margin: var(--space-2) 0;
  }
</style>
