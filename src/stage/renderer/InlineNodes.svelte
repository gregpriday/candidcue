<!--
  Safe inline render-node presenter (spec §45.6): hydrates SafeRenderNodes
  into known elements only — never arbitrary HTML. Word segments carry
  data-t="<tokenIndex>" anchors so tracking can position individual tokens.
-->
<script lang="ts">
  import type { SafeRenderNode } from '../../shared/contracts';
  import { segmentText } from './text';
  import Self from './InlineNodes.svelte';

  let {
    nodes,
    cursor = null,
    assets = {},
    showCues = true,
  }: {
    nodes: SafeRenderNode[];
    /** Current token index; word tokens below it get the past treatment. */
    cursor?: number | null;
    assets?: Record<string, { url: string; mime: string; width?: number; height?: number }>;
    showCues?: boolean;
  } = $props();

  function markClasses(marks?: ('strong' | 'em' | 'strike' | 'code')[]): string {
    if (!marks || marks.length === 0) return '';
    return marks.map((m) => `m-${m}`).join(' ');
  }
</script>

{#each nodes as node}
  {#if node.type === 'text'}
    {#each segmentText(node.text, node.tokenIndexes) as seg}
      {#if seg.space}
        <span class="sp">{seg.text}</span>
      {:else if seg.tokenIndex !== null}
        <span
          class="w {markClasses(node.marks)}"
          class:past={cursor !== null && seg.tokenIndex < cursor}
          class:current={cursor !== null && seg.tokenIndex === cursor}
          data-t={seg.tokenIndex}>{seg.text}</span>
      {:else}
        <span class="w {markClasses(node.marks)}">{seg.text}</span>
      {/if}
    {/each}
  {:else if node.type === 'line_break'}
    <br />
  {:else if node.type === 'link'}
    <!-- Links are inert on stage: label only, never navigable. -->
    <span class="link"><Self nodes={node.label} {cursor} {assets} {showCues} /></span>
  {:else if node.type === 'image'}
    {#if assets[node.assetId]}
      <img class="inline-img" src={assets[node.assetId]?.url} alt={node.alt} draggable="false" />
    {:else}
      <!-- Unresolved asset: readable alt text rather than a silent hole. -->
      <span class="img-fallback">{node.alt || 'Image unavailable'}</span>
    {/if}
  {:else if node.type === 'table'}
    <!-- A table nested in inline flow (a stage-only or quoted block that wraps
         one) still renders as rows, not as nothing. -->
    <table class="inline-table">
      <tbody>
        {#each node.rows as row}
          <tr>
            {#each row as cell, colIndex}
              <td style:text-align={node.align[colIndex] ?? 'left'}>
                <Self nodes={cell} {assets} {showCues} />
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if node.type === 'cue'}
    {#if showCues}
      <span class="cue" data-cue-type={node.cueType}>{node.label}</span>
    {/if}
  {/if}
{/each}

<style>
  /* Per-word past dimming. The opacity below is how the presenter sees where
     they are and never changes; the tween is a §61 nonessential effect and is
     zeroed by `--stage-fx-ms` on the script layer while frames are being
     missed — this is the biggest single win of the three, because it is one
     interpolation per rendered WORD. */
  .w {
    transition-property: opacity;
    transition-duration: var(--stage-fx-ms, 240ms);
    transition-timing-function: var(--ease-out, ease-out);
  }
  .w.past {
    opacity: var(--stage-past-opacity, 0.42);
  }
  /*
   * The word the prompter believes is being spoken right now.
   *
   * Past words already dim, but dimming answers "where have I been", not
   * "is this thing following me" — a presenter reading a short script could
   * not tell a working take from a dead one, because the only moving part was
   * a fade they were not looking at.
   *
   * An underline rather than a highlight or a colour: it sits below the
   * baseline, so it never alters the glyphs, never changes their spacing, and
   * cannot reflow the line under the reader mid-sentence. Drawn with
   * `text-decoration` for exactly that reason — a border or a background box
   * would participate in layout.
   */
  .w.current {
    text-decoration: underline;
    text-decoration-color: var(--stage-cursor, currentColor);
    text-decoration-thickness: 0.06em;
    text-underline-offset: 0.18em;
    /* The cursor moves word to word at speaking rate; a transition here would
       smear it across the words in between rather than land on one. */
    transition: none;
  }
  /* §16.4 reduced motion changes nothing here: this is a static mark, not an
     animation, and it is the one cue that says the take is alive. */
  .m-strong {
    font-weight: 700;
  }
  .m-em {
    font-style: italic;
  }
  .m-strike {
    text-decoration: line-through;
  }
  .m-code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.92em;
  }
  .link {
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
    text-underline-offset: 0.14em;
  }
  .inline-img {
    max-width: 100%;
    max-height: var(--stage-image-max-h, 78vh);
    border-radius: 12px;
    display: block;
    margin: 0.4em auto;
  }
  .img-fallback {
    color: color-mix(in srgb, currentColor 70%, transparent);
    font-style: italic;
  }
  .inline-table {
    border-collapse: collapse;
    font-size: 0.85em;
  }
  .inline-table td {
    padding: 0.2em 0.5em;
    vertical-align: baseline;
  }
  .cue {
    color: var(--stage-cue);
    font-size: 0.55em;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    vertical-align: middle;
    padding: 0.1em 0.55em;
    border-radius: 999px;
    background: color-mix(in srgb, var(--stage-cue) 12%, transparent);
    white-space: nowrap;
  }
</style>
