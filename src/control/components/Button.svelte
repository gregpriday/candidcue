<!--
  Flat button: a 1px outline on the neutral variants, a solid accent fill on
  primary, a darkening press. No shadow, no darker "lip" on the fill, no
  gradient, no glow — and one label size, 13px, on every variant.

  That is the owner's settled recipe, arrived at over many rounds: the darker
  border lip read as a "cheap heavy outline", the 15px primary label as
  "chunky" beside the 13px buttons next to it (most visibly Import beside
  New script in the Library toolbar), and every shadow as decoration. Weight
  comes from the fill and, on the hero action, from height — not from a
  bigger label.
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
    /** The id of visible text that explains what the button does. */
    describedby?: string;
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
    describedby,
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
  aria-describedby={describedby}
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
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    /* Never wider than the row it sits in. A caller with a label that can run
       long wraps it in something that ellipsizes (`Settings.svelte`'s rig
       action); this is what gives that something a box to be shorter than. */
    max-width: 100%;
    min-width: 0;
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

  /* Primary — a solid accent fill, edge to edge in the fill's own colour. */
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast);
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
    border-color: var(--danger);
    color: var(--danger-contrast);
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
</style>
