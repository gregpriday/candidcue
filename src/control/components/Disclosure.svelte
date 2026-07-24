<!--
  Quiet details/summary disclosure for advanced options.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface Props {
    label: string;
    open?: boolean;
    children?: Snippet;
  }

  let { label, open = $bindable(false), children }: Props = $props();
</script>

<details class="disclosure" bind:open>
  <summary class="summary">
    <span class="chevron" class:rotated={open}>
      <Icon name="chevron-right" size={14} />
    </span>
    <span>{label}</span>
  </summary>
  <div class="body">
    {@render children?.()}
  </div>
</details>

<style>
  .disclosure {
    border-top: 1px solid var(--border);
  }

  .summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) 0;
    cursor: pointer;
    list-style: none;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
    transition: color var(--dur-fast) var(--ease-out);
  }
  .summary::-webkit-details-marker {
    display: none;
  }
  .summary:hover {
    color: var(--text-primary);
  }

  .chevron {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-muted);
    transition: transform var(--dur-med) var(--ease-out);
  }
  .rotated {
    transform: rotate(90deg);
  }

  .body {
    padding: 0 0 var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
</style>
