<!--
  One settings row for a control that is not a field of its own — a segmented
  choice, most often.

  `Select` (with `layout="row"`), `Toggle` and `SettingReadout` each lay their
  label out on the left and their value on the right. A segmented control had
  no row of its own, so every call site invented one: stacked under a label in
  one section, stretched across the whole column in another, and in one place
  with no visible label at all. This is that row, once, on the same axis as the
  others.

  The control is a snippet that receives the description's id, so the control
  can point `aria-describedby` at the sentence that explains it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    description?: string;
    control: Snippet<[string | undefined]>;
  }

  let { label, description, control }: Props = $props();

  const uid = $props.id();
  const descriptionId = $derived(description ? `${uid}-description` : undefined);
</script>

<div class="setting-row">
  <span class="text">
    <span class="label">{label}</span>
    {#if description}<span class="description" id={descriptionId}>{description}</span>{/if}
  </span>
  <div class="control">{@render control(descriptionId)}</div>
</div>

<style>
  /* Centred on the label and its description, as Select's and Toggle's rows
     are — one rule for where a row's control sits, whatever the control. */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: var(--control-h);
    min-width: 0;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  /* See Select: a host can give every field label one treatment. */
  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: var(--field-label-weight, 500);
    color: var(--field-label-color, var(--text-primary));
  }
  .description {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .control {
    flex: 0 0 auto;
    display: flex;
  }
</style>
