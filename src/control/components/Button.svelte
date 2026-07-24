<!--
  Premium-flat button: darker 1px border "lip", --shadow-card micro-lift,
  scale(0.98) press. No gradients, no glow. Primary is a solid clay fill
  with a 15px hero label.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    variant?: 'default' | 'primary' | 'ghost' | 'danger';
    size?: 'md' | 'sm';
    disabled?: boolean;
    type?: 'button' | 'submit';
    title?: string;
    onclick?: (event: MouseEvent) => void;
    children?: Snippet;
  }

  let {
    variant = 'default',
    size = 'md',
    disabled = false,
    type = 'button',
    title,
    onclick,
    children,
  }: Props = $props();
</script>

<button class="button {variant} {size}" {type} {disabled} {title} {onclick}>
  {@render children?.()}
</button>

<style>
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: var(--button-h);
    padding-inline: 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-control);
    background: var(--bg-elevated);
    color: var(--text-primary);
    box-shadow: var(--shadow-card);
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      transform var(--dur-press) var(--ease-out),
      opacity var(--dur-fast) var(--ease-out);
  }
  .button:hover:not(:disabled) {
    background: var(--bg-hover-surface);
    border-color: var(--border-strong);
  }
  .button:active:not(:disabled) {
    transform: scale(0.98);
  }
  .button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .sm {
    min-height: var(--icon-control-h);
    padding-inline: var(--space-3);
    font-size: var(--text-sm);
  }

  /* Primary — solid clay fill, darker lip, 15px hero label. */
  .primary {
    background: var(--accent);
    border-color: var(--accent-strong);
    color: var(--accent-contrast);
    font-size: var(--text-base);
  }
  .primary:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .primary:disabled {
    opacity: 1;
    background: var(--bg-secondary);
    border-color: var(--border);
    color: var(--text-muted);
    box-shadow: none;
  }
  .primary.sm {
    font-size: var(--text-sm);
  }

  /* Ghost & danger recede into toolbars. */
  .ghost {
    background: transparent;
    border-color: transparent;
    color: var(--text-secondary);
    box-shadow: none;
    padding-inline: var(--space-2);
  }
  .ghost:hover:not(:disabled) {
    background: var(--bg-hover-chrome);
    border-color: transparent;
    color: var(--text-primary);
  }

  .danger {
    background: transparent;
    border-color: transparent;
    color: var(--danger);
    box-shadow: none;
  }
  .danger:hover:not(:disabled) {
    background: var(--danger-soft);
    border-color: transparent;
  }
</style>
