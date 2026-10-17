<!--
  A setting that is a FACT rather than a choice.

  Some settings have exactly one value this release can honestly offer. The
  temptation is to keep the dropdown and disable what is unavailable, which is
  what this screen used to do in two places — a one-item Motion profile select,
  and a Session mode select whose other two entries were permanently disabled
  and labelled "not available in this release".

  Both read as a decision the user is being asked to make. Neither is one. A
  control shaped like a choice, offering none, spends the reader's attention on
  working out that there was nothing here for them — and it does it every time
  they open the screen.

  So this states the value and says why it is the only one, in the same visual
  slot a control would occupy, with nothing focusable in it. When a second
  option genuinely arrives, the call site swaps back to a real `Select` and the
  user meets a choice the first time there is one to make.

  Deliberately quiet by house rule: no border, no accent, no focus treatment.
  This is not a disabled control (which implies "later, or elsewhere") and must
  not look like one; it is a label and its answer.
-->
<script lang="ts">
  interface Props {
    label: string;
    /** The single value in force. */
    value: string;
    /** Why it is the only one — the sentence that stops the reader hunting. */
    description?: string;
    /**
     * `row` sets the value on the trailing edge, where a Select's or a
     * switch's value sits in the rows around it — so a section of form rows
     * keeps one axis for "what is it set to" whichever kind of row says it.
     */
    layout?: 'stacked' | 'row';
  }

  let { label, value, description, layout = 'stacked' }: Props = $props();
</script>

<div class="readout {layout}">
  {#if layout === 'row'}
    <span class="text">
      <span class="label">{label}</span>
      {#if description}<span class="description">{description}</span>{/if}
    </span>
    <span class="value">{value}</span>
  {:else}
    <span class="label">{label}</span>
    <span class="value">{value}</span>
    {#if description}<p class="description">{description}</p>{/if}
  {/if}
</div>

<style>
  .readout {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  /* See Select: a host can give every field label one treatment. */
  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: var(--field-label-weight, 600);
    color: var(--field-label-color, var(--text-secondary));
  }
  .value {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
  }
  .description {
    margin: 2px 0 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  .row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .row .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .row .description {
    margin: 0;
  }
  /* The value in ink, like the value inside a select beside it. In the
     description's grey it read as the stray end of the description. */
  .row .value {
    flex: 0 0 auto;
    line-height: var(--lh-label);
    text-align: right;
  }
</style>
