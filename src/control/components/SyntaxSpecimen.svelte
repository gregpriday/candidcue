<!--
  One syntax reference example as a take draws it on the glass, in the
  control window's light palette.

  The blocks are the compiler's own, already projected for a take
  (`lib/syntax-specimens.ts`), and their text goes through RenderNodes, so what
  shows here is what compiling the example leaves on the glass. What this file
  adds is the glass's vocabulary at reading size: a cue is an upper-case
  capsule, an unspoken heading is a quiet label in the cue colour, and silent
  and stage notes are quieter than the script. The colours are the workspace's
  stand-ins for the stage's — the cue gold becomes `--warning`, as it is in the
  editor's preview — because a black panel inside this one would be a second
  frame on the page.

  Not a renderer for scripts. It draws the handful of shapes the reference's
  examples compile to, and draws anything else as a plain line.
-->
<script lang="ts">
  import type { CompiledBlock } from '../../shared/contracts';
  import { listMarker } from '../../shared/list-marker';
  import RenderNodes from './RenderNodes.svelte';

  interface Props {
    blocks: CompiledBlock[];
  }

  let { blocks }: Props = $props();
</script>

<div class="specimen">
  {#each blocks as block (block.id)}
    {#if block.kind === 'heading' && !block.spoken}
      <p class="quiet-heading"><RenderNodes nodes={block.renderNodes} /></p>
    {:else if block.kind === 'heading'}
      <p class="heading"><RenderNodes nodes={block.renderNodes} /></p>
    {:else if block.kind === 'cue'}
      <p class="cue-line"><RenderNodes nodes={block.renderNodes} /></p>
    {:else if block.kind === 'divider'}
      <hr class="divider" />
    {:else if block.kind === 'silent' || block.kind === 'stage_only'}
      <div class="unspoken"><RenderNodes nodes={block.renderNodes} /></div>
    {:else if block.kind === 'code' || block.kind === 'diagram'}
      <div class="code"><RenderNodes nodes={block.renderNodes} /></div>
    {:else if block.kind === 'blockquote'}
      <p class="quote"><RenderNodes nodes={block.renderNodes} /></p>
    {:else if block.kind === 'list_item'}
      {@const marker = listMarker(block.layoutHints)}
      <p class="item">
        <span class="marker" aria-hidden="true">{#if marker.kind === 'number'}{marker.label}{:else}<span class="bullet"></span>{/if}</span>
        <span><RenderNodes nodes={block.renderNodes} /></span>
      </p>
    {:else}
      <p class="line"><RenderNodes nodes={block.renderNodes} /></p>
    {/if}
  {/each}
</div>

<style>
  .specimen {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-family: var(--font-prose);
    font-size: var(--text-base);
    line-height: 1.45;
    color: var(--text-primary);
  }
  p {
    margin: 0;
  }

  /*
   * A cue, as the glass draws one: an upper-case capsule a step below the
   * line it sits in (stage `InlineNodes.svelte`). RenderNodes draws the
   * editor preview's capsule; this only gives it the glass's casing and
   * tracking.
   */
  .specimen :global(.cue-inline) {
    padding: 0.1em 0.55em;
    font-size: 0.72em;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    vertical-align: 0.1em;
  }

  /* An unspoken heading in a take: one size, the cue colour, not capitals. */
  .quiet-heading {
    font-size: 0.9em;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--warning);
  }
  .heading {
    font-weight: 650;
  }

  /* Silent and stage notes: still direction, so quieter rather than faint. */
  .unspoken {
    font-size: 0.9em;
    color: var(--text-muted);
  }
  /* The preview's own banded table, at the width of its contents. */
  .unspoken :global(.table) {
    min-width: 0;
  }

  .code {
    font-family: var(--font-mono);
    font-size: 0.8em;
    white-space: pre-wrap;
    color: var(--text-muted);
  }

  /* A quote is read like any line; a short rule at its start says it is one. */
  .quote {
    position: relative;
    padding-left: 0.9em;
    color: var(--text-secondary);
  }
  .quote::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.2em;
    bottom: 0.2em;
    width: 2px;
    border-radius: var(--radius-pill);
    background: var(--border-strong);
  }

  .item {
    display: flex;
    align-items: baseline;
    gap: 0.5em;
  }
  .marker {
    flex: none;
    color: var(--text-secondary);
  }
  .bullet {
    display: inline-block;
    width: 0.32em;
    height: 0.32em;
    border-radius: 50%;
    background: var(--text-muted);
    transform: translateY(-0.18em);
  }

  .divider {
    width: 22%;
    height: 2px;
    margin: var(--space-1) auto;
    border: 0;
    border-radius: 999px;
    background: var(--border-strong);
  }
</style>
