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

  Part of the page, never floating: on Welcome directly above the buttons that
  create a script, because that is the moment it matters; at the head of the
  Library's list; and on the recovery screen beside its repairs. A floating
  card was tried and covered working controls (a row's Present, the editor's
  formatting row) and sat over the recovery screen's confirmations. A launch
  that opens somewhere else gets a toast pointing at the Library (App.svelte).

  It changes neither folder. The only action besides Dismiss shows the old
  folder, and Rust chooses the path for that (`reveal_legacy_library`).
-->
<script lang="ts">
  import Button from './Button.svelte';
  import { describeError } from '../services/errors';
  import type { LegacyLibraryNotice } from '../services/legacy-library';

  interface Props {
    notice: LegacyLibraryNotice;
    /**
     * Whether the library can take an import right now. `false` on the
     * recovery screen, where the database did not open and both File ›
     * Import Markdown… and Restore from export… refuse.
     */
    libraryOpen: boolean;
    /** The platform's own words for showing a folder ("Reveal in Finder"). */
    revealLabel: string;
    onreveal: () => Promise<void>;
    ondismiss: () => void;
  }

  let { notice, libraryOpen, revealLabel, onreveal, ondismiss }: Props = $props();

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
  aria-labelledby={titleId}
  data-testid="legacy-library-notice"
  data-kind={notice.kind}
>
  {#if notice.kind === 'failed'}
    <h2 class="title" id={titleId}>Your CandidCue library was not copied</h2>
    <p class="body">Your scripts from CandidCue are still in their old folder:</p>
  {:else}
    <h2 class="title" id={titleId}>Speaking Glass is keeping this library</h2>
    <p class="body" data-testid="legacy-library-kept">
      An earlier copy of your CandidCue library did not finish, and this library is no longer empty,
      so Speaking Glass kept it as it is and will not copy the old one over it. Your scripts from
      CandidCue are still in their old folder:
    </p>
  {/if}
  <p class="path" data-testid="legacy-library-path">{notice.oldFolder}</p>
  {#if notice.kind === 'failed'}
    {#if notice.reason}
      <p class="body reason" data-testid="legacy-library-reason">{notice.reason}</p>
    {/if}
    <p class="body" data-testid="legacy-library-next-launch">
      Speaking Glass tries again each time it opens, but only while this library is still empty.
      Creating or importing a script here, the sample script included, makes it keep this library
      instead, and the copy is not tried again.
    </p>
  {/if}
  <p class="body" data-testid="legacy-library-recover">
    {libraryOpen ? 'To bring' : 'Once Speaking Glass can open its library, bring'} an old script's
    text into this library with File › Import Markdown…: in the old folder, open
    <span class="name">scripts</span>, then a script's folder, and choose
    <span class="name">script.md</span>. Or, to replace this library with the whole old one, export
    all data from CandidCue and use Settings › Data, privacy &amp; updates › Restore from export…,
    which replaces everything here.
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
   * Content, and content is never glass: a sunken panel in the column, rimmed
   * all round.
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
