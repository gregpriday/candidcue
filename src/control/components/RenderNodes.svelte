<!--
  Recursive SafeRenderNode renderer. Text + marks only — no HTML pass-through
  (spec Appendix C: "do not use SafeRenderNode as disguised arbitrary HTML").
  The one picture it draws comes from a url Rust resolved (PreviewImage).
-->
<script lang="ts">
  import type { SafeRenderNode } from '../../shared/contracts';
  import type { PreviewImages } from '../lib/preview-images';
  import { resolveWordTokens } from '../../stage/renderer/word-tokens';
  import Icon from './Icon.svelte';
  import PreviewImage from './PreviewImage.svelte';
  import RenderNodes from './RenderNodes.svelte';

  interface Props {
    nodes: SafeRenderNode[];
    /** Per asset id. Without it an image renders as a plain reference. */
    images?: PreviewImages;
  }

  let { nodes, images }: Props = $props();

  type TextNode = Extract<SafeRenderNode, { type: 'text' }>;

  function hasMark(node: TextNode, mark: 'strong' | 'em' | 'strike' | 'code'): boolean {
    return node.marks?.includes(mark) ?? false;
  }

  /*
   * The spoken token each word of the run anchors, comma-separated, empty
   * where a word is not spoken — so a click in the preview can land the caret
   * on the word that was clicked rather than at the top of its paragraph.
   * Words are split exactly as the stage splits them (`segmentText`), and the
   * mapping is the stage's own, so the two can never count words differently.
   */
  function wordTokensOf(node: TextNode): string | undefined {
    if (!node.tokenIndexes?.length && !node.wordTokens?.length) return undefined;
    const words = node.text.split(/\s+/).filter((word) => word.length > 0);
    return resolveWordTokens(words.length, node.tokenIndexes, node.wordTokens)
      .map((token) => (token === null ? '' : String(token)))
      .join(',');
  }
</script>

{#each nodes as node, index (index)}
  {#if node.type === 'text'}
    <span
      class="t"
      class:strong={hasMark(node, 'strong')}
      class:em={hasMark(node, 'em')}
      class:strike={hasMark(node, 'strike')}
      class:code={hasMark(node, 'code')}
      data-words={wordTokensOf(node)}>{node.text}</span
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
    {#if node.cueType === 'take'}
      <!-- A part break inside a sentence. It divides the script, which no
           other cue does, so it never wears the cue chip: neutral, with the
           flag the Insert toolbar uses for the same directive. -->
      <span class="part-inline"
        ><span class="part-glyph" aria-hidden="true"><Icon name="flag" size={12} /></span
        ><span class="sr-only">Part break: </span>{node.label}</span
      >
    {:else}
      <!-- Direction, not speech, said in words too: read straight through, a
           cue would otherwise run into the sentence around it. -->
      <span class="cue-inline"
        ><span class="sr-only">Cue: </span>{node.label}<span class="sr-only">{' (not spoken)'}</span></span
      >
    {/if}
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
    padding: 0 0.25em;
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
    padding: calc(var(--space-1) * var(--doc-scale, 1)) calc(var(--space-3) * var(--doc-scale, 1));
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
  /*
   * Inline, not inline-flex, and cloned at a wrap: the stage's cue (#281).
   * An inline-flex chip is an atomic box, so it pushed its line apart from
   * the lines around it and, too long for the column, became a two-line oval
   * with one word orphaned in it. Inline, its padding sits outside the line
   * box, and each row of a wrapped chip keeps its own rounded ends.
   */
  .cue-inline,
  .part-inline {
    padding: 0.12em 0.5em;
    border-radius: var(--radius-pill);
    font-size: 0.85em;
    font-weight: 600;
    /* The paragraph's line height is an absolute length, and inherited at a
       smaller font it still opened the line by a pixel or two. The chip's
       background is drawn from its font, not its line height. */
    line-height: 1;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  .cue-inline {
    background: var(--warning-soft);
    color: var(--warning);
  }
  .part-inline {
    background: var(--bg-sunken);
    color: var(--text-secondary);
  }
  .part-glyph {
    display: inline-block;
    margin-right: 0.3em;
    vertical-align: -0.1em;
  }
  /* In `em` of the chip, so it grows with the document's text. */
  .part-glyph :global(.lucide-icon) {
    display: inline-block;
    width: 1em;
    height: 1em;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
