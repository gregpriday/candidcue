<!--
  Switch. Accent fill when on; the button opts in with `data-focus="control"`,
  which is what earns it the accent focus ring — under the policy in
  `tokens.css` an unmarked button takes the quiet inset edge instead.
-->
<script lang="ts">
  interface Props {
    checked: boolean;
    label: string;
    description?: string;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
  }

  let { checked = $bindable(), label, description, disabled = false, onchange }: Props = $props();

  const uid = $props.id();

  function toggle(): void {
    if (disabled) return;
    checked = !checked;
    onchange?.(checked);
  }
</script>

<div class="toggle-row" class:disabled>
  <span class="text">
    <label class="label" for={uid}>{label}</label>
    <!-- Described BY id, not merely rendered beside: text that only sits near a
         control is text a screen reader never connects to it. -->
    {#if description}<span class="description" id="{uid}-description">{description}</span>{/if}
  </span>
  <button
    type="button"
    id={uid}
    class="switch"
    class:on={checked}
    data-focus="control"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    aria-describedby={description ? `${uid}-description` : undefined}
    {disabled}
    onclick={toggle}
  >
    <span class="knob" aria-hidden="true"></span>
  </button>
</div>

<style>
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: var(--icon-control-h);
  }
  /* As Slider: the label and switch fade, the description that explains them
     stays readable. */
  .disabled .label,
  .disabled .switch {
    opacity: 0.55;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
    cursor: pointer;
  }
  .description {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .switch {
    position: relative;
    flex: 0 0 auto;
    width: 38px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-pill);
    background: var(--bg-secondary);
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .switch:disabled {
    cursor: not-allowed;
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg-panel);
    box-shadow: var(--shadow-card);
    transition: transform var(--dur-med) var(--ease-out);
  }
  .on {
    background: var(--accent);
    border-color: var(--accent-strong);
  }
  .on .knob {
    transform: translateX(16px);
    /* The knob sits on the accent fill once it is on, so it wears the accent's
       own contrast colour rather than a literal white that only happened to
       work in one theme. */
    background: var(--accent-contrast);
  }
</style>
