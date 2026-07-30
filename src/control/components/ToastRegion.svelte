<!--
  Floating toast notices, bottom-center. Announced via a polite live region
  (spec §20) — streaming transcript text never routes through here.

  BOTTOM INSET. The region floats over whatever is beneath it, and each toast
  is `pointer-events: auto` because it owns a dismiss button. Anchored a flat
  24px from the viewport bottom, that put every toast squarely on top of the
  Live screen's always-visible transport bar and ate its clicks — and `danger`
  toasts never auto-dismiss (deliberately: a failure must not scroll past
  unseen), so the manual transport was unreachable in exactly the situations
  that produce a danger toast. Rather than shortening the timeout or making the
  toast non-interactive, the region reads `--toast-safe-bottom`: a route that
  owns a fixed bottom bar publishes that bar's height plus the normal inset,
  and the toasts stack above it. Everywhere else the fallback is unchanged.
-->
<script lang="ts">
  import { toasts, dismissToast } from '../stores/toasts';
  import Icon from './Icon.svelte';

  /* Failures are announced assertively and stay until dismissed; everything
     else is polite and self-clearing (spec §20). */
  const failures = $derived($toasts.filter((t) => t.tone === 'danger'));
  const notices = $derived($toasts.filter((t) => t.tone !== 'danger'));
</script>

<div class="region">
  <div class="stack" role="status" aria-live="polite">
    {#each notices as toast (toast.id)}
      <div class="toast {toast.tone}">
        <span class="dot" aria-hidden="true"></span>
        <span class="message">{toast.message}</span>
        <button
          type="button"
          class="dismiss"
          data-focus="control"
          aria-label="Dismiss notification"
          onclick={() => dismissToast(toast.id)}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/each}
  </div>
  <div class="stack" role="alert">
    {#each failures as toast (toast.id)}
      <div class="toast danger">
        <span class="dot" aria-hidden="true"></span>
        <span class="message">{toast.message}</span>
        <button
          type="button"
          class="dismiss"
          data-focus="control"
          aria-label="Dismiss notification"
          onclick={() => dismissToast(toast.id)}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/each}
  </div>
</div>

<style>
  .region {
    position: fixed;
    left: 50%;
    bottom: var(--toast-safe-bottom, var(--space-6));
    transform: translateX(-50%);
    z-index: 120;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: center;
    pointer-events: none;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: center;
  }

  .toast {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    max-width: 420px;
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
    font-size: var(--text-sm);
    color: var(--text-primary);
    pointer-events: auto;
    animation: toast-in var(--dur-med) var(--ease-out);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .success .dot {
    background: var(--success);
  }
  .info .dot {
    background: var(--accent);
  }
  .danger .dot {
    background: var(--danger);
  }

  .message {
    min-width: 0;
  }

  .dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin: -2px;
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .dismiss:hover {
    color: var(--text-primary);
    background: var(--bg-hover-surface);
  }
</style>
