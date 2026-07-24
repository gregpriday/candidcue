<!--
  Revision browser (spec §21.4).

  CandidCue has been writing revision snapshots since the scripts repo landed —
  on the first save, on the 5-minute cadence, before a session, when the file
  changes outside the app — and until now nothing could read one back. This is
  the reader: list, preview, restore.

  Restoring is undoable, and the guarantee is Rust's: `restore_revision` routes
  through `save_script` with `revisionReason: "before_restore"`, so the text it
  replaces is snapshotted under the per-script lock first.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import {
    RESTORE_SAFETY_NOTE,
    formatWordDelta,
    revisionReasonLabel,
    revisionTimestamp,
    revisionWordDelta,
  } from '../lib/revision-format';
  import { relativeTime } from '../lib/format';
  import { describeError } from '../services/errors';
  import { BackendUnavailableError } from '../services/ipc';
  import * as revisionsService from '../services/revisions';
  import type { RevisionDocument, RevisionSummary } from '../services/revisions';

  interface Props {
    open: boolean;
    scriptId: string;
    /** Script revision the editor believes it holds (compare-and-swap input). */
    expectedRevision: number;
    /** Spoken word count of the text currently open, for the delta column. */
    currentWordCount: number;
    onclose: () => void;
    /** Fired after a successful restore so the editor can reload the script. */
    onrestored: () => void;
  }

  let { open, scriptId, expectedRevision, currentWordCount, onclose, onrestored }: Props =
    $props();

  let loading = $state(false);
  let listError = $state<string | null>(null);
  let revisions = $state<RevisionSummary[]>([]);
  let selectedId = $state<string | null>(null);
  let preview = $state<RevisionDocument | null>(null);
  let previewError = $state<string | null>(null);
  let restoring = $state(false);
  let confirming = $state(false);

  const selected = $derived(revisions.find((r) => r.id === selectedId) ?? null);

  $effect(() => {
    if (!open) return;
    void load(scriptId);
  });

  async function load(id: string): Promise<void> {
    loading = true;
    listError = null;
    preview = null;
    previewError = null;
    selectedId = null;
    try {
      revisions = await revisionsService.listRevisions(id);
      if (revisions.length > 0) void select(revisions[0]!.id);
    } catch (err) {
      revisions = [];
      listError =
        err instanceof BackendUnavailableError
          ? 'Revision history needs the CandidCue desktop app.'
          : describeError(err);
    } finally {
      loading = false;
    }
  }

  async function select(revisionId: string): Promise<void> {
    selectedId = revisionId;
    preview = null;
    previewError = null;
    try {
      const doc = await revisionsService.getRevision(scriptId, revisionId);
      // A slower earlier request must not overwrite a newer selection.
      if (selectedId === revisionId) preview = doc;
    } catch (err) {
      if (selectedId === revisionId) previewError = describeError(err);
    }
  }

  async function restore(): Promise<void> {
    if (!selected) return;
    restoring = true;
    try {
      await revisionsService.restoreRevision(scriptId, selected.id, expectedRevision);
      confirming = false;
      onrestored();
    } catch (err) {
      previewError = describeError(err);
      confirming = false;
    } finally {
      restoring = false;
    }
  }

  function deltaFor(revision: RevisionSummary): string {
    return formatWordDelta(revisionWordDelta(revision.wordCount, currentWordCount));
  }
</script>

<Dialog {open} size="lg" title="Revision history" onclose={onclose}>
  {#if loading}
    <p class="note">Loading revisions…</p>
  {:else if listError}
    <p class="note danger">{listError}</p>
  {:else if revisions.length === 0}
    <p class="note">
      No revisions yet. CandidCue saves one the first time you save a script, then roughly every
      five minutes while you edit, and before every session.
    </p>
  {:else}
    <div class="layout">
      <ul class="list" aria-label="Revisions">
        {#each revisions as revision (revision.id)}
          <li>
            <button
              type="button"
              class="row"
              class:active={revision.id === selectedId}
              aria-current={revision.id === selectedId ? 'true' : undefined}
              onclick={() => void select(revision.id)}
            >
              <span class="row-top">
                <span class="row-reason">{revisionReasonLabel(revision.reason)}</span>
                <span class="row-time">{revisionTimestamp(revision.createdAt)}</span>
              </span>
              <span class="row-meta">
                {relativeTime(revision.createdAt)}
                {#if deltaFor(revision)}
                  · {deltaFor(revision)}
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>

      <section class="preview" aria-label="Revision preview">
        {#if previewError}
          <p class="note danger">{previewError}</p>
        {:else if !selected}
          <p class="note">Choose a revision to preview it.</p>
        {:else if !preview}
          <p class="note">Loading…</p>
        {:else}
          <p class="preview-head">
            {revisionReasonLabel(preview.reason)} · {revisionTimestamp(preview.createdAt)}
            {#if preview.wordCount !== undefined}
              · {preview.wordCount.toLocaleString()} words
            {/if}
          </p>
          <pre class="preview-body">{preview.source}</pre>
        {/if}
      </section>
    </div>

    {#if confirming}
      <p class="note confirm">
        Replace the current text with this revision? {RESTORE_SAFETY_NOTE}
      </p>
    {/if}
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Close</Button>
    {#if confirming}
      <Button variant="ghost" onclick={() => (confirming = false)}>Cancel</Button>
      <Button variant="primary" disabled={restoring} onclick={() => void restore()}>
        {restoring ? 'Restoring…' : 'Restore this version'}
      </Button>
    {:else}
      <Button
        variant="primary"
        disabled={!preview || restoring}
        onclick={() => (confirming = true)}
      >
        Restore this version
      </Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .layout {
    display: flex;
    gap: var(--space-4);
    min-height: 0;
    height: min(52vh, 420px);
  }

  .list {
    flex: 0 0 268px;
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    color: var(--text-secondary);
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--motion-base) var(--ease-out);
  }
  .row:hover {
    background: var(--bg-hover-chrome);
  }
  .row.active {
    background: var(--bg-panel);
    border-color: var(--border);
    box-shadow: var(--shadow-card);
    color: var(--text-primary);
  }
  /* Leading marker as an inset bar — never a one-sided border on a rounded
     box (design rule). */
  .row.active::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  .row-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .row-reason {
    font-size: var(--text-sm);
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-time {
    flex: 0 0 auto;
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .row-meta {
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }

  .preview {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
  }
  .preview-head {
    margin: 0;
    font-size: var(--text-meta);
    color: var(--text-muted);
  }
  .preview-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--bg-canvas);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
  }
  .note.danger {
    color: var(--danger);
  }
  .note.confirm {
    color: var(--text-primary);
  }
</style>
