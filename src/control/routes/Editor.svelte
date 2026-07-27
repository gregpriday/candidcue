<!--
  Editor screen (spec §13): header with editable title, truthful save state
  (F.8), Edit/Split/Preview modes, minimal insert toolbar (§13.6), CodeMirror
  Markdown editor full-bleed on its panel, outline panel
  (§13.3/§13.4), readiness messages (F.9).
-->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import IconButton from '../components/IconButton.svelte';
  import MarkdownEditor from '../components/MarkdownEditor.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import RenderBlocks from '../components/RenderBlocks.svelte';
  import RevisionHistory from '../components/RevisionHistory.svelte';
  import SegmentedControl from '../components/SegmentedControl.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { exportScriptToFile } from '../lib/app-actions';
  import { startTake, takeStarting } from '../lib/start-take';
  import { estimateDurationSeconds, formatSpeakingDuration } from '../lib/format';
  import * as inserts from '../lib/markdown-insert';
  import { onShortcut } from '../lib/shortcuts';
  import * as assetsService from '../services/assets';
  import { describeError } from '../services/errors';
  import * as scriptsService from '../services/scripts';
  import { settings } from '../stores/settings';
  import { compiled } from '../stores/compiled';
  import { requestConfirm } from '../stores/confirm';
  import {
    editor,
    openScript,
    saveNow,
    setEditorMode,
    setSource,
    setTitle,
  } from '../stores/editor';
  import { loadLibrary, moveScriptToTrash } from '../stores/library';
  import { navigate } from '../stores/router';
  import { showToast } from '../stores/toasts';
  import type { CompiledBlock, OutlineNode } from '../../shared/contracts';

  interface Props {
    scriptId: string;
  }
  let { scriptId }: Props = $props();

  let editorRef: MarkdownEditor | null = $state(null);
  let panelOpen = $state(true);
  let saveIssueOpen = $state(false);
  let conflictOpen = $state(false);
  let revisionsOpen = $state(false);
  let splitRatio = $state(readSplitRatio());
  let previewScroller: HTMLElement | null = $state(null);

  const SPLIT_KEY = 'candidcue.editor.split.v1';

  function readSplitRatio(): number {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SPLIT_KEY) : null;
      const parsed = raw ? Number(raw) : NaN;
      return Number.isFinite(parsed) ? Math.min(0.75, Math.max(0.25, parsed)) : 0.5;
    } catch {
      return 0.5;
    }
  }

  $effect(() => {
    void openScript(scriptId).catch((err) => {
      showToast(`Could not open script: ${String(err)}`, 'danger');
      void navigate({ name: 'library', view: 'all' });
    });
  });

  $effect(() =>
    onShortcut((action) => {
      if (action === 'save') void manualSave();
      if (action === 'present') void present();
    }),
  );

  const result = $derived($compiled.result);
  const blocks = $derived(result?.blocks ?? []);
  const outline = $derived(result?.outline ?? []);
  const diagnostics = $derived(result?.diagnostics ?? []);
  const blockingCount = $derived(diagnostics.filter((d) => d.blocking).length);
  const cueCount = $derived(blocks.filter((b) => b.kind === 'cue').length);
  const takeMarkers = $derived(
    (result?.navigationTargets ?? []).filter((t) => t.type === 'take'),
  );
  const wordCount = $derived(result?.spokenWordCount ?? 0);
  const durationSeconds = $derived(estimateDurationSeconds(wordCount));

  const meta = $derived(
    wordCount > 0
      ? `${wordCount.toLocaleString()} words · ${formatSpeakingDuration(durationSeconds)} · ${cueCount} ${cueCount === 1 ? 'cue' : 'cues'}`
      : '',
  );

  const saveLabel = $derived(
    (
      {
        idle: '',
        saving: 'Saving…',
        saved: 'Saved',
        error: 'Save failed',
        conflict: 'Changed outside CandidCue',
      } as const
    )[$editor.saveState],
  );

  async function manualSave(): Promise<void> {
    await saveNow();
  }

  async function goBack(): Promise<void> {
    await saveNow();
    await loadLibrary();
    await navigate({ name: 'library', view: 'all' });
  }

  /**
   * Present opens the stage. There is no screen in between — everything the
   * old Preflight page asked for is in Settings, and the take reports its own
   * microphone, display and connection from the stage (lib/start-take.ts).
   */
  async function present(): Promise<void> {
    await saveNow();
    await startTake(scriptId);
  }

  function withView(fn: (view: NonNullable<ReturnType<MarkdownEditor['getView']>>) => void): void {
    const view = editorRef?.getView();
    if (view) fn(view);
  }

  /**
   * C10: "Insert image" used to type a hardcoded `./assets/image.png` — a file
   * that never existed — while `import_image` had no caller at all, so the
   * Rust picker and the MIME/size validation behind it were unreachable. The
   * image is imported first; the path written into the document is the one the
   * importer created.
   */
  async function insertImage(): Promise<void> {
    const view = editorRef?.getView();
    if (!view) return;
    try {
      const asset = await assetsService.importImage(scriptId);
      if (!asset) return; // operator cancelled the picker
      // Alt text stays a placeholder on purpose: it is spoken when a script
      // enables `readImageAltText`, so a file name would be the wrong default.
      inserts.insertImage(view, asset.markdownPath);
    } catch (err) {
      showToast(`Could not add that image. ${describeError(err)}`, 'danger');
    }
  }

  /** Move the editor cursor to a source offset and reveal it. */
  function goToOffset(offset: number): void {
    withView((view) => {
      const pos = Math.min(offset, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });
  }

  function blockFor(node: OutlineNode): CompiledBlock | undefined {
    return blocks.find((b) => b.id === node.blockId);
  }

  function outlineNavigate(node: OutlineNode): void {
    const block = blockFor(node);
    if (block) {
      goToOffset(block.source.utf16Start);
      const target = previewScroller?.querySelector(`[data-block-id="${block.id}"]`);
      target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  /** Preview click returns to Edit mode at the block's source (§13.2). */
  function previewBlockClick(block: CompiledBlock): void {
    if ($editor.mode === 'preview') setEditorMode('edit');
    goToOffset(block.source.utf16Start);
  }

  function sectionDuration(node: OutlineNode): string {
    const tokens = Math.max(0, node.endTokenIndex - node.startTokenIndex);
    return formatSpeakingDuration(estimateDurationSeconds(tokens));
  }

  function flattenOutline(nodes: OutlineNode[], depth = 0): Array<{ node: OutlineNode; depth: number }> {
    const flat: Array<{ node: OutlineNode; depth: number }> = [];
    for (const node of nodes) {
      flat.push({ node, depth });
      flat.push(...flattenOutline(node.children, depth + 1));
    }
    return flat;
  }

  async function copyAllText(): Promise<void> {
    try {
      await navigator.clipboard.writeText($editor.source);
      showToast('Script text copied', 'success');
    } catch {
      showToast('Could not copy to the clipboard', 'danger');
    }
  }

  async function revealFolder(): Promise<void> {
    await scriptsService.revealScriptFolder(scriptId);
  }

  /* --- F.8 external-conflict resolution ------------------------------- */

  async function keepCandidCueVersion(): Promise<void> {
    conflictOpen = false;
    const disk = await scriptsService.getScript(scriptId);
    await scriptsService.saveScript(scriptId, disk.scriptRevision, $editor.source, {
      title: $editor.title,
    });
    await openScript(scriptId);
    showToast('Kept the CandidCue version. The disk version was saved as a revision.', 'success');
  }

  async function loadDiskVersion(): Promise<void> {
    conflictOpen = false;
    await openScript(scriptId);
    showToast('Loaded the disk version', 'info');
  }

  async function saveBothVersions(): Promise<void> {
    conflictOpen = false;
    await scriptsService.createScript({
      title: `${$editor.title} (conflict copy)`,
      source: $editor.source,
    });
    await openScript(scriptId);
    showToast('Saved your text as a separate script and loaded the disk version.', 'success');
  }

  async function trashFromEditor(): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Delete script?',
      body: `${$editor.title} will move to Trash and can be restored for 30 days.`,
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (!accepted) return;
    await moveScriptToTrash(scriptId);
    await navigate({ name: 'library', view: 'all' });
  }

  /**
   * Open the revision browser (spec §21.4). The pending autosave is flushed
   * first for two reasons: the compare-and-swap needs the revision the editor
   * actually holds, and the text about to be replaced should be on disk (and
   * therefore snapshottable) before a restore replaces it.
   */
  async function openRevisions(): Promise<void> {
    await saveNow();
    revisionsOpen = true;
  }

  async function afterRestore(): Promise<void> {
    revisionsOpen = false;
    await openScript(scriptId);
    showToast('Revision restored. Your previous text was saved as a revision.', 'success');
  }

  const overflowItems = $derived([
    { label: 'Duplicate', onselect: () => void scriptsService.duplicateScript(scriptId).then(loadLibrary) },
    { label: 'Revision history…', onselect: () => void openRevisions() },
    {
      label: 'Export Markdown',
      onselect: () => void exportScriptToFile(scriptId, $editor.title, 'markdown'),
    },
    { label: 'Reveal data folder', onselect: () => void revealFolder() },
    { label: 'Move to Trash', danger: true, onselect: () => void trashFromEditor() },
  ]);

  function startDividerDrag(event: PointerEvent): void {
    const container = (event.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      splitRatio = Math.min(0.75, Math.max(0.25, (e.clientX - rect.left) / rect.width));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(SPLIT_KEY, String(splitRatio));
      } catch {
        /* non-fatal */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
</script>

<div class="page">
  <PageHeader
    title={$editor.title || 'Untitled script'}
    meta={meta || undefined}
    backLabel="Library"
    onback={() => goBack()}
    editableTitle
    ontitlechange={(t) => void setTitle(t)}
  >
    {#snippet status()}
      {#if $editor.saveState === 'error'}
        <button type="button" class="save-issue" onclick={() => (saveIssueOpen = true)}>
          <StatusPill tone="danger" label={saveLabel} />
        </button>
      {:else if $editor.saveState === 'conflict'}
        <button type="button" class="save-issue" onclick={() => (conflictOpen = true)}>
          <StatusPill tone="warning" label={saveLabel} />
        </button>
      {:else if saveLabel}
        <span class="save-state" aria-live="polite">{saveLabel}</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      <SegmentedControl
        label="Editor mode"
        options={[
          { value: 'edit', label: 'Edit' },
          { value: 'split', label: 'Split' },
          { value: 'preview', label: 'Preview' },
        ]}
        value={$editor.mode}
        onchange={(mode) => setEditorMode(mode as 'edit' | 'split' | 'preview')}
      />
      <IconButton
        icon="doc"
        label={panelOpen ? 'Hide outline panel' : 'Show outline panel'}
        active={panelOpen}
        onclick={() => (panelOpen = !panelOpen)}
      />
      <OverflowMenu items={overflowItems} label="Script actions" />
      <Button variant="primary" disabled={$takeStarting} onclick={() => present()}>
        {$takeStarting ? 'Opening stage…' : 'Present'}
      </Button>
    {/snippet}
  </PageHeader>

  {#if $editor.mode !== 'preview'}
    <div class="toolbar" role="toolbar" aria-label="Insert">
      <IconButton icon="chevron-right" label="Insert heading" onclick={() => withView(inserts.insertHeading)} />
      <button type="button" class="glyph" aria-label="Bold" title="Bold" onclick={() => withView(inserts.insertBold)}><strong>B</strong></button>
      <button type="button" class="glyph" aria-label="Italic" title="Italic" onclick={() => withView(inserts.insertItalic)}><em>I</em></button>
      <IconButton icon="link" label="Insert link" onclick={() => withView(inserts.insertLink)} />
      <span class="toolbar-rule" aria-hidden="true"></span>
      <IconButton icon="flag" label="Insert cue" onclick={() => withView(inserts.insertCue)} />
      <IconButton icon="image" label="Insert image" onclick={() => void insertImage()} />
      <IconButton icon="diagram" label="Insert diagram block" onclick={() => withView(inserts.insertDiagram)} />
      <IconButton icon="restore" label="Insert take marker" onclick={() => withView(inserts.insertTakeMarker)} />
    </div>
  {/if}

  <div class="body">
    <div class="work">
      {#if $editor.loading}
        <p class="loading">Opening script…</p>
      {:else if $editor.mode === 'preview'}
        <div class="preview only" bind:this={previewScroller}>
          {#if blocks.length > 0}
            <RenderBlocks {blocks} onblockclick={previewBlockClick} />
          {:else}
            <p class="preview-empty">Your rendered script will appear here.</p>
          {/if}
        </div>
      {:else if $editor.mode === 'split'}
        <div class="split">
          <div class="split-editor" style="flex-basis: {splitRatio * 100}%">
            <MarkdownEditor
              bind:this={editorRef}
              value={$editor.source}
              placeholder="Start writing, paste a script, or import Markdown…"
              onchange={setSource}
            />
          </div>
          <div
            class="divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize editor and preview"
            onpointerdown={startDividerDrag}
          ></div>
          <div class="preview" bind:this={previewScroller}>
            {#if blocks.length > 0}
              <RenderBlocks {blocks} onblockclick={previewBlockClick} />
            {:else}
              <p class="preview-empty">Your rendered script will appear here.</p>
            {/if}
          </div>
        </div>
      {:else}
        <MarkdownEditor
          bind:this={editorRef}
          value={$editor.source}
          placeholder="Start writing, paste a script, or import Markdown…"
          onchange={setSource}
        />
      {/if}
    </div>

    {#if panelOpen}
      <aside class="panel" aria-label="Outline">
        <div class="panel-head">
          <p class="panel-title">Outline</p>
        </div>

        <div class="panel-body">
            {#if outline.length > 0}
              <ul class="outline">
                {#each flattenOutline(outline) as entry (entry.node.id)}
                  <li>
                    <button
                      type="button"
                      class="outline-item"
                      style="padding-left: {10 + entry.depth * 14}px"
                      onclick={() => outlineNavigate(entry.node)}
                    >
                      <span class="outline-title">{entry.node.title}</span>
                      <span class="outline-meta">{sectionDuration(entry.node)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
              <p class="panel-meta">
                {cueCount}
                {cueCount === 1 ? 'cue' : 'cues'}
                {#if takeMarkers.length > 0}
                  · {takeMarkers.length}
                  {takeMarkers.length === 1 ? 'take marker' : 'take markers'}
                {/if}
              </p>
            {:else}
              <p class="panel-empty">Headings appear here as you write.</p>
            {/if}
        </div>

        <div class="panel-foot" aria-live="polite">
          {#if $compiled.status === 'compiling'}
            <span class="foot-line neutral">Reading the script…</span>
          {:else if $compiled.status === 'ready' && blockingCount === 0 && diagnostics.length === 0}
            <span class="foot-line good">
              <Icon name="check" size={14} />
              Ready to present.
            </span>
          {:else if $compiled.status === 'ready'}
            <ul class="diagnostics">
              {#each diagnostics as diagnostic (diagnostic.code + String(diagnostic.source?.utf16Start ?? ''))}
                <li class="diagnostic {diagnostic.severity}">
                  <Icon name={diagnostic.severity === 'error' ? 'alert' : 'info'} size={13} />
                  <button
                    type="button"
                    class="diagnostic-text"
                    onclick={() => diagnostic.source && goToOffset(diagnostic.source.utf16Start)}
                  >
                    {diagnostic.message}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </aside>
    {/if}
  </div>
</div>

<!-- §21.4 revision browser -->
<RevisionHistory
  open={revisionsOpen}
  {scriptId}
  expectedRevision={$editor.scriptRevision}
  currentWordCount={wordCount}
  onclose={() => (revisionsOpen = false)}
  onrestored={() => void afterRestore()}
/>

<!-- F.8 save-failure sheet -->
<Dialog open={saveIssueOpen} title="Save failed" onclose={() => (saveIssueOpen = false)}>
  <p class="dialog-body">Your current text is still open and has not been discarded.</p>
  {#if $editor.lastError}
    <p class="dialog-detail">{$editor.lastError}</p>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => void revealFolder()}>Reveal data folder</Button>
    <Button variant="ghost" onclick={() => void copyAllText()}>Copy all text</Button>
    <Button
      variant="primary"
      onclick={() => {
        saveIssueOpen = false;
        void manualSave();
      }}
    >
      Retry
    </Button>
  {/snippet}
</Dialog>

<!-- F.8 external-change conflict sheet -->
<Dialog open={conflictOpen} title="This script changed on disk" onclose={() => (conflictOpen = false)}>
  <p class="dialog-body">
    Choose which version to keep. CandidCue will save the other version as a revision.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => void saveBothVersions()}>Save both</Button>
    <Button onclick={() => void loadDiskVersion()}>Load disk version</Button>
    <Button variant="primary" onclick={() => void keepCandidCueVersion()}>Keep CandidCue version</Button>
  {/snippet}
</Dialog>

<style>
  .page {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .save-state {
    font-size: var(--text-sm);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .save-issue {
    border: none;
    background: transparent;
    padding: 0;
    display: inline-flex;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--page-x);
    border-bottom: 1px solid var(--border);
    background: var(--bg-canvas);
  }
  .toolbar-rule {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 var(--space-2);
  }
  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--icon-control-h);
    height: var(--icon-control-h);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .glyph:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    min-width: 0;
  }

  .work {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
  }

  .loading {
    margin: var(--space-6) var(--page-x);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .split {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    min-width: 0;
  }
  .split-editor {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    flex-grow: 0;
    flex-shrink: 0;
  }
  .divider {
    flex: 0 0 auto;
    width: 7px;
    cursor: col-resize;
    background: transparent;
    border-left: 1px solid var(--border);
    transition: background var(--dur-fast) var(--ease-out);
  }
  .divider:hover {
    background: var(--bg-hover-surface);
  }

  .preview {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-6) var(--page-x);
    background: var(--bg-panel);
  }
  .preview.only {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .preview-empty {
    margin: var(--space-6) 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  /* Outline / vocabulary rail — warm chrome, seam on the left via border on
     the container (a straight panel edge, not a rounded box). */
  .panel {
    flex: 0 0 264px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-chrome);
    border-left: 1px solid var(--border);
  }
  .panel-head {
    padding: var(--space-3) var(--space-4);
  }
  .panel-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--space-4) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .outline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .outline-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    width: 100%;
    min-height: 30px;
    padding: var(--space-1) 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    text-align: left;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .outline-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  .outline-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .outline-meta {
    flex: 0 0 auto;
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .panel-meta {
    margin: 0;
    font-size: var(--text-meta);
    color: var(--text-muted);
  }

  .vocab {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .vocab-row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .vocab-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .vocab-term {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vocab-kind {
    flex: 0 0 auto;
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }
  .vocab-spoken,
  .vocab-aliases {
    font-size: var(--text-2xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .vocab-generated {
    font-size: var(--text-2xs);
    color: var(--accent-strong);
  }
  .panel-empty {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
  }
  .panel-note {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-faint);
  }

  .panel-foot {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
  }
  .foot-line {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-meta);
    font-weight: 600;
  }
  .foot-line.good {
    color: var(--success);
  }
  .foot-line.neutral {
    color: var(--text-muted);
  }

  .diagnostics {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .diagnostic {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
  }
  .diagnostic.error {
    color: var(--danger);
  }
  .diagnostic.warning {
    color: var(--warning);
  }
  .diagnostic.info {
    color: var(--text-muted);
  }
  .diagnostic-text {
    border: none;
    background: transparent;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .dialog-body {
    margin: 0;
  }
  .dialog-detail {
    margin: 0;
    font-size: var(--text-meta);
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
</style>
