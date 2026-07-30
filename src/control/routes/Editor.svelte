<!--
  Editor screen (spec §13): header with editable title, truthful save state
  (F.8), Edit/Split/Preview modes, minimal insert toolbar (§13.6), CodeMirror
  Markdown editor full-bleed on its panel, outline panel
  (§13.3/§13.4), readiness messages (F.9).
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { EditorSelection } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import Button from '../components/Button.svelte';
  import Dialog from '../components/Dialog.svelte';
  import Icon from '../components/Icon.svelte';
  import IconButton from '../components/IconButton.svelte';
  import MarkdownEditor from '../components/MarkdownEditor.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
import SplitButton from '../components/SplitButton.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import RenderBlocks from '../components/RenderBlocks.svelte';
  import RevisionHistory from '../components/RevisionHistory.svelte';
  import ScriptLintPanel from '../components/ScriptLintPanel.svelte';
  import SegmentedControl from '../components/SegmentedControl.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { exportScriptToFile } from '../lib/app-actions';
  import { presentMenuItems } from '../lib/present-menu';
import { startTake, takeStarting } from '../lib/start-take';
import type { PresentationMode } from '../services/settings-types';
  import { estimateDurationSeconds, formatSpeakingDuration } from '../lib/format';
  import * as inserts from '../lib/markdown-insert';
  import { lintScriptSource, type ScriptLintFinding } from '../lib/script-lint';
  import { onShortcut } from '../lib/shortcuts';
  import * as assetsService from '../services/assets';
  import { describeError } from '../services/errors';
  import * as scriptsService from '../services/scripts';
  import { settings } from '../stores/settings';
  import { compiled } from '../stores/compiled';
  import { requestConfirm } from '../stores/confirm';
  import {
    conflictCopyTitle,
    editor,
    keepEditorVersion,
    openScript,
    saveNow,
    setEditorMode,
    setSource,
    setTitle,
    useDiskVersion,
    type ConflictOutcome,
  } from '../stores/editor';
  import { duplicateScript, loadLibrary, moveScriptToTrash } from '../stores/library';
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
  let conflictResolving = $state(false);
  let revisionsOpen = $state(false);
  let splitRatio = $state(readSplitRatio());
  let previewScroller: HTMLElement | null = $state(null);
  let toolbarEl: HTMLElement | null = $state(null);

  const SPLIT_KEY = 'candidcue.editor.split.v1';

  /*
   * The divider's travel, as one set of numbers.
   *
   * The pointer drag, the keyboard steps and the `aria-value*` the splitter
   * announces all have to agree about where the ends are, or the control says
   * one thing and does another.
   */
  const SPLIT_MIN = 0.25;
  const SPLIT_MAX = 0.75;
  const SPLIT_STEP = 0.05;

  function clampSplit(ratio: number): number {
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
  }

  function readSplitRatio(): number {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SPLIT_KEY) : null;
      const parsed = raw ? Number(raw) : NaN;
      return Number.isFinite(parsed) ? clampSplit(parsed) : 0.5;
    } catch {
      return 0.5;
    }
  }

  function persistSplitRatio(): void {
    try {
      localStorage.setItem(SPLIT_KEY, String(splitRatio));
    } catch {
      /* non-fatal */
    }
  }

  $effect(() => {
    void openScript(scriptId).catch((err) => {
      showToast(`Could not open script: ${describeError(err)}`, 'danger');
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

  /*
   * A compile that FAILED, as opposed to a document with nothing in it.
   *
   * Both leave `blocks` empty, and the preview branched on that alone — so a
   * script the compiler choked on rendered as "Your rendered script will
   * appear here.", the same sentence a blank document shows. The one state
   * where the author most needs to be told something was the state that said
   * nothing.
   *
   * Gated on `scriptId` for the reason the compiled store keeps that field at
   * all: a failure belonging to the script you just left must not be reported
   * against the one you just opened.
   */
  const compileFailed = $derived($compiled.status === 'error' && $compiled.scriptId === scriptId);

  /*
   * `compiled.ts` stores its failure as `String(err)`, and the compiler
   * service rejects with a real `Error`, so the string arrives carrying a
   * bare "Error:" that means nothing to the person reading it. An error with
   * no message stringifies to just "Error", which is why the colon is
   * optional and why an empty remainder yields no detail line at all rather
   * than a generic apology under a heading that already apologised.
   */
  const compileErrorDetail = $derived.by(() => {
    const message = ($compiled.error ?? '').replace(/^Error:?\s*/, '').trim();
    return message === '' ? '' : describeError(message);
  });

  const meta = $derived(
    wordCount > 0
      ? `${wordCount.toLocaleString()} words · ${formatSpeakingDuration(durationSeconds)} · ${cueCount} ${cueCount === 1 ? 'cue' : 'cues'}`
      : '',
  );

  /*
   * Script lint (lib/script-lint.ts), run on the compile's cadence.
   *
   * Every rule in it is a claim about a paragraph or a sentence, and neither of
   * those changes on a keystroke — so linting per keystroke would spend a full
   * pass over the document to redraw the same three notes. The editor already
   * owns one debounce for exactly this problem (`COMPILE_DEBOUNCE_MS`), and a
   * second timer beside it would only be a second thing to keep in step, so the
   * lint waits on that one instead: `compiled.editorRevision` catching up to
   * `editor.editorRevision` is precisely the signal that typing has settled,
   * and it costs no timer of its own. `saveNow()` flushes the pending compile,
   * so pressing Present settles the notes too.
   *
   * The previous findings stay on screen while the next compile is in flight.
   * Clearing them on each keystroke would make the notes blink out and back on
   * every letter — an accusation made and withdrawn, several times a second.
   */
  let lintFindings = $state<ScriptLintFinding[]>([]);

  /*
   * The text `lintFindings` already describes.
   *
   * The revision gate below says a compile has SETTLED; it says nothing about
   * whether the text changed since the last one. `$editor` also updates for
   * save state, title and mode, so without this a single typing pause bought
   * three full passes over the document — compile ready, then `saving`, then
   * `saved` — and every Edit/Split/Preview switch bought another. A pass is not
   * free: `lintScriptSource` masks the source character by character and
   * re-tokenises every paragraph and every sentence in it, on the main thread,
   * in the editor the author is still typing in.
   *
   * Keyed on the source rather than on the revision, because a revision number
   * is not unique over time: reopening the same script (a restore, either arm
   * of the conflict sheet) starts again at 0, and a memo keyed on 0 would
   * answer a restored document with the notes from the one it replaced. The
   * source is the lint's only input, so it is also the only honest key — and in
   * the case this exists for, `state.update` rebuilds the state object around
   * the same string, so the comparison is a pointer check.
   *
   * A plain `let`, not `$state`: the effect writes it, and the effect must not
   * become its own dependency.
   */
  let lintedSource: string | null = null;

  $effect(() => {
    const ed = $editor;
    const compiledRevision = $compiled.editorRevision;
    // A script that is still opening still has the previous one's text in hand,
    // and notes about a script you have left is the worst kind of stale.
    if (ed.scriptId !== scriptId || ed.loading) {
      lintFindings = [];
      lintedSource = null;
      return;
    }
    if (compiledRevision !== ed.editorRevision) return;
    if (ed.source === lintedSource) return;
    lintedSource = ed.source;
    lintFindings = lintScriptSource(ed.source);
  });

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
   *
   * `mode` is absent for the main button, which presents in whatever the saved
   * default is, and set when the choice came from the split menu — which also
   * makes that choice the new default. See `StartTakeOptions.presentationMode`
   * for why an explicit choice sticks when the mid-take toggle does not.
   */
  async function present(mode?: PresentationMode): Promise<void> {
    await saveNow();
    await startTake(scriptId, mode === undefined ? {} : { presentationMode: mode });
  }

  const presentModeItems = $derived(
    presentMenuItems($settings.stage.presentationMode, (mode) => void present(mode)),
  );

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

  /**
   * Change mode without destroying what the author has typed.
   *
   * Edit and Split used to render a `MarkdownEditor` from two different `{#if}`
   * branches, and Preview rendered none. Svelte reconciles branches, not
   * positions, so every switch between the three destroyed the component — and
   * with it the `EditorView` that owns the undo stack and the selection. Moving
   * Edit → Split to compare a paragraph against its rendering, and moving back,
   * silently threw away the history for the whole session.
   *
   * There is now one instance for all three modes and the panes are shown and
   * hidden with CSS, so this only has to bring the surface back into view:
   * `tick()` for the class change to land, `requestMeasure()` because a
   * CodeMirror that was `display: none` has stale geometry, and `focus()`
   * because WebKit can otherwise leave the caret un-blinking in a pane the
   * user just asked for.
   */
  async function showEditingSurface(mode: 'edit' | 'split' = 'edit'): Promise<void> {
    const wasHidden = $editor.mode === 'preview';
    if (wasHidden) setEditorMode(mode);
    await tick();
    if (!wasHidden) return;
    withView((view) => {
      view.requestMeasure();
      view.focus();
    });
  }

  /** Bring the editing surface back when the click came from Preview. */
  async function ensureEditingSurface(): Promise<void> {
    if ($editor.mode !== 'preview') return;
    await showEditingSurface('edit');
  }

  /**
   * The mode switch itself. Going back to a pane that was hidden needs the
   * same remeasure a Preview click does — nothing was unmounted, but a hidden
   * CodeMirror measured itself at zero.
   *
   * It remeasures and does NOT focus, which is the difference between this and
   * `showEditingSurface`. The mode control is a radiogroup: arrow keys move
   * the selection through it, so pulling focus into the editor on the way out
   * of Preview meant the next arrow key moved the caret instead of reaching
   * Edit, and the group could not be operated the way its role promises.
   * Focus belongs to the actions that ask for the editor by name — a preview
   * block, a lint finding.
   */
  async function changeMode(mode: 'edit' | 'split' | 'preview'): Promise<void> {
    const wasHidden = $editor.mode === 'preview';
    setEditorMode(mode);
    await tick();
    if (!wasHidden || mode === 'preview') return;
    withView((view) => view.requestMeasure());
  }

  /**
   * Take a lint finding's run to the editor.
   *
   * The cursor lands at the start of the run and as much of the run as the pane
   * holds follows it into view — the run is revealed, never selected.
   * `finding.length` is a real extent — a long paragraph, a whole sentence —
   * and selecting it would leave the next keystroke poised to replace the text
   * the note was asking the author to look at. Advice does not get to arm a
   * delete.
   */
  async function goToFinding(finding: ScriptLintFinding): Promise<void> {
    await ensureEditingSurface();
    withView((view) => {
      const doc = view.state.doc;
      const line = doc.line(Math.min(Math.max(1, finding.line), doc.lines));
      const anchor = Math.min(line.from + Math.max(0, (finding.column ?? 1) - 1), line.to);
      // A run may cross line endings, so its end is resolved against the
      // document rather than against the line it was reported on.
      const end = Math.min(anchor + Math.max(0, finding.length ?? 0), doc.length);
      view.dispatch({
        selection: { anchor },
        /*
         * End first, so the range's HEAD is the cursor.
         *
         * CodeMirror scrolls the union of a range's two ends, and when the run
         * is taller than the pane it can only keep one of them. Which one is
         * decided by `range.head < range.anchor ? -1 : 1`, and only the -1 case
         * holds the top of the rect. Written the natural way round this scrolled
         * a long paragraph's LAST line to the bottom edge and left the cursor —
         * and the line the note is actually about — above the top of the view.
         * The findings most worth clicking are the longest ones, so that was the
         * common case, not the corner.
         */
        effects: EditorView.scrollIntoView(EditorSelection.range(end, anchor)),
      });
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

  /**
   * Preview click returns to Edit mode at the block's source (§13.2).
   *
   * It only switched modes before. `goToOffset` ran against an `editorRef` that
   * Preview had already unmounted, so the one thing the handler exists to do —
   * land the caret on the block you clicked — never happened in the one mode it
   * was written for. Split worked, because there the editor is on screen.
   */
  async function previewBlockClick(block: CompiledBlock): Promise<void> {
    await ensureEditingSurface();
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

  /**
   * Run one arm of the conflict sheet.
   *
   * The sheet closes only once the operation has SUCCEEDED. Both arms move
   * text that exists in exactly one place, and closing first — which is what
   * the previous implementation did — takes the choice away at the moment it
   * is most likely to be needed again. On a failure the sheet stays up with
   * the editor's text still behind it, so the user can pick the other arm or
   * try the same one again.
   */
  async function resolveConflict(
    run: () => Promise<ConflictOutcome>,
    done: (outcome: ConflictOutcome, copyName: string) => string,
  ): Promise<void> {
    if (conflictResolving) return;
    conflictResolving = true;
    // Read before the await: a successful arm replaces the title with the
    // disk one, and the toast has to name the copy that was actually made.
    const copyName = conflictCopyName;
    try {
      const outcome = await run();
      conflictOpen = false;
      showToast(done(outcome, copyName), 'success');
    } catch (err) {
      showToast(`Nothing was changed. ${describeError(err)}`, 'danger');
    } finally {
      conflictResolving = false;
    }
  }

  const conflictCopyName = $derived(conflictCopyTitle($editor.title));

  /**
   * Escape and the scrim are refused while an arm is in flight.
   *
   * Dismissing mid-operation is what let a slow resolution finish against a
   * script the user had already left, and it would also drop the only sheet
   * offering the choice at the moment it is most needed.
   */
  function closeConflict(): void {
    if (conflictResolving) return;
    conflictOpen = false;
  }

  async function trashFromEditor(): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Delete script?',
      body: `${$editor.title} will move to Trash and can be restored for 30 days.`,
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (!accepted) return;
    // Leave the document only if it actually moved. The store reports the
    // failure itself; navigating away regardless would add a second wrong thing
    // on top of the first — the script still here, and the author no longer in
    // it. That is what the mutator's boolean is for.
    if (!(await moveScriptToTrash(scriptId))) return;
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
    // Through the store, not the service: the store is where a duplicate that
    // fails gets said out loud, and it reloads the library either way. Calling
    // the service directly from here had no catch and no notice at all.
    { label: 'Duplicate', onselect: () => void duplicateScript(scriptId) },
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
      splitRatio = clampSplit((e.clientX - rect.left) / rect.width);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      persistSplitRatio();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /**
   * The splitter from the keyboard (WAI-ARIA window splitter).
   *
   * It carried `role="separator"` and an `aria-label` and nothing else, so it
   * announced itself as a resize control that could not be reached, moved or
   * read — the one combination worse than not claiming the role at all.
   * Arrow keys step, Home and End go to the ends of the SAME travel the drag
   * is clamped to, and a keyboard move persists exactly like a drag does.
   */
  function onDividerKeydown(event: KeyboardEvent): void {
    const next = (() => {
      switch (event.key) {
        case 'ArrowLeft':
          return splitRatio - SPLIT_STEP;
        case 'ArrowRight':
          return splitRatio + SPLIT_STEP;
        case 'Home':
          return SPLIT_MIN;
        case 'End':
          return SPLIT_MAX;
        default:
          return null;
      }
    })();
    if (next === null) return;
    event.preventDefault();
    splitRatio = clampSplit(next);
    persistSplitRatio();
  }

  const splitPercent = $derived(Math.round(splitRatio * 100));

  /*
   * Roving tabindex for the insert toolbar (WAI-ARIA toolbar).
   *
   * The container claimed `role="toolbar"` while every button inside it stayed
   * a tab stop of its own, so the pattern the role promises — one stop for the
   * group, arrows to move within it — was announced and not implemented, and
   * eight buttons sat between the editor and everything after it.
   *
   * The buttons are heterogeneous (IconButton components and plain glyph
   * buttons), so the tab stop is managed on the live DOM nodes rather than
   * threaded through each child as a prop, which would mean editing shared
   * components that another change owns.
   */
  let toolbarIndex = $state(0);

  function toolbarButtons(): HTMLButtonElement[] {
    return toolbarEl ? Array.from(toolbarEl.querySelectorAll('button:not([disabled])')) : [];
  }

  $effect(() => {
    // Re-read on mode changes: the toolbar is not rendered in Preview.
    void $editor.mode;
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    const active = Math.min(toolbarIndex, buttons.length - 1);
    buttons.forEach((button, i) => {
      button.tabIndex = i === active ? 0 : -1;
    });
  });

  function onToolbarKeydown(event: KeyboardEvent): void {
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (() => {
      switch (event.key) {
        case 'ArrowRight':
          return (Math.max(0, from) + 1) % buttons.length;
        case 'ArrowLeft':
          return (Math.max(0, from) - 1 + buttons.length) % buttons.length;
        case 'Home':
          return 0;
        case 'End':
          return buttons.length - 1;
        default:
          return null;
      }
    })();
    if (next === null) return;
    event.preventDefault();
    toolbarIndex = next;
    buttons[next]?.focus();
  }

  /** A button reached with the pointer becomes the group's tab stop. */
  function onToolbarFocusIn(event: FocusEvent): void {
    const index = toolbarButtons().indexOf(event.target as HTMLButtonElement);
    if (index >= 0) toolbarIndex = index;
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
        onchange={(mode) => void changeMode(mode as 'edit' | 'split' | 'preview')}
      />
      <IconButton
        icon="doc"
        label={panelOpen ? 'Hide outline panel' : 'Show outline panel'}
        active={panelOpen}
        onclick={() => (panelOpen = !panelOpen)}
      />
      <OverflowMenu items={overflowItems} label="Script actions" />
      <SplitButton
        variant="primary"
        label={$takeStarting ? 'Opening stage…' : 'Present'}
        menuLabel="How to present"
        disabled={$takeStarting}
        items={presentModeItems}
        onclick={() => void present()}
      />
    {/snippet}
  </PageHeader>

  {#if $editor.mode !== 'preview'}
    <!--
      Heading is a typographic glyph rather than an icon, like Bold and Italic
      beside it: the icon set has no heading mark, and it is owned by another
      change. It wore a chevron, which means "go forward" everywhere else in
      the product.

      "Insert cue" gives up `flag` to the take marker, which was wearing the
      undo arrow. The compiler models take markers as navigation targets — a
      flag is exactly that — and a cue is an aside to the presenter.
    -->
    <div
      class="toolbar"
      role="toolbar"
      aria-label="Insert"
      aria-orientation="horizontal"
      bind:this={toolbarEl}
      onkeydown={onToolbarKeydown}
      onfocusin={onToolbarFocusIn}
    >
      <button type="button" class="glyph" aria-label="Cycle heading level" title="Cycle heading level" onclick={() => withView(inserts.cycleHeading)}><strong>H</strong></button>
      <button type="button" class="glyph" aria-label="Bold" title="Bold" onclick={() => withView(inserts.insertBold)}><strong>B</strong></button>
      <button type="button" class="glyph" aria-label="Italic" title="Italic" onclick={() => withView(inserts.insertItalic)}><em>I</em></button>
      <IconButton icon="link" label="Insert link" onclick={() => withView(inserts.insertLink)} />
      <span class="toolbar-rule" aria-hidden="true"></span>
      <IconButton icon="info" label="Insert cue" onclick={() => withView(inserts.insertCue)} />
      <IconButton icon="image" label="Insert image" onclick={() => void insertImage()} />
      <IconButton icon="diagram" label="Insert diagram block" onclick={() => withView(inserts.insertDiagram)} />
      <IconButton icon="flag" label="Insert take marker" onclick={() => withView(inserts.insertTakeMarker)} />
    </div>
  {/if}

  <div class="body">
    <div class="work">
      {#if $editor.loading}
        <p class="loading">Opening script…</p>
      {:else}
        <!--
          ONE editor and ONE preview for all three modes, shown and hidden with
          CSS. Rendering them from separate `{#if}` branches per mode is what
          destroyed the CodeMirror instance — and the undo history with it — on
          every Edit/Split/Preview switch.
        -->
        <div class="split" class:preview-only={$editor.mode === 'preview'}>
          <div
            class="split-editor"
            id="editor-pane"
            hidden={$editor.mode === 'preview'}
            style={$editor.mode === 'split' ? `flex-basis: ${splitRatio * 100}%` : undefined}
          >
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
            tabindex="0"
            aria-orientation="vertical"
            aria-label="Resize editor and preview"
            aria-controls="editor-pane"
            aria-valuenow={splitPercent}
            aria-valuemin={SPLIT_MIN * 100}
            aria-valuemax={SPLIT_MAX * 100}
            aria-valuetext="Editor {splitPercent}% of the width"
            hidden={$editor.mode !== 'split'}
            onpointerdown={startDividerDrag}
            onkeydown={onDividerKeydown}
          ></div>
          <div class="preview" hidden={$editor.mode === 'edit'} bind:this={previewScroller}>
            {#if compileFailed}
              <div class="preview-failed" role="status">
                <p class="preview-failed-title">This script could not be rendered.</p>
                <p class="preview-failed-body">
                  Your text is safe and still in the editor. Fix the problem below, and the
                  preview comes back on its own.
                </p>
                {#if compileErrorDetail}
                  <p class="preview-failed-detail">{compileErrorDetail}</p>
                {/if}
              </div>
            {:else if blocks.length > 0}
              <RenderBlocks {blocks} onblockclick={(b) => void previewBlockClick(b)} />
            {:else}
              <p class="preview-empty">Your rendered script will appear here.</p>
            {/if}
          </div>
        </div>
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

        <!-- Advisory only, and placed accordingly: above the compile status
             rather than inside it, so prose advice never sits in the same list
             as a diagnostic that can stop a script rendering. -->
        <ScriptLintPanel findings={lintFindings} ongoto={(f) => void goToFinding(f)} />

        <div class="panel-foot" aria-live="polite">
          {#if compileFailed}
            <!-- Without this the rail went silent on the one status that
                 stops a script rendering at all. -->
            <span class="foot-line bad">
              <Icon name="alert" size={14} />
              Could not render this script.
            </span>
          {:else if $compiled.status === 'compiling'}
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

<!--
  F.8 external-change conflict sheet.

  The copy now names where each version actually goes. It promised a revision
  for "the other version" while the disk arm wrote nothing at all, which was
  the one promise the user had to trust with text that existed nowhere else.

  "Save both" is gone: once the disk arm preserves the editor's text, it and
  "Save both" did the same thing, and two buttons with one outcome is a worse
  choice than one honest button.
-->
<Dialog
  open={conflictOpen}
  title="This script changed on disk"
  onclose={closeConflict}
>
  <p class="dialog-body">
    Choose which version stays in this script. Nothing is discarded either way.
  </p>
  <p class="dialog-detail">
    Use the disk version and your current edits are saved to the Library as
    “{conflictCopyName}”. Keep your edits and the disk version stays in this
    script's revision history.
  </p>
  {#snippet footer()}
    <Button
      disabled={conflictResolving}
      onclick={() =>
        void resolveConflict(useDiskVersion, (outcome, copyName) =>
          outcome.copied
            ? `Loaded the disk version. Your edits were saved as “${copyName}”.`
            : 'Loaded the disk version. It already matched your text, so no copy was needed.',
        )}
    >
      Use disk version
    </Button>
    <Button
      variant="primary"
      disabled={conflictResolving}
      onclick={() =>
        void resolveConflict(
          keepEditorVersion,
          () => 'Kept your edits. The disk version is in this script’s revision history.',
        )}
    >
      Keep my edits
    </Button>
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
  /* The panes are hidden rather than unmounted, so the editor keeps its undo
     history across mode switches. `display` is set on all three below, which
     beats the UA's `[hidden]` rule — so it has to be restated here or a
     "hidden" pane stays on screen. */
  .split > [hidden] {
    display: none;
  }
  .split-editor {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    flex-grow: 0;
    flex-shrink: 0;
  }
  /* Edit and Preview give the visible pane the whole width; only Split reads
     the stored ratio, which the inline flex-basis supplies. */
  .split-editor:not([style]) {
    flex-grow: 1;
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
  /* A small control, so it keeps the standard ring — the house rule against
     accent focus treatment is about editors, panels and rows. */
  .divider:focus-visible {
    outline: var(--focus-ring);
    outline-offset: -2px;
  }

  .preview {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-6) var(--page-x);
    background: var(--bg-panel);
  }
  .preview-only .preview {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .preview-empty {
    margin: var(--space-6) 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  /* A failed compile, which used to be indistinguishable from a blank
     document because both render no blocks. */
  .preview-failed {
    margin: var(--space-6) 0;
    max-width: 52ch;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .preview-failed-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--danger);
  }
  .preview-failed-body {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }
  .preview-failed-detail {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  /* Outline / vocabulary rail — warm chrome, seam on the left via border on
     the container (a straight panel edge, not a rounded box). */
  .panel {
    flex: 0 0 264px;
    /* A flex item's automatic minimum is its CONTENT's minimum, and a heading
       row is `white-space: nowrap` — so one long headline made the rail's
       min-content width the width of that headline and the basis above stopped
       meaning anything. The rail grew to ~750px and took the editor's column
       with it. The row still ellipsizes; this is what lets it. */
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-chrome);
    border-left: 1px solid var(--border);
  }
  .panel-head {
    padding: var(--space-3) var(--space-4) var(--space-2);
  }
  /* The rail's section label. Sized here rather than left to the UA, which
     gives a bare `<p>` a 1em margin top and bottom — that margin sat inside
     `.panel-head`'s own padding and read as a doubled inset. */
  .panel-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }
  /* ONE text edge for the whole rail.
     A row carries a 10px inset of its own so its hover pill has somewhere to
     be, so the container gives exactly that much back: row text then starts on
     the same 16px edge as the label above it, and only the pill reaches
     further out. Both paddings at full width stacked into a 26px inset that
     read as a margin inside a margin. `--rail-pill-inset` is shared with the
     plain text below, which has no pill and so pays the inset itself. */
  .panel-body {
    --rail-pill-inset: 10px;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 0 calc(var(--space-4) - var(--rail-pill-inset)) var(--space-4);
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

  /* Plain text in the rail: no pill of its own, so it pays the row inset
     itself and lands on the same edge as the rows and the label. */
  .panel-meta {
    margin: 0;
    padding: 0 var(--rail-pill-inset, 10px);
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
    padding: 0 var(--rail-pill-inset, 10px);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
  }
  .panel-note {
    margin: 0;
    padding: 0 var(--rail-pill-inset, 10px);
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
  .foot-line.bad {
    color: var(--danger);
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
