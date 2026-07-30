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
  }

  let { label, value, description }: Props = $props();
</script>

<div class="readout">
  <span class="label">{label}</span>
  <span class="value">{value}</span>
  {#if description}<p class="description">{description}</p>{/if}
</div>

<style>
  .readout {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
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
</style>
