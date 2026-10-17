<!--
  Recursive SafeRenderNode renderer. Text + marks only — no HTML pass-through
  (spec Appendix C: "do not use SafeRenderNode as disguised arbitrary HTML").
  The one picture it draws comes from a url Rust resolved (PreviewImage).
-->
<script lang="ts">
  import type { SafeRenderNode } from '../../shared/contracts';
  import type { PreviewImages } from '../lib/preview-images';
  import PreviewImage from './PreviewImage.svelte';
  import RenderNodes from './RenderNodes.svelte';

  interface Props {
    nodes: SafeRenderNode[];
    /** Per asset id. Without it an image renders as a plain reference. */
    images?: PreviewImages;
  }

  let { nodes, images }: Props = $props();

  function hasMark(
    node: Extract<SafeRenderNode, { type: 'text' }>,
    mark: 'strong' | 'em' | 'strike' | 'code',
  ): boolean {
    return node.marks?.includes(mark) ?? false;
  }
</script>

{#each nodes as node, index (index)}
  {#if node.type === 'text'}
    <span
      class="t"
      class:strong={hasMark(node, 'strong')}
      class:em={hasMark(node, 'em')}
      class:strike={hasMark(node, 'strike')}
      class:code={hasMark(node, 'code')}>{node.text}</span
    >
  {:else if node.type === 'line_break'}
    <br />
  {:else if node.type === 'link'}
    <span class="link"><RenderNodes nodes={node.label} {images} /></span>
  {:else if node.type === 'image'}
    <PreviewImage assetId={node.assetId} alt={node.alt} image={images?.[node.assetId]} />
  {:else if node.type === 'table'}
    <table class="table">
      {#if node.headerRow && node.rows.length > 0}
        <thead>
          <tr>
            {#each node.rows[0] ?? [] as cell, colIndex}
              <th style:text-align={node.align[colIndex] ?? 'left'}>
                <RenderNodes nodes={cell} {images} />
              </th>
            {/each}
          </tr>
        </thead>
      {/if}
      <tbody>
        {#each node.rows.slice(node.headerRow ? 1 : 0) as row}
          <tr>
            {#each row as cell, colIndex}
              <td style:text-align={node.align[colIndex] ?? 'left'}>
                <RenderNodes nodes={cell} {images} />
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if node.type === 'cue'}
    <span class="cue-inline">{node.label}</span>
  {/if}
{/each}

<style>
  .strong {
    font-weight: 700;
    color: var(--text-primary);
  }
  .em {
    font-style: italic;
  }
  .strike {
    text-decoration: line-through;
    color: var(--text-muted);
  }
  .code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--bg-sunken);
    border-radius: 4px;
    padding: 0 4px;
  }
  .link {
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  /* Table reference card (spec §24.6). Row separation is a background band,
     never a nested border inside the block's own surface. */
  .table {
    border-collapse: collapse;
    font-size: calc(var(--text-sm) * var(--doc-scale, 1));
    line-height: calc(var(--lh-label) * var(--doc-scale, 1));
    min-width: 100%;
  }
  .table th,
  .table td {
    padding: var(--space-1) var(--space-3);
    vertical-align: baseline;
  }
  .table th {
    font-weight: 650;
    color: var(--text-primary);
    white-space: nowrap;
  }
  .table tbody tr:nth-child(odd) {
    background: var(--bg-sunken);
  }
  .cue-inline {
    display: inline-flex;
    padding: 0 var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 0.85em;
    font-weight: 600;
  }
</style>
