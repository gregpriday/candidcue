<!--
  Script library (spec §12): search, sort, import, clean list rows with
  metadata, trash behaviors with F.19 confirmations, F.7/§12.3 empty states.
-->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Icon from '../components/Icon.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import ScriptCard from '../components/ScriptCard.svelte';
  import Select from '../components/Select.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { formatSpeakingDuration, relativeTime } from '../lib/format';
  import { createAndOpenScript, exportScriptToFile, importMarkdown } from '../lib/app-actions';
  import { onShortcut } from '../lib/shortcuts';
  import { startTake } from '../lib/start-take';
  import * as scriptsService from '../services/scripts';
  import { requestConfirm } from '../stores/confirm';
  import {
    collectTrashTargets,
    deleteScriptPermanently,
    duplicateScript,
    emptyTrash,
    library,
    loadLibrary,
    moveScriptToTrash,
    restoreScriptFromTrash,
    selectScript,
    setLibraryQuery,
    setLibrarySort,
  } from '../stores/library';
  import { navigate } from '../stores/router';
  import { showToast } from '../stores/toasts';
  import type { ScriptSummary } from '../../shared/contracts';
  import type { ScriptSort } from '../services/scripts-types';

  let searchInput: HTMLInputElement | null = $state(null);
  let listElement: HTMLUListElement | null = $state(null);
  /**
   * Seeded from the store, not from empty.
   *
   * The store is a singleton and its query outlives this route, so opening a
   * script from a set of search results and coming back used to restore the
   * filtered list under a blank search box — with the ⌘K hint sitting in it, as
   * though nothing had been typed. The results and the field now agree.
   */
  let query = $state($library.query);
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  const sortOptions = [
    { value: 'recently_edited', label: 'Recently edited' },
    { value: 'name', label: 'Name' },
    { value: 'created', label: 'Created' },
    { value: 'estimated_length', label: 'Estimated length' },
  ];

  const inTrash = $derived($library.view === 'trash');
  /**
   * Recent is ordered by when a script was last opened — that IS the view — so
   * the sort control has nothing to say there, the same way it has nothing to
   * say in Trash.
   */
  const showsSort = $derived($library.view === 'all');
  const pageTitle = $derived(
    $library.view === 'trash' ? 'Trash' : $library.view === 'recent' ? 'Recent' : 'Scripts',
  );

  /**
   * Empty Trash is offered unless the Trash is known to be empty.
   *
   * `trashTotal` counts the whole Trash rather than the rows a search has left
   * on screen, so it is the only number that answers this. It is `null` when
   * that count could not be read — and a filtered list of nothing says nothing
   * at all about how much is behind it, so the action stays available.
   *
   * This predicate can afford to be generous: it decides whether to OFFER the
   * action, not what the action removes. `confirmEmptyTrash` re-reads the Trash
   * before asking, so a button shown over an empty Trash costs a notice, not a
   * deletion.
   */
  const canEmptyTrash = $derived(
    $library.trashTotal === null
      ? $library.scripts.length > 0 || $library.query.trim() !== ''
      : $library.trashTotal > 0,
  );

  $effect(() => {
    void loadLibrary();
    const unsubscribe = onShortcut((action) => {
      if (action === 'quick-search') searchInput?.focus();
      if (action === 'new-script') void createAndOpenScript('new');
      if (action === 'present') {
        // The target is invisible by design (see `ScriptCard`), so a shortcut
        // that resolves to nothing has to say so — otherwise ⌘⏎ is a key that
        // sometimes works and never explains itself.
        if (inTrash) {
          showToast('Scripts in Trash cannot be presented. Restore one first.', 'info');
          return;
        }
        const id = $library.selectedId;
        if (id === null) {
          showToast('There is no script to present yet.', 'info');
          return;
        }
        void startTake(id);
      }
    });
    return () => {
      unsubscribe();
      // A search typed on the way out would otherwise land 180ms later, on a
      // screen that has gone: it sets the singleton's query and starts a load
      // for a route nobody is looking at.
      if (searchDebounce) clearTimeout(searchDebounce);
    };
  });

  function onSearchInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => setLibraryQuery(query), 180);
  }

  /**
   * ⌘K reaches the search field and used to end there — there was no key that
   * carried you from the box into what it had found.
   *
   * In Trash the card body does nothing (its callbacks are withheld below), so
   * the first thing worth landing on there is the row's own Restore button.
   */
  function onSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown') return;
    const first = listElement?.querySelector<HTMLButtonElement>(
      inTrash ? 'li .actions button' : 'button.main',
    );
    if (!first) return;
    event.preventDefault();
    first.focus();
  }

  function openScript(script: ScriptSummary): void {
    void navigate({ name: 'editor', scriptId: script.id });
  }

  /** Straight to the stage — the settings a take needs are already saved. */
  function presentScript(script: ScriptSummary): void {
    void startTake(script.id);
  }

  async function confirmTrash(script: ScriptSummary): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Delete script?',
      body: `${script.title} will move to Trash and can be restored for 30 days.`,
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    // The outcome — moved, or why not — comes from the store, which is the one
    // place that knows whether it happened. This used to toast "Moved to Trash"
    // after the await, so a failure closed the sheet and said nothing.
    if (accepted) await moveScriptToTrash(script.id);
  }

  async function confirmDeleteForever(script: ScriptSummary): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Delete permanently?',
      // Naming it: this is the one action on this screen with no undo, and the
      // sheet used to describe "the script" without saying which.
      body: `“${script.title}” will be deleted permanently, along with its retained revisions and unshared local assets. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (accepted) await deleteScriptPermanently(script.id);
  }

  async function confirmEmptyTrash(): Promise<void> {
    // Read what is in the Trash BEFORE asking about it, and delete exactly that
    // set. Counting first and enumerating after acceptance meant the sheet
    // named one number and the deletes ran against another — anything trashed
    // while the sheet was open went with them, unmentioned.
    const targets = await collectTrashTargets();
    if (targets === null) return; // already reported
    if (targets.length === 0) {
      showToast('Trash is already empty.', 'info');
      await loadLibrary();
      return;
    }
    const count = targets.length;
    const body =
      count === 1
        ? '1 script in Trash will be deleted permanently, along with its retained revisions and unshared local assets. This cannot be undone.'
        : `${count} scripts in Trash will be deleted permanently, along with their retained revisions and unshared local assets. This cannot be undone.`;
    const accepted = await requestConfirm({
      title: 'Empty Trash?',
      body,
      confirmLabel: 'Empty Trash',
      danger: true,
    });
    if (accepted) await emptyTrash(targets);
  }

  /**
   * `exportScriptToFile` owns the outcome of an export: it returns quietly on a
   * cancelled dialog and reports warnings, success and failure itself. There
   * used to be an unconditional "Export ready" here as well, which meant a
   * cancelled dialog and a failed write both ended in a success notice.
   */
  async function exportScript(script: ScriptSummary): Promise<void> {
    // No success toast here: `exportScriptToFile` owns every outcome, including
    // its own 'Script exported'. A second one here fired unconditionally — so a
    // cancelled or failed export still claimed the export was ready.
    await exportScriptToFile(script.id, script.title, 'markdown');
  }

  /** Metadata as discrete parts — the card sets the separators, not this. */
  function rowMeta(script: ScriptSummary): string[] {
    return [
      relativeTime(script.updatedAt),
      `${script.spokenWordCount.toLocaleString()} words`,
      formatSpeakingDuration(script.estimatedDurationSeconds),
    ].filter(Boolean);
  }

  function rowMenu(script: ScriptSummary) {
    if (inTrash) {
      return [
        { label: 'Restore', onselect: () => void restoreScriptFromTrash(script.id) },
        {
          label: 'Delete permanently',
          danger: true,
          separated: true,
          onselect: () => void confirmDeleteForever(script),
        },
      ];
    }
    return [
      { label: 'Open', onselect: () => openScript(script) },
      { label: 'Present', onselect: () => presentScript(script) },
      { label: 'Duplicate', onselect: () => void duplicateScript(script.id) },
      { label: 'Export Markdown', onselect: () => void exportScript(script) },
      // Ruled off: the only irreversible-looking action in the list should not
      // sit one slot below "Export Markdown" with nothing between them.
      { label: 'Move to Trash', danger: true, separated: true, onselect: () => void confirmTrash(script) },
    ];
  }
</script>

<div class="page">
  <PageHeader title={pageTitle}>
    {#snippet actions()}
      {#if inTrash}
        <!--
          Driven by the whole Trash, not the loaded page: searching Trash for
          something that does not match used to take the button away while
          there was still a Trash to empty.
        -->
        {#if canEmptyTrash}
          <Button variant="danger" onclick={() => confirmEmptyTrash()}>Empty Trash</Button>
        {/if}
      {:else}
        <Button onclick={() => importMarkdown()}>
          <Icon name="import" size={16} />
          Import
        </Button>
        <Button variant="primary" onclick={() => createAndOpenScript('new')}>
          <Icon name="plus" size={16} />
          New script
        </Button>
      {/if}
    {/snippet}
  </PageHeader>

  <div class="toolbar">
    <div class="search">
      <span class="search-icon"><Icon name="search" size={15} /></span>
      <input
        class="search-input"
        type="search"
        placeholder="Search scripts"
        aria-label="Search scripts"
        value={query}
        bind:this={searchInput}
        oninput={onSearchInput}
        onkeydown={onSearchKeydown}
      />
      <!--
        The shortcut is chrome, not placeholder text. It used to be three hard
        spaces and "⌘K" inside the placeholder, which meant it shared the
        placeholder's colour and baseline, vanished the moment anybody typed, and
        drifted left as the field resized. `aria-hidden` because the input's own
        label already names the field and the binding is announced elsewhere.
      -->
      {#if query === ''}
        <kbd class="hint" aria-hidden="true">⌘K</kbd>
      {/if}
    </div>
    {#if showsSort}
      <div class="sort">
        <Select
          value={$library.sort}
          options={sortOptions}
          onchange={(value) => setLibrarySort(value as ScriptSort)}
        />
      </div>
    {/if}
  </div>

  <div class="list-area">
    <!--
      A refresh that failed with rows already on screen: the list is stale, not
      wrong, so it stays and the failure is reported over it. Deliberately not a
      toast — `danger` toasts never expire, and a debounced search that keeps
      failing would stack one per keystroke for a single ongoing condition.
    -->
    {#if $library.error !== null && $library.scripts.length > 0}
      <div class="stale" role="alert">
        <div class="stale-text">
          <p class="stale-title">Scripts could not be refreshed</p>
          <p class="stale-body">The results below are the previous ones. {$library.error}</p>
        </div>
        <Button onclick={() => loadLibrary()}>Try again</Button>
      </div>
    {/if}

    {#if $library.loading && $library.scripts.length === 0}
      <p class="loading">Loading scripts…</p>
    {:else if $library.error !== null && $library.scripts.length === 0}
      <!--
        A read that failed is not an empty library. This branch has to come
        before the empty states: without it a database error fell through to the
        first-run invitation — "Write the words", Create, Import — which reads as
        every script you had being gone, and offers to start you over.
      -->
      <EmptyState title="Scripts could not be loaded" body={$library.error}>
        {#snippet actions()}
          <Button variant="primary" onclick={() => loadLibrary()}>Try again</Button>
        {/snippet}
      </EmptyState>
    {:else if $library.scripts.length === 0}
      <!--
        The search miss is checked first. Trash used to win, so searching Trash
        for something it does not hold answered "Trash is empty" — a much larger
        claim, about the one place a script goes to be recoverable.
      -->
      {#if $library.query.trim() !== ''}
        <EmptyState title="No matching scripts" body="No titles or script text matched your search." />
      {:else if inTrash}
        <EmptyState title="Trash is empty" body="Deleted scripts stay here for 30 days before they are removed." />
      {:else if $library.view === 'recent'}
        <!--
          Recent lists what has been opened, which is a different question from
          whether anything has been written. Without this the view answered an
          empty `last_opened_at` with "Write the words" and an offer to create
          your first script, over a library that might hold fifty.
        -->
        <EmptyState
          title="No recent scripts"
          body="Scripts appear here once you have opened them, most recently opened first."
        />
      {:else}
        <EmptyState
          title="Write the words. CandidCue keeps your place."
          body="Create a script, or import Markdown you have already written."
        >
          {#snippet actions()}
            <Button variant="primary" onclick={() => createAndOpenScript('new')}>Create a script</Button>
            <Button onclick={() => importMarkdown()}>Import Markdown</Button>
            <Button variant="ghost" onclick={() => createAndOpenScript('sample')}>
              Try a sample script
            </Button>
          {/snippet}
        </EmptyState>
      {/if}
    {:else}
      <ul class="list" aria-label={pageTitle} bind:this={listElement}>
        {#each $library.scripts as script (script.id)}
          <li>
            <!--
              Selection is recorded, not drawn: `selectedId` is the Present
              shortcut's target and nothing else on this screen acts on it, so
              the card has no selected treatment. See the note in ScriptCard.

              Both callbacks are WITHHELD in Trash rather than passed as
              functions that do nothing. `ScriptCard` reads
              `Boolean(onopen ?? onselect)` to decide whether the body is
              interactive, so an `onopen` that internally returned `undefined`
              still bought the row a hover lift and a focus edge — a card body
              that invited a click and then ignored it. Withholding `onselect`
              too keeps a trashed script from becoming the Present target.
            -->
            <ScriptCard
              title={script.title}
              excerpt={script.previewText || undefined}
              meta={rowMeta(script)}
              onselect={inTrash ? undefined : () => selectScript(script.id)}
              onopen={inTrash ? undefined : () => openScript(script)}
            >
              {#snippet status()}
                {#if script.hasWarnings}
                  <StatusPill tone="warning" label="Needs attention" />
                {:else if script.status === 'ready'}
                  <StatusPill tone="success" label="Prepared" />
                {/if}
              {/snippet}
              {#snippet actions()}
                {#if !inTrash}
                  <Button onclick={() => presentScript(script)}>Present</Button>
                {:else}
                  <Button onclick={() => restoreScriptFromTrash(script.id)}>Restore</Button>
                {/if}
                <OverflowMenu items={rowMenu(script)} label="Script actions" />
              {/snippet}
            </ScriptCard>
          </li>
        {/each}
      </ul>
      <!--
        One page is all Rust will serve at a time, so past its ceiling the list
        is a subset. It used to be a silent one. This states the count rather
        than announcing a limit: the number that matters is how many there are,
        not where the transport stops.
      -->
      {#if $library.scripts.length < $library.total}
        <p class="count">
          Showing {$library.scripts.length.toLocaleString()} of {$library.total.toLocaleString()} scripts.
        </p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .page {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--page-x) 0;
  }

  .search {
    position: relative;
    flex: 1 1 auto;
    max-width: 420px;
  }
  .search-icon {
    position: absolute;
    left: var(--space-3);
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
    display: inline-flex;
  }
  .hint {
    position: absolute;
    right: var(--space-2);
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 6px;
    border: 1px solid var(--border-faint);
    border-radius: 5px;
    background: var(--bg-sunken);
    color: var(--text-faint);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    font-weight: 600;
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    height: var(--control-h);
    /* Right padding clears the ⌘K capsule so a long query never runs under it. */
    padding: 0 calc(var(--space-2) + 34px) 0 calc(var(--space-3) + 22px);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .search-input::placeholder {
    color: var(--text-faint);
  }
  .search-input:hover {
    border-color: var(--border-strong);
  }
  /* Quiet focus on the search surface — no accent ring. */
  .search-input:focus,
  .search-input:focus-visible {
    outline: none;
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  .sort {
    flex: 0 0 auto;
    min-width: 170px;
  }

  .list-area {
    flex: 1 1 auto;
    padding: var(--space-4) var(--page-x) var(--space-8);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .loading {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  /*
   * The failed-refresh notice. A full border rather than a leading rule: a
   * one-sided border on a rounded box crescents at the corners.
   */
  .stale {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--danger);
    border-radius: var(--radius-md);
    background: var(--danger-soft);
  }
  .stale-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .stale-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .stale-body {
    margin: 2px 0 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }

  .count {
    margin: var(--space-4) 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
