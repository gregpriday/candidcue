<!--
  Script library (spec §12): search, sort, import, clean list rows with
  metadata, trash behaviors with F.19 confirmations, F.7/§12.3 empty states.
-->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Icon from '../components/Icon.svelte';
  import ListRow from '../components/ListRow.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Select from '../components/Select.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { formatSpeakingDuration, relativeTime } from '../lib/format';
  import { createAndOpenScript, importMarkdown } from '../lib/app-actions';
  import { onShortcut } from '../lib/shortcuts';
  import * as scriptsService from '../services/scripts';
  import { requestConfirm } from '../stores/confirm';
  import {
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
  let query = $state('');
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  const sortOptions = [
    { value: 'recently_edited', label: 'Recently edited' },
    { value: 'name', label: 'Name' },
    { value: 'created', label: 'Created' },
    { value: 'estimated_length', label: 'Estimated length' },
  ];

  const inTrash = $derived($library.view === 'trash');
  const pageTitle = $derived(
    $library.view === 'trash' ? 'Trash' : $library.view === 'recent' ? 'Recent' : 'Scripts',
  );

  $effect(() => {
    void loadLibrary();
    return onShortcut((action) => {
      if (action === 'quick-search') searchInput?.focus();
      if (action === 'new-script') void createAndOpenScript('new');
      if (action === 'present') {
        const id = $library.selectedId;
        if (id) void navigate({ name: 'preflight', scriptId: id });
      }
    });
  });

  function onSearchInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => setLibraryQuery(query), 180);
  }

  function openScript(script: ScriptSummary): void {
    void navigate({ name: 'editor', scriptId: script.id });
  }

  function presentScript(script: ScriptSummary): void {
    void navigate({ name: 'preflight', scriptId: script.id });
  }

  async function confirmTrash(script: ScriptSummary): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Delete script?',
      body: `${script.title} will move to Trash and can be restored for 30 days.`,
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (accepted) {
      await moveScriptToTrash(script.id);
      showToast('Moved to Trash', 'info');
    }
  }

  async function confirmDeleteForever(script: ScriptSummary): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Delete permanently?',
      body: 'This removes the script, its retained revisions, and unshared local assets. This cannot be undone.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (accepted) await deleteScriptPermanently(script.id);
  }

  async function confirmEmptyTrash(): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Delete permanently?',
      body: 'This removes these scripts, their retained revisions, and unshared local assets. This cannot be undone.',
      confirmLabel: 'Empty Trash',
      danger: true,
    });
    if (accepted) await emptyTrash();
  }

  async function exportScript(script: ScriptSummary): Promise<void> {
    await scriptsService.exportScript(script.id, { format: 'markdown' });
    showToast('Export ready', 'success');
  }

  function rowMeta(script: ScriptSummary): string {
    const parts = [
      relativeTime(script.updatedAt),
      `${script.spokenWordCount.toLocaleString()} words`,
      formatSpeakingDuration(script.estimatedDurationSeconds),
    ];
    return parts.filter(Boolean).join(' · ');
  }

  function rowMenu(script: ScriptSummary) {
    if (inTrash) {
      return [
        { label: 'Restore', onselect: () => void restoreScriptFromTrash(script.id) },
        { label: 'Delete permanently', danger: true, onselect: () => void confirmDeleteForever(script) },
      ];
    }
    return [
      { label: 'Open', onselect: () => openScript(script) },
      { label: 'Present', onselect: () => presentScript(script) },
      { label: 'Duplicate', onselect: () => void duplicateScript(script.id) },
      { label: 'Export Markdown', onselect: () => void exportScript(script) },
      { label: 'Move to Trash', danger: true, onselect: () => void confirmTrash(script) },
    ];
  }
</script>

<div class="page">
  <PageHeader title={pageTitle}>
    {#snippet actions()}
      {#if inTrash}
        {#if $library.scripts.length > 0}
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
        placeholder="Search scripts   ⌘K"
        aria-label="Search scripts"
        value={query}
        bind:this={searchInput}
        oninput={onSearchInput}
      />
    </div>
    {#if !inTrash}
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
    {#if $library.loading && $library.scripts.length === 0}
      <p class="loading">Loading scripts…</p>
    {:else if $library.scripts.length === 0}
      {#if inTrash}
        <EmptyState title="Trash is empty" body="Deleted scripts stay here for 30 days before they are removed." />
      {:else if query.trim() !== ''}
        <EmptyState title="No matching scripts" body="No titles or script text matched your search." />
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
      <ul class="list" aria-label={pageTitle}>
        {#each $library.scripts as script (script.id)}
          <li>
            <ListRow
              title={script.title}
              excerpt={script.previewText || undefined}
              meta={rowMeta(script)}
              selected={$library.selectedId === script.id}
              onselect={() => selectScript(script.id)}
              onopen={() => (inTrash ? undefined : openScript(script))}
            >
              {#snippet leading()}
                <Icon name="doc" size={18} />
              {/snippet}
              {#snippet trailing()}
                {#if script.hasWarnings}
                  <StatusPill tone="warning" label="Needs attention" />
                {:else if script.status === 'ready'}
                  <StatusPill tone="success" label="Prepared" />
                {/if}
                {#if !inTrash}
                  <Button size="sm" onclick={() => presentScript(script)}>Present</Button>
                {:else}
                  <Button size="sm" onclick={() => restoreScriptFromTrash(script.id)}>Restore</Button>
                {/if}
                <OverflowMenu items={rowMenu(script)} label="Script actions" />
              {/snippet}
            </ListRow>
          </li>
        {/each}
      </ul>
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
  .search-input {
    width: 100%;
    height: var(--control-h);
    padding: 0 var(--space-3) 0 calc(var(--space-3) + 22px);
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
</style>
