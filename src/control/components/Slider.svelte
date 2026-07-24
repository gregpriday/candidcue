<!--
  Range slider — the track/thumb skin lives in tokens.css; this adds the
  label + tabular value readout.
-->
<script lang="ts">
  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    format?: (value: number) => string;
    disabled?: boolean;
    onchange?: (value: number) => void;
  }

  let {
    value = $bindable(),
    min,
    max,
    step = 1,
    label,
    format = (v: number) => String(v),
    disabled = false,
    onchange,
  }: Props = $props();

  const uid = $props.id();

  function handleInput(event: Event): void {
    value = Number((event.currentTarget as HTMLInputElement).value);
    onchange?.(value);
  }
</script>

<div class="slider" class:disabled>
  <div class="head">
    <label class="label" for={uid}>{label}</label>
    <span class="value">{format(value)}</span>
  </div>
  <input id={uid} type="range" {min} {max} {step} {value} {disabled} oninput={handleInput} />
</div>

<style>
  .slider {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .disabled {
    opacity: 0.55;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .value {
    font-size: var(--text-meta);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
