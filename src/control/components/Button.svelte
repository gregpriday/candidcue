<!--
  Premium-flat button: darker 1px border "lip", --shadow-card micro-lift,
  darkening press. No gradients, no glow. Primary is a solid clay fill
  with a 15px hero label.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /**
     * `danger` is the low-emphasis destructive TRIGGER (a toolbar's "Empty
     * Trash", a transport's "Stop"); `danger-primary` is the filled CONFIRM,
     * and belongs only where the click cannot be taken back.
     */
    variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'danger-primary';
    size?: 'md' | 'sm';
    disabled?: boolean;
    type?: 'button' | 'submit';
    title?: string;
    /**
     * The rendered element, for callers that must move focus onto this button
     * deliberately (RevisionHistory's confirm step). Exposed rather than left to
     * a `querySelector` on a private class name, which would break silently the
     * moment the class is renamed.
     */
    element?: HTMLButtonElement | null;
    onclick?: (event: MouseEvent) => void;
    children?: Snippet;
  }

  let {
    variant = 'default',
    size = 'md',
    disabled = false,
    type = 'button',
    title,
    element = $bindable(null),
    onclick,
    children,
  }: Props = $props();
</script>

<button
  bind:this={element}
  class="button {variant} {size}"
  data-focus="control"
  {type}
  {disabled}
  {title}
  {onclick}
>
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
      opacity var(--dur-fast) var(--ease-out);
  }
  .button:hover:not(:disabled) {
    background: var(--bg-hover-surface);
    border-color: var(--border-strong);
  }
  /*
   * A press DARKENS; it does not shrink (§23.5, §9.3).
   *
   * `transform: scale(0.98)` is a mobile-app affordance and it is what a
   * toolbar full of them reads as. §23.5 asks for nonessential hover lift and
   * button scaling to be removed, and §9.3 says the same about press scaling
   * specifically. What replaces it is a real press state — one the previous
   * recipe did not have at all, because the transform was doing that job.
   */
  .button:active:not(:disabled) {
    background: var(--bg-secondary);
    border-color: var(--border-strong);
  }
  .primary:active:not(:disabled) {
    background: var(--accent-strong);
  }
  .danger-primary:active:not(:disabled) {
    background: var(--danger-strong);
  }
  .ghost:active:not(:disabled),
  .danger:active:not(:disabled) {
    background: var(--bg-hover-chrome);
  }
  .button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /*
   * `sm` is 28px, not 32.
   *
   * It used to be `--icon-control-h`, which was 32 while the default was 36. The
   * desktop pass brought the default down to 32 — and left both variants
   * resolving to the same number, so `size="sm"` silently stopped meaning
   * anything and every row of buttons in the app lost its size hierarchy.
   * `--toolbar-control-h` is the compact tier and keeps the two apart.
   */
  .sm {
    min-height: var(--toolbar-control-h);
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

  /* Ghost recedes into toolbars. */
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

  /* Danger — the low-emphasis TRIGGER. Recedes into a toolbar or a transport,
     where it sits for the whole session and must not compete with the primary
     action beside it. */
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

  /*
   * Danger-primary — the same solid recipe as primary, in red.
   *
   * A destructive confirm used to be a borderless text button reading at
   * exactly the weight of the Cancel beside it, so the one action that cannot
   * be taken back was the only one on screen with no visually primary button.
   * Filled, it is unmistakably the thing being asked about.
   *
   * Deliberately NOT what `danger` became. The persistent triggers (Stop
   * session, Stop test, Empty Trash) are not confirmations: filling those would
   * put a permanent red block beside the real primary and give the screen two
   * competing hero actions. This variant belongs on the confirming half of a
   * destructive pair and nowhere else.
   */
  .danger-primary {
    background: var(--danger);
    border-color: var(--danger-strong);
    color: var(--danger-contrast);
    font-size: var(--text-base);
  }
  .danger-primary:hover:not(:disabled) {
    background: var(--danger-strong);
    border-color: var(--danger-strong);
  }
  /* Neutral when disabled, like primary — dimming a red fill reads as a
     softer warning rather than an unavailable control. */
  .danger-primary:disabled {
    opacity: 1;
    background: var(--bg-secondary);
    border-color: var(--border);
    color: var(--text-muted);
    box-shadow: none;
  }
  .danger-primary.sm {
    font-size: var(--text-sm);
  }
</style>
