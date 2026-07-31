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
    /** Optional one-line explanation, rendered under the track like Toggle's. */
    description?: string;
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
    description,
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
  <input
    id={uid}
    type="range"
    {min}
    {max}
    {step}
    {value}
    {disabled}
    aria-describedby={description ? `${uid}-description` : undefined}
    oninput={handleInput}
  />
  <!-- Described BY id: an explanation rendered under the track is invisible to
       a screen reader unless the control points at it. -->
  {#if description}<p class="description" id="{uid}-description">{description}</p>{/if}
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
  .description {
    margin: 2px 0 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
</style>
