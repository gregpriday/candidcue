<!--
  "Your CandidCue library was not copied" (#454).

  The app was CandidCue until October 2026, and Rust copies the old data
  folder into place at launch (`legacy_data.rs`). When it cannot, the library
  is empty while the old scripts are still on disk, and the next step anybody
  would take to see whether the upgrade worked, opening the sample, is what
  ends the automatic retry: the next launch finds a script here and keeps this
  library. So this says, before that happens, where the old library is, what
  the next launch will do, and how to bring old scripts in once work has begun
  here.

  Two placements of one card. `inline` is Welcome's, directly above the
  buttons that create a script, because that is the moment it matters.
  `floating` is everywhere else (the Library, the editor, the recovery screen),
  docked at the top trailing corner below the toolbar: the update card owns the
  bottom leading corner and the toasts the bottom trailing one.

  It changes neither folder. The only action besides Dismiss shows the old
  folder, and Rust chooses the path for that (`reveal_legacy_library`).
-->
<script lang="ts">
  import Button from './Button.svelte';
  import { describeError } from '../services/errors';
  import type { LegacyLibraryNotice } from '../services/legacy-library';

  interface Props {
    notice: LegacyLibraryNotice;
    placement: 'inline' | 'floating';
    /**
     * Whether the library can take an import right now. `false` on the
     * recovery screen, where the database did not open and File › Import
     * Markdown… refuses.
     */
    libraryOpen: boolean;
    /** The platform's own words for showing a folder ("Reveal in Finder"). */
    revealLabel: string;
    onreveal: () => Promise<void>;
    ondismiss: () => void;
  }

  let { notice, placement, libraryOpen, revealLabel, onreveal, ondismiss }: Props = $props();

  const titleId = $props.id();
  let revealError = $state<string | null>(null);

  async function reveal(): Promise<void> {
    revealError = null;
    try {
      await onreveal();
    } catch (err) {
      revealError = `The folder could not be shown. ${describeError(err)}`;
    }
  }
</script>

<section
  class="legacy-notice"
  class:floating={placement === 'floating'}
  aria-labelledby={titleId}
  data-testid="legacy-library-notice"
  data-kind={notice.kind}
>
  {#if notice.kind === 'failed'}
    <h2 class="title" id={titleId}>Your CandidCue library was not copied</h2>
    <p class="body">Your scripts from CandidCue are still in their old folder:</p>
  {:else}
    <h2 class="title" id={titleId}>Speaking Glass is keeping this library</h2>
    <p class="body">
      An earlier copy of your CandidCue library failed, and work was started here since, so Speaking
      Glass kept this library and will not copy the old one again. Your scripts from CandidCue are
      still in their old folder:
    </p>
  {/if}
  <p class="path" data-testid="legacy-library-path">{notice.oldFolder}</p>
  {#if notice.kind === 'failed'}
    {#if notice.reason}
      <p class="body reason" data-testid="legacy-library-reason">{notice.reason}</p>
    {/if}
    <p class="body" data-testid="legacy-library-next-launch">
      Speaking Glass tries again each time it opens, but only while this library has no scripts.
      Creating or importing one here, the sample script included, keeps this library instead, and
      the copy is not tried again.
    </p>
  {/if}
  <p class="body" data-testid="legacy-library-recover">
    {libraryOpen ? 'To bring' : 'Once Speaking Glass can open its library, bring'} an old script into
    this library with File › Import Markdown…: in the old folder, open <span class="name">scripts</span>,
    then a script's folder, and choose <span class="name">script.md</span>. To replace this library
    with the whole old one instead, export all data from CandidCue and use Settings › Data, privacy &amp;
    updates › Restore from export…, which replaces everything here.
  </p>
  {#if revealError !== null}
    <p class="body" role="alert">{revealError}</p>
  {/if}
  <div class="actions">
    <Button size="sm" variant="ghost" onclick={ondismiss}>Dismiss</Button>
    <Button size="sm" variant="default" onclick={() => void reveal()}>{revealLabel}</Button>
  </div>
</section>

<style>
  /*
   * Inline, it is part of Welcome's content, and content is never glass: a
   * sunken panel in the column, rimmed all round. Floating, it is the same
   * glass as the update card it mirrors across the window.
   */
  .legacy-notice {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-primary);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
  }

  .legacy-notice.floating {
    position: fixed;
    top: calc(var(--toolbar-h) + var(--space-3));
    right: var(--page-x);
    z-index: 120;
    width: min(360px, calc(100vw - 2 * var(--page-x)));
    max-height: calc(100vh - var(--toolbar-h) - var(--statusbar-h) - 2 * var(--space-3));
    overflow-y: auto;
    background: var(--glass-fill);
    -webkit-backdrop-filter: var(--glass-backdrop);
    backdrop-filter: var(--glass-backdrop);
    border-color: var(--glass-border);
    border-radius: var(--radius-float);
    box-shadow:
      inset 0 0 0 1px var(--glass-inner-edge),
      var(--glass-shadow);
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

  /* Selectable and wrapped anywhere: a folder path has no spaces to break at. */
  .path {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-primary);
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }

  .name {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }
</style>
