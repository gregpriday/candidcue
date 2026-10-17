<!--
  Rendered preview of CompiledScript blocks (spec §13.2). Consumes only the
  compiler contract's SafeRenderNode structure — never raw HTML.
-->
<script lang="ts">
  import type { CompiledBlock, SafeRenderNode } from '../../shared/contracts';
  import type { PreviewImages } from '../lib/preview-images';
  import { listMarker, listMarkerGeometry } from '../../shared/list-marker';
  import RenderNodes from './RenderNodes.svelte';

  interface Props {
    blocks: CompiledBlock[];
    /** What is known about each image, by asset id (#250). */
    images?: PreviewImages;
    onblockclick?: (block: CompiledBlock) => void;
  }

  let { blocks, images, onblockclick }: Props = $props();

  function headingLevel(block: CompiledBlock): number {
    const hint = block.layoutHints?.['level'];
    const level = typeof hint === 'number' ? hint : 2;
    return Math.min(6, Math.max(1, level));
  }

  function nodesOf(block: CompiledBlock): SafeRenderNode[] {
    return block.renderNodes;
  }

  /*
   * The same marker the stage draws, from the same function, so the preview and
   * the glass agree about what a list item is. Its widths are in `em` of the
   * item's own type (`.list-item` sets it), which is what keeps the proportions
   * the stage's line planner relies on — though nothing plans lines here.
   */
  function markerOf(block: CompiledBlock) {
    const marker = listMarker(block.layoutHints);
    return { marker, geometry: listMarkerGeometry(marker) };
  }
</script>

<div class="doc">
  {#each blocks as block (block.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
    <div
      class="block kind-{block.kind}"
      data-block-id={block.id}
      class:silent={!block.spoken && block.kind !== 'cue' && block.kind !== 'image'}
      role={onblockclick ? 'button' : undefined}
      tabindex={onblockclick ? 0 : undefined}
      data-focus={onblockclick ? 'surface' : undefined}
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
          <h1 class="h h1"><RenderNodes nodes={nodesOf(block)} {images} /></h1>
        {:else if headingLevel(block) === 2}
          <h2 class="h h2"><RenderNodes nodes={nodesOf(block)} {images} /></h2>
        {:else}
          <h3 class="h h3"><RenderNodes nodes={nodesOf(block)} {images} /></h3>
        {/if}
      {:else if block.kind === 'cue'}
        <p class="cue"><RenderNodes nodes={nodesOf(block)} {images} /></p>
      {:else if block.kind === 'divider'}
        <hr class="divider" />
      {:else if block.kind === 'code' || block.kind === 'diagram'}
        <pre class="code"><RenderNodes nodes={nodesOf(block)} {images} /></pre>
      {:else if block.kind === 'blockquote'}
        <blockquote class="quote"><RenderNodes nodes={nodesOf(block)} {images} /></blockquote>
      {:else if block.kind === 'image'}
        <!-- A picture on its own line is a figure, as on the stage, not a
             paragraph: it takes none of the prose size or line height. -->
        <div class="figure" class:quiet={!block.spoken}>
          <RenderNodes nodes={nodesOf(block)} {images} />
        </div>
      {:else if block.kind === 'list_item'}
        {@const { marker, geometry } = markerOf(block)}
        <!-- The marker is drawn, never read: `aria-hidden`, and outside the
             words, as on the stage. -->
        <div
          class="list-item"
          data-marker={marker.kind}
          data-depth={marker.depth}
          style:padding-left="{geometry.indentEm}em"
          style:column-gap="{geometry.gapEm}em"
        >
          {#if marker.kind === 'number'}
            <span class="marker number" aria-hidden="true" style:width="{geometry.markerEm}em">{marker.label}</span>
          {:else if marker.kind === 'task'}
            <span
              class="marker checkbox"
              class:checked={marker.checked}
              aria-hidden="true"
              data-checked={marker.checked ? 'true' : 'false'}
              style:width="{geometry.markerEm}em"
              style:height="{geometry.markerEm}em"
            ></span>
          {:else}
            <span
              class="marker bullet"
              aria-hidden="true"
              style:width="{geometry.markerEm}em"
              style:height="{geometry.markerEm}em"
            ></span>
          {/if}
          <p class="para list-body"><RenderNodes nodes={nodesOf(block)} {images} /></p>
        </div>
      {:else if block.kind === 'table'}
        <!-- Not wrapped in <p>: a table inside a paragraph is invalid HTML and
             the browser breaks it out of the element, so the card must be its
             own scroll container. -->
        <div class="table-card"><RenderNodes nodes={nodesOf(block)} {images} /></div>
      {:else}
        <p class="para"><RenderNodes nodes={nodesOf(block)} {images} /></p>
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

  /* A preview block is a surface, not a control — the quiet inset edge comes
     from the central focus policy via the `data-focus` attribute below, so the
     background shift here is the accompanying signal rather than the only one. */
  .block[role='button'] {
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast) var(--ease-out);
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

  /*
   * A list item, drawn as the stage draws it: the marker and its widths come
   * from `list-marker.ts`, in `em` of the prose size set here. The colours are
   * the control window's own, because this is the control window.
   */
  .list-item {
    display: flex;
    align-items: baseline;
    font-size: var(--text-lg);
    line-height: var(--lh-transcript);
  }
  .marker {
    flex: none;
  }
  .bullet {
    border-radius: 50%;
    background: var(--text-muted);
    transform: translateY(-0.18em);
  }
  .number {
    display: flex;
    justify-content: flex-end;
    white-space: nowrap;
    color: var(--text-secondary);
    letter-spacing: var(--ls-prose);
  }
  .checkbox {
    position: relative;
    box-sizing: border-box;
    border: 1.5px solid var(--text-muted);
    border-radius: 0.16em;
    transform: translateY(0.04em);
  }
  /* A ticked box in the accent, as a checked control is everywhere else in
     the window; the tick takes the accent's own contrast colour. */
  .checkbox.checked {
    border-color: var(--accent);
    background: var(--accent);
  }
  .checkbox.checked::after {
    content: '';
    position: absolute;
    left: 33%;
    top: 12%;
    width: 30%;
    height: 54%;
    box-sizing: border-box;
    border-style: solid;
    border-color: var(--accent-contrast);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  .list-body {
    flex: 1;
    min-width: 0;
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

  .figure {
    text-align: center;
  }
  /* Unspoken, so quiet like every other silent block, as the stage dims it.
     The picture only: a whole-block opacity would take the "Image not found"
     note under it below a readable contrast. */
  .figure.quiet :global(.preview-img) {
    opacity: 0.62;
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
