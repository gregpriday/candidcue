<!--
  "A newer Speaking Glass is available" — quiet, non-modal, in the document window
  only (docs/updates.md, #191).

  NOT A NATIVE DIALOG, AND NOT IN THE TOAST STACK. A native dialog takes focus
  and can come up over the glass; the toast stack is drawn on the prompter
  during a take. This card is part of the control window's own page, docked in
  the bottom leading corner (the toasts own the trailing one), and it renders
  NOTHING while `hidden` is true — which the shell sets for the whole of a take,
  from the moment one starts arming until the glass is gone. The update is
  held, not dropped: when the take ends, the card is there.

  Nothing here decides whether an install is safe. Rust refuses one during a
  take, verifies the signature, and picks the server; this only asks.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import type { UpdateNoticeState } from '../stores/updates';

  interface Props {
    notice: UpdateNoticeState;
    /** A take is starting, running or still on the glass: draw nothing. */
    hidden: boolean;
    oninstall: () => void;
    onlater: () => void;
    ondownload: () => void;
  }

  let { notice, hidden, oninstall, onlater, ondownload }: Props = $props();

  const titleId = $props.id();

  const percent = $derived(
    notice.kind === 'downloading' && notice.fraction !== null ? Math.round(notice.fraction * 100) : null,
  );
</script>

{#if !hidden && notice.kind !== 'hidden'}
  <section class="update-notice" aria-labelledby={titleId} data-testid="update-notice">
    {#if notice.kind === 'available'}
      <h2 class="title" id={titleId}>Speaking Glass {notice.version} is available</h2>
      {#if notice.canInstall}
        <p class="body">
          You have {notice.currentVersion}. Installing restarts Speaking Glass; your scripts and settings
          stay as they are.
        </p>
        <div class="actions">
          <Button size="sm" variant="ghost" onclick={onlater}>Later</Button>
          <Button size="sm" variant="primary" onclick={oninstall}>Install and Restart</Button>
        </div>
      {:else}
        <p class="body">
          You have {notice.currentVersion}. This copy of Speaking Glass cannot update itself, so download
          the new version from speakingglass.com.
        </p>
        <div class="actions">
          <Button size="sm" variant="ghost" onclick={onlater}>Later</Button>
          <Button size="sm" variant="primary" onclick={ondownload}>Download</Button>
        </div>
      {/if}
    {:else if notice.kind === 'downloading'}
      <h2 class="title" id={titleId}>Downloading Speaking Glass {notice.version}</h2>
      <p class="body" role="status">
        {percent === null ? 'Starting the download…' : `${percent}% downloaded`}
      </p>
      <progress
        class="bar"
        max="1"
        value={notice.fraction ?? undefined}
        aria-label="Update download progress"
        aria-valuetext={percent === null ? 'Starting' : `${percent} percent`}
      ></progress>
    {:else if notice.kind === 'installing'}
      <h2 class="title" id={titleId}>Installing Speaking Glass {notice.version}</h2>
      <p class="body" role="status">
        The download passed its signature check. Speaking Glass will close and reopen when it is done.
      </p>
      <progress class="bar" max="1" aria-label="Installing the update"></progress>
    {:else if notice.kind === 'restarting'}
      <h2 class="title" id={titleId}>Restarting Speaking Glass</h2>
      <p class="body" role="status">Speaking Glass {notice.version} is installed and opening now.</p>
    {:else if notice.kind === 'failed'}
      <h2 class="title" id={titleId}>Speaking Glass {notice.version} was not installed</h2>
      <p class="body" role="alert">{notice.message}</p>
      <div class="actions">
        <Button size="sm" variant="ghost" onclick={onlater}>Close</Button>
        <Button size="sm" variant="default" onclick={oninstall}>Try Again</Button>
      </div>
    {/if}
  </section>
{/if}

<style>
  /*
   * A floating surface like the toast tray it mirrors across the window: the
   * same glass, the same rim and shadow, all round. No one-sided accent edge —
   * the primary button carries the colour.
   */
  .update-notice {
    position: fixed;
    left: var(--page-x);
    bottom: calc(var(--statusbar-h) + var(--space-3));
    z-index: 120;
    width: min(320px, calc(100vw - 2 * var(--page-x)));
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--glass-fill);
    -webkit-backdrop-filter: var(--glass-backdrop);
    backdrop-filter: var(--glass-backdrop);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-float);
    box-shadow:
      inset 0 0 0 1px var(--glass-inner-edge),
      var(--glass-shadow);
    color: var(--text-primary);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    animation: update-in var(--dur-med) var(--ease-out);
  }

  .title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: var(--lh-label);
  }

  .body {
    margin: 0;
    color: var(--text-secondary);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .bar {
    display: block;
    width: 100%;
    height: 6px;
    appearance: none;
    border: none;
    border-radius: var(--radius-pill);
    background: var(--bg-sunken);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    overflow: hidden;
  }
  .bar::-webkit-progress-bar {
    background: transparent;
    border-radius: var(--radius-pill);
  }
  .bar::-webkit-progress-value {
    background: var(--accent);
    border-radius: var(--radius-pill);
  }
  .bar::-moz-progress-bar {
    background: var(--accent);
    border-radius: var(--radius-pill);
  }
  .bar:indeterminate {
    background:
      linear-gradient(-45deg, var(--accent) 25%, transparent 25% 50%, var(--accent) 50% 75%, transparent 75%)
        0 0 / 12px 12px,
      var(--bg-sunken);
    animation: update-indeterminate 0.6s linear infinite;
  }

  @keyframes update-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes update-indeterminate {
    from {
      background-position:
        0 0,
        0 0;
    }
    to {
      background-position:
        12px 0,
        0 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .update-notice,
    .bar:indeterminate {
      animation: none;
    }
  }
</style>
