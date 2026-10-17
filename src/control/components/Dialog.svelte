<!--
  Modal dialog / confirm sheet. Focus moves into the panel on open, Escape
  closes, and focus returns to the opener. The panel itself never wears an
  accent ring — elevation and the scrim carry the modality.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { FOCUSABLE_SELECTOR, nextTrapFocus } from './dialog-focus';

  interface Props {
    open: boolean;
    title: string;
    /**
     * `wide` makes room for a footer of four actions (the take summary);
     * `lg` widens the panel for two-column content (revision browser).
     */
    size?: 'md' | 'wide' | 'lg';
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let { open, title, size = 'md', onclose, children, footer }: Props = $props();

  const uid = $props.id();
  let panel: HTMLElement | null = $state(null);
  let previousFocus: HTMLElement | null = null;

  $effect(() => {
    if (open && panel) {
      previousFocus = document.activeElement as HTMLElement | null;
      // `:not(:disabled)` matches the Tab trap below — focusing a disabled
      // control silently leaves focus on the body, which is the state that
      // used to break Escape.
      const target =
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
        panel; // the panel itself is tabindex="-1"
      target.focus();
      return () => {
        previousFocus?.focus();
      };
    }
    return undefined;
  });

  /**
   * The handler lives on the window, not the panel. Clicking non-focusable
   * dialog content (the summary `<dl>`, the shortcuts table, a confirm
   * paragraph) makes `document.activeElement` the `<body>`, and a
   * panel-scoped handler then never sees the key: Escape stopped closing and
   * Tab walked the page behind an `aria-modal="true"` scrim.
   */
  $effect(() => {
    if (!open || !panel) return undefined;
    const onKeydown = (event: KeyboardEvent): void => {
      if (!panel) return;
      // Topmost dialog only, so a stacked dialog does not close its parent.
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== panel) return;

      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        onclose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const active = document.activeElement as HTMLElement | null;
      const next = nextTrapFocus(focusables, active, event.shiftKey, panel.contains(active));
      if (next) {
        event.preventDefault();
        next.focus();
      }
    };
    window.addEventListener('keydown', onKeydown, true);
    return () => window.removeEventListener('keydown', onKeydown, true);
  });

  /*
   * Dismiss on a click of the scrim — but only a gesture that both BEGAN and
   * ENDED on the scrim.
   *
   * `click` alone cannot tell a dismissing tap from the end of a drag, and
   * checking `event.target` does not rescue it: when a press and a release land
   * on different elements the browser targets the click at their nearest common
   * ancestor, and for anything inside this dialog that ancestor IS the scrim.
   * So `e.target === e.currentTarget` is true for BOTH directions of drag —
   * selecting a line of the take summary and overshooting the panel, and
   * pressing on the backdrop and releasing inside it. Neither is a dismissal,
   * and the first one used to throw the dialog away with the selection still in
   * hand.
   *
   * Both ends of the gesture are therefore recorded from the pointer events and
   * the click only consults them. This is what Radix, React Aria and Ark all
   * do. Two details that are easy to get wrong and silently lose the fix:
   *
   *   - touch and pen IMPLICITLY capture the pointer on the element that was
   *     pressed, so without releasing that capture every `pointerup` would be
   *     reported against the scrim no matter where the finger actually lifted,
   *     and the reverse drag would dismiss again on exactly the devices where
   *     dragging is most likely;
   *   - the gesture is tied to one `pointerId`, so a second finger cannot
   *     overwrite the first one's press, and one pointer's release can never
   *     complete another's.
   */
  let gesturePointer: number | null = null;
  let pressedScrim = false;
  let releasedScrim = false;

  function onScrimPointerDown(event: PointerEvent): void {
    // Primary contact only: a right- or middle-press is not a dismissal, and it
    // must not arm one either. A second finger mid-gesture is ignored.
    if (event.button !== 0 || event.isPrimary === false) return;
    if (gesturePointer !== null && gesturePointer !== event.pointerId) return;

    const scrim = event.currentTarget as Element;
    if (scrim.hasPointerCapture?.(event.pointerId)) scrim.releasePointerCapture(event.pointerId);

    gesturePointer = event.pointerId;
    pressedScrim = event.target === event.currentTarget;
    releasedScrim = false;
  }

  function onScrimPointerUp(event: PointerEvent): void {
    if (event.pointerId !== gesturePointer) return;
    releasedScrim = event.target === event.currentTarget;
  }

  function forgetGesture(): void {
    gesturePointer = null;
    pressedScrim = false;
    releasedScrim = false;
  }

  function onScrimClick(event: MouseEvent): void {
    const dismissing = pressedScrim && releasedScrim;
    // One press, one verdict: a stale `true` must never authorise a later click
    // that had no press of its own (a keyboard-synthesised one, say).
    forgetGesture();
    if (dismissing && event.target === event.currentTarget) onclose?.();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="scrim"
    role="presentation"
    onpointerdown={onScrimPointerDown}
    onpointerup={onScrimPointerUp}
    onpointercancel={forgetGesture}
    onclick={onScrimClick}
  >
    <div
      class="panel {size}"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="{uid}-title"
      bind:this={panel}
    >
      <h2 class="title" id="{uid}-title">{title}</h2>
      <div class="body">
        {@render children?.()}
      </div>
      {#if footer}
        <div class="footer">{@render footer()}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: var(--dialog-scrim);
    padding: var(--space-8);
    animation: scrim-in var(--dur-fast) var(--ease-out);
  }
  @keyframes scrim-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .panel {
    width: min(460px, 100%);
    max-height: min(80vh, 640px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-6);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
  }
  .panel.wide {
    width: min(560px, 100%);
  }
  /* Two-column content (the revision browser) needs room; the panel then
     owns the scroll boundary itself rather than scrolling as one column. */
  .panel.lg {
    width: min(860px, 100%);
    max-height: min(86vh, 760px);
    overflow: hidden;
  }
  .panel.lg .body {
    min-height: 0;
    overflow: hidden;
  }

  .title {
    margin: 0;
    font-size: var(--text-xl);
    line-height: var(--lh-section);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    min-width: 0;
  }

  /*
   * Wraps rather than squeezes. A button may shrink below its label (it has
   * `min-width: 0` so an ellipsizing caller can be shorter than its text), and
   * in a row that cannot wrap the labels then spill out of their borders and
   * over each other — which is what the take summary's four actions did.
   */
  .footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }
</style>
