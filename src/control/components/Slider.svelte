<!--
  Range slider — the track/thumb skin lives in tokens.css; this adds the
  label + tabular value readout.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    /** Optional one-line explanation, rendered under the track like Toggle's. */
    description?: string;
    /**
     * The id of an explanation that lives OUTSIDE the slider — a note shared by
     * a group, or a hint with markup a description string cannot carry. Read
     * with the slider, alongside its own description.
     */
    describedby?: string;
    format?: (value: number) => string;
    /**
     * The value as it should be SPOKEN, when `format` writes it with a symbol
     * a screen reader would read literally ("29.9′", "22.9 ch"). Defaults to
     * `format`, which is right for px, % and wpm.
     */
    spoken?: (value: number) => string;
    /**
     * Words for the two ends of the track, for a slider that trades one
     * quality against another rather than counting something. Rendered under
     * the track, at the end each one describes.
     */
    minLabel?: string;
    maxLabel?: string;
    disabled?: boolean;
    onchange?: (value: number) => void;
    /**
     * Controls that sit on the track's own row, after it — the appearance
     * panel's −/+ steppers. The label and value row above keeps the full width,
     * so the value lines up with every other slider's in the same column.
     */
    trailing?: Snippet;
  }

  let {
    value = $bindable(),
    min,
    max,
    step = 1,
    label,
    description,
    describedby,
    format = (v: number) => String(v),
    spoken,
    minLabel,
    maxLabel,
    disabled = false,
    onchange,
    trailing,
  }: Props = $props();

  const uid = $props.id();

  /*
   * The filled part of the track (tokens.css reads `--range-from` and
   * `--range-fill`). From the start of the track to the thumb — or, for a
   * range that runs either side of zero (a lens offset, letter spacing), from
   * zero to the thumb, so 0 reads as nothing filled rather than half.
   */
  const position = (at: number): number =>
    max > min ? ((Math.min(max, Math.max(min, at)) - min) / (max - min)) * 100 : 0;
  const signed = $derived(min < 0 && max > 0);
  const fillFrom = $derived(signed ? Math.min(position(0), position(value)) : 0);
  const fillTo = $derived(signed ? Math.max(position(0), position(value)) : position(value));

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
  <!-- `aria-valuetext`: the formatted value is the meaning ("140 wpm", "38%"),
       and without it a screen reader announces the bare number. -->
  {#snippet range()}
    <input
      id={uid}
      type="range"
      {min}
      {max}
      {step}
      {value}
      {disabled}
      style="--range-from: {fillFrom}%; --range-fill: {fillTo}%"
      aria-valuetext={(spoken ?? format)(value)}
      aria-describedby={[describedby, description ? `${uid}-description` : undefined]
        .filter(Boolean)
        .join(' ') || undefined}
      oninput={handleInput}
    />
  {/snippet}
  {#if trailing}
    <div class="track-row">
      {@render range()}
      {@render trailing()}
    </div>
  {:else}
    {@render range()}
  {/if}
  {#if minLabel || maxLabel}
    <div class="ends" aria-hidden="true">
      <span>{minLabel}</span>
      <span>{maxLabel}</span>
    </div>
  {/if}
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
  /* The control fades; its description does not. The description is what
     says WHY it is unavailable, and fading it with the rest made the one
     readable explanation on the row the hardest thing on it to read. */
  .disabled .head,
  .disabled input,
  .disabled .ends {
    opacity: 0.55;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  /* See Select: a host can give every field label one treatment. */
  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    /* A setting's NAME, in the primary label colour at a regular weight —
       the same as a Toggle's — so a row with a menu and a row with a switch
       read as the same kind of thing. (Grey semibold beside Toggle's black
       made "On launch" look like a caption and its neighbour a setting.) */
    font-weight: var(--field-label-weight, 500);
    color: var(--field-label-color, var(--text-primary));
  }
  .value {
    font-size: var(--text-meta);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .track-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .track-row input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .ends {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .description {
    margin: 2px 0 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  /* Apart from the end labels, so it does not read as a third one. */
  .ends + .description {
    margin-top: var(--space-2);
  }
</style>
