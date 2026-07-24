<!--
  Native select restyled on tokens; quiet focus (bg/border shift only).
-->
<script lang="ts">
  import Icon from './Icon.svelte';

  export interface SelectOption {
    value: string;
    label: string;
    disabled?: boolean;
  }

  interface Props {
    value: string;
    options: SelectOption[];
    label?: string;
    disabled?: boolean;
    onchange?: (value: string) => void;
  }

  let { value = $bindable(), options, label, disabled = false, onchange }: Props = $props();

  const uid = $props.id();

  function handleChange(event: Event): void {
    value = (event.currentTarget as HTMLSelectElement).value;
    onchange?.(value);
  }
</script>

<div class="field">
  {#if label}
    <label class="label" for={uid}>{label}</label>
  {/if}
  <div class="control">
    <select id={uid} class="select" {disabled} {value} onchange={handleChange}>
      {#each options as option (option.value)}
        <option value={option.value} disabled={option.disabled}>{option.label}</option>
      {/each}
    </select>
    <span class="chevron"><Icon name="chevron-down" size={14} /></span>
  </div>
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .control {
    position: relative;
    display: flex;
  }

  .select {
    appearance: none;
    width: 100%;
    height: var(--control-h);
    padding: 0 calc(var(--space-3) + 20px) 0 var(--space-3);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 500;
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .select:hover:not(:disabled) {
    border-color: var(--border-strong);
  }
  .select:focus,
  .select:focus-visible {
    outline: none;
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }
  .select:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .chevron {
    position: absolute;
    display: flex;
    right: var(--space-3);
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--text-muted);
  }
</style>
