<!--
  Compact 32px icon control. `label` is mandatory — it becomes the accessible
  name and tooltip (spec §20).
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './icon-names';

  interface Props {
    icon: IconName;
    label: string;
    disabled?: boolean;
    active?: boolean;
    danger?: boolean;
    size?: number;
    /**
     * Set for a control that opens a popup. A menu button is NOT a toggle
     * button, so `aria-pressed` is dropped in favour of
     * `aria-haspopup`/`aria-expanded` — announcing "pressed" for something
     * that opens a menu is simply the wrong promise.
     */
    haspopup?: 'menu' | 'dialog' | 'listbox' | 'true';
    expanded?: boolean;
    onclick?: (event: MouseEvent) => void;
    onkeydown?: (event: KeyboardEvent) => void;
  }

  let {
    icon,
    label,
    disabled = false,
    active = false,
    danger = false,
    size = 18,
    haspopup,
    expanded,
    onclick,
    onkeydown,
  }: Props = $props();
</script>

<button
  type="button"
  class="icon-button"
  class:active
  class:danger
  data-focus="control"
  aria-label={label}
  aria-pressed={haspopup === undefined && active ? 'true' : undefined}
  aria-haspopup={haspopup}
  aria-expanded={haspopup === undefined ? undefined : expanded ? 'true' : 'false'}
  title={label}
  {disabled}
  {onclick}
  {onkeydown}
>
  <Icon name={icon} {size} />
</button>

<style>
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--icon-control-h);
    height: var(--icon-control-h);
    flex: 0 0 auto;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      transform var(--dur-press) var(--ease-out);
  }
  .icon-button:hover:not(:disabled) {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  .icon-button:active:not(:disabled) {
    transform: scale(0.98);
  }
  .icon-button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Toggled state — a seated white pill, same selection language as the rail. */
  .active,
  .active:hover:not(:disabled) {
    background: var(--bg-panel);
    border-color: var(--border);
    box-shadow: var(--shadow-card);
    color: var(--accent-strong);
  }

  .danger:hover:not(:disabled) {
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
