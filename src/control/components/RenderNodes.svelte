<!--
  Recursive SafeRenderNode renderer. Text + marks only — no HTML pass-through
  (spec Appendix C: "do not use SafeRenderNode as disguised arbitrary HTML").
-->
<script lang="ts">
  import type { SafeRenderNode } from '../../shared/contracts';
  import RenderNodes from './RenderNodes.svelte';

  interface Props {
    nodes: SafeRenderNode[];
  }

  let { nodes }: Props = $props();

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
    <span class="link"><RenderNodes nodes={node.label} /></span>
  {:else if node.type === 'image'}
    <span class="image-ref" title={node.alt}>[Image: {node.alt || node.assetId}]</span>
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
  .image-ref {
    color: var(--text-muted);
    font-size: var(--text-sm);
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
