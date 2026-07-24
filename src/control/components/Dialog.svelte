<!--
  Modal dialog / confirm sheet. Focus moves into the panel on open, Escape
  closes, and focus returns to the opener. The panel itself never wears an
  accent ring — elevation and the scrim carry the modality.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    title: string;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let { open, title, onclose, children, footer }: Props = $props();

  const uid = $props.id();
  let panel: HTMLElement | null = $state(null);
  let previousFocus: HTMLElement | null = null;

  $effect(() => {
    if (open && panel) {
      previousFocus = document.activeElement as HTMLElement | null;
      const target =
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.querySelector<HTMLElement>('button, input, select, textarea, a[href]');
      target?.focus();
      return () => {
        previousFocus?.focus();
      };
    }
    return undefined;
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose?.();
      return;
    }
    if (event.key === 'Tab' && panel) {
      const focusables = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
        ),
      ];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="scrim" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose?.()}>
    <div
      class="panel"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="{uid}-title"
      bind:this={panel}
      onkeydown={handleKeydown}
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
    background: rgba(15, 17, 21, 0.4);
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

  .footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }
</style>
