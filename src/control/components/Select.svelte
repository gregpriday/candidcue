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
    /**
     * A concise sentence under the label. Settings rows only (§25.2: one
     * sentence in an ordinary row; operational detail belongs in help).
     */
    description?: string;
    /**
     * `row` puts the label and its description on the left and the control on
     * the right, in a fixed grid — §14.3's form-row anatomy.
     *
     * Stacked is still the default because that is what a narrow panel and a
     * dialog want. What §14.3 is actually about is a SETTINGS SECTION, where a
     * column of stacked label-over-control pairs makes every row a different
     * width and nothing lines up down the page; `row` is how a section's
     * controls end up on one vertical axis.
     */
    layout?: 'stacked' | 'row';
    disabled?: boolean;
    onchange?: (value: string) => void;
  }

  let {
    value = $bindable(),
    options,
    label,
    description,
    layout = 'stacked',
    disabled = false,
    onchange,
  }: Props = $props();

  const uid = $props.id();

  function handleChange(event: Event): void {
    value = (event.currentTarget as HTMLSelectElement).value;
    onchange?.(value);
  }
</script>

<div class="field {layout}">
  {#if label}
    <span class="text">
      <label class="label" for={uid}>{label}</label>
      <!-- Described BY id, not merely rendered beside: text that only sits near
           a control is text a screen reader never connects to it. -->
      {#if description}
        <span class="description" id="{uid}-description">{description}</span>
      {/if}
    </span>
  {/if}
  <div class="control">
    <select
      id={uid}
      class="select"
      aria-describedby={description ? `${uid}-description` : undefined}
      {disabled}
      {value}
      onchange={handleChange}
    >
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
  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  /*
   * A host can restyle every field label at once through these two — Settings
   * gives its rows the switch's label treatment so a select, a slider and a
   * switch in one section read as one kind of row. Stacked fields elsewhere
   * keep the quieter label they always had.
   */
  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: var(--field-label-weight, 600);
    color: var(--field-label-color, var(--text-secondary));
  }
  .description {
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  /*
   * The form-row grid (§14.3): label and description left, control right.
   *
   * The control column is a FIXED width rather than a share, which is the part
   * that makes a section line up — a percentage would give a row with a long
   * label a narrower select than the row above it, and §26.3 asks for settings
   * labels and controls to align across sections.
   *
   * `--settings-control-w` so a section can widen the column once for a control
   * that genuinely needs it, instead of every row inventing its own.
   */
  .field.row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: var(--control-h);
  }
  .field.row .control {
    flex: 0 0 var(--settings-control-w, 220px);
    max-width: 100%;
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
  /* As TextField: the border/background shift accompanies the central quiet
     inset edge rather than standing in for it. */
  .select:focus,
  .select:focus-visible {
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
