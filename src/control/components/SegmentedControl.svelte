<!--
  Segmented control — sunken track, raised white thumb with dark text.
  No accent underline; the seated pill alone marks the selection.
-->
<script lang="ts">
  export interface SegmentOption {
    value: string;
    label: string;
    disabled?: boolean;
  }

  interface Props {
    options: SegmentOption[];
    value: string;
    label: string;
    size?: 'md' | 'sm';
    onchange?: (value: string) => void;
  }

  let { options, value = $bindable(), label, size = 'md', onchange }: Props = $props();

  function select(option: SegmentOption): void {
    if (option.disabled || option.value === value) return;
    value = option.value;
    onchange?.(option.value);
  }
</script>

<div class="track {size}" role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    <button
      type="button"
      class="segment"
      class:selected={option.value === value}
      role="radio"
      aria-checked={option.value === value}
      disabled={option.disabled}
      onclick={() => select(option)}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  .track {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
  }

  .segment {
    position: relative;
    appearance: none;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    border-radius: 7px;
    font-size: var(--text-sm);
    font-weight: 600;
    white-space: nowrap;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .sm .segment {
    height: 26px;
    padding: 0 10px;
    font-size: var(--text-xs);
  }
  .segment:hover:not(:disabled) {
    color: var(--text-primary);
  }
  .segment:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .selected,
  .selected:hover:not(:disabled) {
    background: var(--bg-panel);
    color: var(--text-primary);
    box-shadow: var(--shadow-card);
  }
</style>
