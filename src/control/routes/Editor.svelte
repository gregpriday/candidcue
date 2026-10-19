<!--
  Editor screen (spec §13): header with editable title, truthful save state
  (F.8), Edit/Preview modes, minimal insert toolbar (§13.6), CodeMirror
  Markdown editor full-bleed on its panel, outline panel
  (§13.3/§13.4), readiness messages (F.9).
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { EditorSelection } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import Button from '../components/Button.svelte';
  import Dialog from '../components/Dialog.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Icon from '../components/Icon.svelte';
  import IconButton from '../components/IconButton.svelte';
  import MarkdownEditor from '../components/MarkdownEditor.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
import SplitButton from '../components/SplitButton.svelte';
  import PaneDivider from '../components/PaneDivider.svelte';
  import ScriptConflictSheet, {
    type ConflictArm,
    type ConflictFailure,
  } from '../components/ScriptConflictSheet.svelte';
  import StatusBar from '../components/StatusBar.svelte';
  import Toolbar from '../components/Toolbar.svelte';
  import type { StatusBarItem } from '../components/status-bar-item';
  import { formatAccelerator } from '../lib/commands';
  import { setDropTargetScript } from '../services/desktop-shell';
  import { detectPlatform } from '../lib/platform';
  import { osCopy } from '../lib/os-copy';
  import {
    PANE_LIMITS,
    setPaneWidth,
    updateWorkspace,
    workspace,
    type EditorLayout,
  } from '../stores/workspace';
  import RenderBlocks, { type PreviewBlockClick } from '../components/RenderBlocks.svelte';
  import RevisionHistory from '../components/RevisionHistory.svelte';
  import ScriptLintPanel from '../components/ScriptLintPanel.svelte';
  import SegmentedControl from '../components/SegmentedControl.svelte';
  import { exportScriptToFile } from '../lib/app-actions';
  import { scriptActionLabels } from '../lib/script-action-labels';
  import { presentMenuItems, type PresentMenuItem } from '../lib/present-menu';
  import { PRACTICE_LABEL } from '../../shared/take-vocabulary';
import { startTake, takeStarting, type TakePartRequest } from '../lib/start-take';
  import { destinationAnnouncement } from '../lib/take-destination';
  import { startMenuItems } from '../lib/present-menu';
  import { checkThenStart } from '../lib/check-then-start';
  import { voiceModelFinding } from '../lib/take-readiness';
  import { openSettingsWindow } from '../lib/open-settings';
  import { speechModelReadiness } from '../stores/speech-model-readiness';
  import { continueFrom, snapToStart, type StartPoint } from '../lib/take-start-point';
  import { partAt } from '../../shared/markdown/parts';
  import { listSessionRecords } from '../services/session-records';
  import { session } from '../stores/session';
  import { takeDestination, watchTakeDestination } from '../stores/destination';
  import { openSyntaxReference } from '../stores/syntax-reference';
import type { PresentationMode } from '../services/settings-types';
  import { isCompileSettledForScript, isEditorOpening } from '../lib/editor-readiness';
  import {
    describeSectionTime,
    estimateDurationSeconds,
    formatSectionTime,
    formatSpeakingDuration,
  } from '../lib/format';
  import { sectionWordCounts } from '../lib/outline-words';
  import {
    beginImageResolution,
    failedImages,
    parsePreviewImageRequest,
    previewImageRequestKey,
    previewImageStates,
    resolvedImages,
    type ImageResolution,
  } from '../lib/preview-images';
  import { DEFAULT_WORDS_PER_MINUTE } from '../../shared/speaking-rate';
  import * as inserts from '../lib/markdown-insert';
  import { markLanding } from '../lib/landing-marker';
  import { lintScriptSource, type ScriptLintFinding } from '../lib/script-lint';
  import { showLintRun } from '../lib/lint-run';
  import { onShortcut } from '../lib/shortcuts';
  import { onDroppedImages, onInsertCommand, onRouteCommand } from '../stores/command-bus';
  import * as assetsService from '../services/assets';
  import { describeError } from '../services/errors';
  import * as scriptsService from '../services/scripts';
  import { settings } from '../stores/settings';
  import { compiled } from '../stores/compiled';
  import { requestConfirm } from '../stores/confirm';
  import {
    conflictCopyTitle,
    DiskChangedAgainError,
    editor,
    editorHasUnsavedWork,
    flushEditorEdits,
    keepEditorVersion,
    openScript,
    retryCompile,
    revisionHistoryRequest,
    saveNow,
    setSource,
    setTitle,
    useDiskVersion,
    type ConflictOutcome,
  } from '../stores/editor';
  import { duplicateScript, loadLibrary, moveScriptToTrash } from '../stores/library';
  import { currentRoute, navigate } from '../stores/router';
  import { showToast } from '../stores/toasts';
  import type { ContextMenuItem } from '../stores/context-menu';
  import type { CompileDiagnostic, CompiledBlock, OutlineNode } from '../../shared/contracts';

  interface Props {
    scriptId: string;
  }
  let { scriptId }: Props = $props();

  let editorRef: MarkdownEditor | null = $state(null);
  /** The document-title field, so File › Rename can put the caret in it. */
  let titleInput: HTMLInputElement | null = $state(null);
  /**
   * The layout, from the workspace store rather than from local state.
   *
   * It was `let panelOpen = $state(true)` plus `$editor.mode`, both of which
   * were forgotten the moment the route unmounted. §11.5 and §11.3 ask for both
   * to persist, and the View menu has to be able to toggle them from outside
   * this component — which only works if the state lives somewhere the shell can
   * reach.
   */
  const layout = $derived($workspace.editorLayout);

  const mac = detectPlatform() === 'macos';
  /** A key hint for a tooltip, in this platform's spelling. */
  function accel(spec: string): string {
    return formatAccelerator(spec, mac);
  }
  let saveIssueOpen = $state(false);
  let conflictOpen = $state(false);
  /** The conflict arm in flight, if any. */
  let conflictArm = $state<ConflictArm | null>(null);
  let conflictFailure = $state<ConflictFailure | null>(null);
  /** Bumped to make the open sheet read the file again. */
  let conflictReread = $state(0);
  let revisionsOpen = $state(false);
  let previewScroller: HTMLElement | null = $state(null);
  let toolbarEl: HTMLElement | null = $state(null);

  /*
   * The editor stays behind one panel until everything it is about to draw is
   * in hand — see lib/editor-readiness.ts for why the document alone is not
   * enough, and why this waits for the first compile too.
   */
  let openStarted = $state(false);
  let firstCompileSettled = $state(false);
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Plain `let`: the focus effect is woken by `opening`, not by this. */
  let focusEditorWhenOpen = false;

  /**
   * How long the panel will wait for a first compile that is never coming.
   *
   * `compileScript` settles only when the worker answers — it has no timeout
   * and no `error` listener — so a worker that fails to construct leaves the
   * compile pending forever. That already costs the preview; without this it
   * would now cost the whole editor, which is a far worse trade than the one
   * this change set out to make. Generous enough never to fire on a real
   * compile, and the reserved metadata row means firing early costs no jump.
   *
   * It is time given to the COMPILE, so the clock starts when the document
   * lands rather than when the open begins — armed at the open, a slow read
   * would spend the whole allowance before the compile had been asked for.
   */
  const FIRST_COMPILE_SETTLE_TIMEOUT_MS = 2000;

  function clearSettleTimer(): void {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  function beginOpen(id: string): Promise<unknown> {
    openStarted = true;
    firstCompileSettled = false;
    clearSettleTimer();
    return openScript(id).catch((err) => {
      showToast(`Could not open script: ${describeError(err)}`, 'danger');
      void navigate({ name: 'library', view: 'all' });
    });
  }

  $effect(() => {
    void beginOpen(scriptId);
    return clearSettleTimer;
  });

  /*
   * An image dropped on the window belongs to THIS script (§11.9, §20.2).
   *
   * Registered while the editor holds a document and cleared on the way out, so
   * a drop on the Library has no target and is refused — rather than being filed
   * into whichever script happened to be open last. Rust does the import; see
   * `windows/drag_drop.rs` for why the paths never come here.
   */
  $effect(() => {
    void setDropTargetScript(scriptId);
    return () => void setDropTargetScript(null);
  });

  /*
   * …and when it lands, put the Markdown where the caret is.
   *
   * Subscribed here rather than in the shell because "at the caret" is a fact
   * only the mounted editor holds. The shell's own listener reloads the library
   * and reports; this one does the insertion.
   */
  $effect(() =>
    onDroppedImages(async (targetScriptId, markdown) => {
      if (opening || markdown.length === 0) return false;
      /*
       * Only into the script the images were imported INTO.
       *
       * Rust reads the drop target at the instant of the gesture, but the import
       * decodes every file and writes to SQLite — long enough for the route to
       * change. Inserting `assets/<hash>` into a different script writes a
       * reference to an asset that script does not own, and autosave then
       * commits a broken image to a document nobody dropped anything on.
       */
      if (targetScriptId !== scriptId) return false;
      // Force the editing surface first: dropping an image while reading the
      // preview plainly means "put it in the document", and inserting into a
      // hidden editor would look like nothing happened.
      await ensureEditingSurface();
      let inserted = false;
      withView((view) => {
        inserts.insertMarkdownBlocks(view, markdown);
        inserted = true;
      });
      if (inserted) assetRevision += 1;
      // Awaited and reported HONESTLY: the shell decides whether to say
      // anything from this answer, so claiming success before the dispatch
      // landed is how an asset ends up in a script with nothing referencing it.
      return inserted;
    }),
  );

  // A latch, never a live reading: a later compile must not raise the panel
  // back over a working editor. Order against the open effect above does not
  // matter — until that effect has run, `openStarted` is false and this bails.
  $effect(() => {
    if (!openStarted || firstCompileSettled) return;
    if (isCompileSettledForScript(scriptId, $editor, $compiled)) {
      clearSettleTimer();
      firstCompileSettled = true;
      return;
    }
    // The document is here and its compile has not answered. Start the clock.
    if ($editor.scriptId === scriptId && !$editor.loading && settleTimer === null) {
      settleTimer = setTimeout(() => {
        settleTimer = null;
        firstCompileSettled = true;
      }, FIRST_COMPILE_SETTLE_TIMEOUT_MS);
    }
  });

  const opening = $derived(
    isEditorOpening(scriptId, $editor, { openStarted, firstCompileSettled }),
  );

  /*
   * Restoring a revision reopens the same script without unmounting this route,
   * so the panel now takes the header down with it — and the overflow item the
   * revision dialog wants to hand focus back to goes with it. Put focus in the
   * text instead, which is where someone who has just restored a revision is
   * looking anyway. Only on that path: arriving from the Library should not
   * steal focus into the editor.
   */
  $effect(() => {
    if (opening || !focusEditorWhenOpen) return;
    focusEditorWhenOpen = false;
    void tick().then(() => editorRef?.focus());
  });

  $effect(() =>
    onShortcut((action) => {
      // The controls these mirror are behind the panel; the subscription is not.
      if (opening) return;
      if (action === 'save') void manualSave();
      // The same path the button takes. A shortcut that skipped readiness would
      // make the check depend on which control somebody happened to use.
      if (action === 'present') void checkThenPresent();
    }),
  );

  /*
   * The native Edit and File menu commands only this screen can carry out.
   *
   * Find, Find Next, Find Previous and Replace act on the live CodeMirror view;
   * Rename focuses the title field. None of those is something the shell can
   * reach — it holds no component handles — so the shell publishes and this
   * route answers, exactly as it already does for keyboard shortcuts.
   *
   * Without this subscription the four Edit-menu items and File › Rename were
   * ENABLED and did nothing: `dispatchRouteCommand` drops a command with no
   * listener, and there was no listener anywhere in the tree.
   */
  /*
   * The native Insert menu (§11.4), answered by the same functions the
   * formatting row calls.
   *
   * One subscription for the whole family: the menu names them and gives them
   * keys, the toolbar shows them, and both end in `lib/markdown-insert.ts` — so
   * there is no second implementation to drift.
   */
  $effect(() =>
    onInsertCommand((kind) => {
      if (opening) return;
      // Insertions need a live editor; from Preview this switches to Edit and
      // leaves a split alone, exactly as the Find family does.
      void ensureEditingSurface().then(() => {
        switch (kind) {
          case 'heading':
            withView(inserts.cycleHeading);
            break;
          case 'bold':
            withView(inserts.insertBold);
            break;
          case 'italic':
            withView(inserts.insertItalic);
            break;
          case 'link':
            withView(inserts.insertLink);
            break;
          case 'image':
            void insertImage();
            break;
          case 'diagram':
            withView(inserts.insertDiagram);
            break;
          case 'cue':
            withView(inserts.insertCue);
            break;
          case 'take-marker':
            withView(inserts.insertTakeMarker);
            break;
        }
      });
    }),
  );

  $effect(() =>
    onRouteCommand((command) => {
      if (opening) return;
      switch (command) {
        /*
         * ALL FOUR go through `ensureEditingSurface`, and that matters.
         *
         * It switches out of Preview and LEAVES A SPLIT ALONE, because the
         * editor is already on screen there. Find and Replace used to force
         * `editorLayout: 'edit'` outright, which destroyed a split somebody had
         * arranged — and Find Next / Find Previous did not switch at all, so
         * from Preview they stepped a search through a hidden editor and
         * appeared to do nothing whatsoever.
         */
        case 'edit.find':
          void ensureEditingSurface().then(() => editorRef?.openFind());
          break;
        case 'edit.find-next':
          void ensureEditingSurface().then(() => editorRef?.findNextMatch());
          break;
        case 'edit.find-previous':
          void ensureEditingSurface().then(() => editorRef?.findPreviousMatch());
          break;
        case 'edit.replace':
          void ensureEditingSurface().then(() => editorRef?.openReplace());
          break;
        case 'file.rename-script':
          void tick().then(() => {
            titleInput?.focus();
            titleInput?.select();
          });
          break;
        default:
          break;
      }
    }),
  );

  const result = $derived($compiled.result);
  const blocks = $derived(result?.blocks ?? []);
  const outline = $derived(result?.outline ?? []);
  const diagnostics = $derived(result?.diagnostics ?? []);
  const blockingCount = $derived(diagnostics.filter((d) => d.blocking).length);
  const cueCount = $derived(blocks.filter((b) => b.kind === 'cue').length);
  /*
   * §parts. Derived by the COMPILER, not here: how a script divides is a
   * property of the document, and a second derivation in the editor would
   * eventually disagree with the one the take actually runs on.
   */
  const parts = $derived(result?.parts ?? []);
  const wordCount = $derived(result?.spokenWordCount ?? 0);
  /*
   * The compiler's estimate, not one worked out here. Re-deriving it from the
   * word count with a rate of the editor's own is how this line came to read
   * 150 wpm while the Library, the compiler and the spec said 130 (#246). The
   * compile is made at the script's own rate, the same one Rust estimates the
   * Library row at, so the two can only differ if the counts do.
   */
  const durationSeconds = $derived(result?.estimatedDurationSeconds ?? 0);
  const speakingRate = $derived(
    result?.script?.statistics.wordsPerMinute ?? DEFAULT_WORDS_PER_MINUTE,
  );
  const sectionWords = $derived(sectionWordCounts(outline, wordCount));

  /*
   * The preview's pictures (#250), from the same Rust lookup the stage draws
   * from. Keyed on the script and its SET of local images rather than on the
   * compile, which is a new object on every keystroke: typing prose around a
   * picture never asks again. A compile left over from another script asks
   * nothing.
   *
   * An import is the one thing that can change Rust's answer while the set
   * stays the same: imported files are named by their content, so importing a
   * picture this script was missing (say, one pasted in from another script)
   * restores the very path it already referred to. `assetRevision` makes that
   * ask again.
   */
  const imageRequestKey = $derived(
    result?.scriptId === scriptId ? previewImageRequestKey(result.script) : null,
  );
  let assetRevision = $state(0);
  let imageResolution = $state<ImageResolution | null>(null);
  $effect(() => {
    const key = imageRequestKey;
    void assetRevision;
    if (key === null) return;
    const request = parsePreviewImageRequest(key);
    imageResolution = beginImageResolution(
      untrack(() => imageResolution),
      request.scriptId,
    );
    // Only the newest request may land: an answer for a set of images the
    // script no longer has, or for a script that is no longer open, is dropped.
    let current = true;
    assetsService.resolveAssetUrls(request.scriptId, request.assets).then(
      (urls) => {
        if (current) imageResolution = resolvedImages(request.scriptId, request, urls);
      },
      () => {
        if (current) imageResolution = failedImages(request.scriptId);
      },
    );
    return () => {
      current = false;
    };
  });
  const previewImages = $derived(previewImageStates(result?.script, imageResolution));

  /*
   * A broken directive, drawn where it is (§23.8). Every directive problem the
   * compiler reports carries `fix_directive`; each is filed under the block its
   * source starts in. One that falls between blocks (a stray closing fence) has
   * no block to sit in and stays with the rail's list.
   */
  const previewProblems = $derived.by(() => {
    const byBlock = new Map<string, CompileDiagnostic[]>();
    for (const diagnostic of diagnostics) {
      if (diagnostic.suggestedAction !== 'fix_directive' || !diagnostic.source) continue;
      const at = diagnostic.source.utf16Start;
      const block = blocks.find((b) => b.source.utf16Start <= at && at < b.source.utf16End);
      if (!block) continue;
      byBlock.set(block.id, [...(byBlock.get(block.id) ?? []), diagnostic]);
    }
    return byBlock;
  });

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

  /*
   * The same reason, for the preview's failed state — without the compiler
   * service's own advice to try again. The pane has a Try again button, and
   * "Try opening the script again" sent the author out of a document that one
   * click can now recover in place. Advice that is not about retrying (split a
   * very large script) is kept.
   */
  const previewFailureDetail = $derived(
    compileErrorDetail
      .replace(/\s*Try (?:opening the script )?again\.$/, '')
      .replace(/\s*Try again, or (\S)(.*)$/, (_all, first: string, rest: string) => ` ${first.toUpperCase()}${rest}`),
  );

  /*
   * Gated on `result` for the same reason `compileFailed` above exists: a
   * script the compiler has not finished with is not a script with nothing in
   * it. `openScript` clears the compile store and only THEN awaits the fetch,
   * so an 800-word script would announce "0 words" for the whole of that
   * window, and a failed compile — which nulls the result — would go on saying
   * it underneath the banner explaining that the compile failed.
   */
  /**
   * The document's state, as a status bar (§11.7).
   *
   * The rules this follows, and each is a line from §11.7:
   *
   *   - "Saved" is TRANSIENT and lives here, not in the toolbar. A permanent
   *     "Saved" is a claim the user stops reading; an error is not, and errors
   *     keep their place beside the title.
   *   - errors and warnings carry an icon as well as a colour (§9.4).
   *   - the layout does not move as counts change — every item is present or
   *     absent for a reason, and the numbers are tabular (set on the bar).
   *   - an item is a button only when clicking it opens something.
   */
  const statusItems = $derived<StatusBarItem[]>(
    (() => {
      const items: StatusBarItem[] = [];
      /*
       * The counts stay up while the next compile is in flight. One runs about
       * 90 ms after every pause in typing, and swapping the counts for "Reading
       * the script…" each time took the number away at exactly the moment
       * somebody glanced down for it. They are one compile behind for that
       * moment, which is the same trade the outline and the lint notes make.
       * Only a script with no compile of its own yet says it is being read.
       */
      const counted = result !== null && result.scriptId === scriptId;
      if (compileFailed) {
        items.push({
          key: 'compile',
          label: 'Could not render',
          icon: 'alert',
          tone: 'danger',
          title: compileErrorDetail || undefined,
        });
      } else if (counted) {
        items.push({
          key: 'words',
          label: `${wordCount.toLocaleString()} ${wordCount === 1 ? 'word' : 'words'}`,
        });
        // No length to estimate from no words, and a lone "—" says nothing.
        if (wordCount > 0) {
          items.push({ key: 'duration', label: formatSpeakingDuration(durationSeconds) });
        }
        if (cueCount > 0) {
          items.push({ key: 'cues', label: `${cueCount} ${cueCount === 1 ? 'cue' : 'cues'}` });
        }
      } else if ($compiled.status === 'compiling') {
        items.push({ key: 'compile', label: 'Reading the script…' });
      }
      if (diagnostics.length > 0) {
        /*
         * Both severities, each in its own tone. Reporting only the errors hid
         * the notes until the errors were fixed, so "1 issue" turned into
         * "2 notes" — work that had been there all along.
         */
        const errors = diagnostics.filter((d) => d.severity === 'error').length;
        const notes = diagnostics.length - errors;
        const parts: StatusBarItem['parts'] = [];
        if (errors > 0) {
          parts.push({
            key: 'errors',
            label: `${errors} ${errors === 1 ? 'error' : 'errors'}`,
            icon: 'alert',
            tone: 'danger',
          });
        }
        if (notes > 0) {
          parts.push({
            key: 'notes',
            label: `${notes} ${notes === 1 ? 'note' : 'notes'}`,
            icon: 'info',
            tone: 'warning',
          });
        }
        items.push({
          key: 'issues',
          label: '',
          parts,
          title: 'Show in the outline',
          // Clicking goes to the list of them, which is a meaningful
          // destination — so, and only so, this one is a button (§11.7).
          onclick: () => void showDiagnostics(errors > 0),
        });
      }
      return items;
    })(),
  );

  /**
   * Open the outline and put focus on the first diagnostic in it.
   *
   * Opening alone did nothing at all when the outline was already open, which
   * is most of the time, and left a keyboard user in the status bar rather
   * than on something they could fix. The first error when there is one,
   * because that is the one stopping the script.
   */
  async function showDiagnostics(preferErrors: boolean): Promise<void> {
    const from = document.activeElement;
    const asked = scriptId;
    updateWorkspace({ outlineVisible: true });
    // The outline lists diagnostics only between compiles — while one is in
    // flight it says "Reading the script…" in their place, and this would find
    // nothing to go to. The summary in the bar kept its count, so wait it out.
    await compileSettled();
    await tick();
    // Abandoned if somebody has opened another script, or put focus somewhere
    // else of their own accord, in the meantime.
    if (scriptId !== asked || document.activeElement !== from) return;
    const list = document.querySelector('aside[aria-label="Outline"] .diagnostics');
    const target =
      (preferErrors ? list?.querySelector<HTMLElement>('.error button') : null) ??
      list?.querySelector<HTMLElement>('button');
    target?.scrollIntoView({ block: 'nearest' });
    target?.focus();
  }

  /** Resolves once no compile is in flight — at once when none is. */
  function compileSettled(): Promise<void> {
    return new Promise((resolve) => {
      let stop = () => {};
      stop = compiled.subscribe((current) => {
        if (current.status === 'compiling') return;
        resolve();
        // `subscribe` calls back before it returns, so `stop` may not be the
        // real unsubscriber yet.
        queueMicrotask(() => stop());
      });
    });
  }

  /**
   * Back to 100%. The button goes with the size it showed, so focus goes back
   * to the text — or, in Preview, where the text is hidden, to the mode switch
   * that says so.
   */
  async function resetDocumentScale(): Promise<void> {
    updateWorkspace({ documentScale: 1 });
    await tick();
    if (layout !== 'preview') editorRef?.focus();
    else {
      document
        .querySelector<HTMLElement>('[role="radiogroup"][aria-label="Editor mode"] [aria-checked="true"]')
        ?.focus();
    }
  }

  const trailingStatus = $derived<StatusBarItem[]>(
    (() => {
      const items: StatusBarItem[] = [];
      /*
       * Only the NORMAL save states appear here; `error` and `conflict` are in
       * the toolbar beside the title, because they need acting on and the
       * status bar is not where somebody looks for something to do.
       *
       * "Saved" only while it is still true. The store leaves `saved` in place
       * until its badge times out, and typing does not clear it, so for up to
       * two seconds the bar went on saying "Saved" over text that was not.
       *
       * Before the text size, not after: the group is right-aligned, so the
       * item that comes and goes sits on the inside and the one that stays put
       * keeps the edge.
       */
      if ($editor.saveState === 'saving') items.push({ key: 'save', label: 'Saving…' });
      else if ($editor.saveState === 'saved' && !$editor.dirty) {
        items.push({ key: 'save', label: 'Saved' });
      }
      if ($workspace.documentScale !== 1) {
        items.push({
          key: 'scale',
          label: `${Math.round($workspace.documentScale * 100)}%`,
          title: `Editor text size. Click for actual size (${formatAccelerator('Mod+0', mac)}).`,
          onclick: () => void resetDocumentScale(),
        });
      }
      return items;
    })(),
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
   * `saved` — and every Edit/Preview switch bought another. A pass is not
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

  /* ------------------------------------------------ CCUX-013 readiness */

  /*
   * Why the speech model cannot follow a voice take, kept current (#301).
   *
   * Followed for as long as the editor is open, not read once when the script
   * opens: an install that finished, failed, or was removed in Settings while a
   * script was open used to leave this answer exactly where it started. It is
   * the same store every launch path reads (`lib/check-then-start.ts`), so the
   * footer below and the sheet cannot disagree.
   *
   * Only a voice take needs a model; a manual take is never warned about one.
   */
  const voiceModelProblem = $derived(
    $settings.general.defaultSessionMode === 'voice'
      ? voiceModelFinding({
          modelInstalled: $speechModelReadiness.installed,
          modelSupported: $speechModelReadiness.supported,
          modelDamaged: $speechModelReadiness.damaged,
          modelInstalling: $speechModelReadiness.installing,
        })
      : null,
  );

  /**
   * Present, unless there is something the presenter has to know first.
   *
   * The immediate-launch rule is load-bearing: on a healthy familiar setup this
   * is exactly the old behaviour, one click, no sheet. Anything else and the
   * launch is held rather than cancelled — the shell's sheet keeps this exact
   * call, so its start button resumes precisely the take that was asked for,
   * not a default one. The check itself is shared with every other way of starting
   * a take; see `lib/check-then-start.ts`.
   */
  /*
   * A PRACTICE GOES THROUGH THE SAME READINESS CHECK, AND MUST.
   *
   * It is a voice take — the whole point is reading aloud and being followed —
   * so a missing model or an unplugged microphone breaks it in exactly the way
   * it breaks a take. Waving a rehearsal past the check would put somebody in
   * front of a script that never moves, which is the failure the check exists
   * to name before it happens rather than after.
   */
  async function checkThenPresent(
    mode?: PresentationMode,
    startTokenIndex?: number,
    practice?: boolean,
    part?: TakePartRequest,
  ): Promise<void> {
    // Captured: the held launch must start the script it was asked for, not
    // whatever `scriptId` names by the time somebody presses Start anyway.
    const id = scriptId;
    await checkThenStart(
      id,
      {
        ...(mode === undefined ? {} : { mode }),
        ...(practice ? { practice: true } : {}),
      },
      () => present(id, mode, startTokenIndex, practice, part),
    );
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
  async function present(
    id: string,
    mode?: PresentationMode,
    startTokenIndex?: number,
    practice?: boolean,
    part?: TakePartRequest,
  ): Promise<void> {
    await saveNow();
    await startTake(id, {
      // A practice forces its own window, so passing a mode alongside it would
      // be handing `startTake` a preference it is about to overrule anyway.
      ...(practice ? { practice: true } : mode === undefined ? {} : { presentationMode: mode }),
      ...(startTokenIndex === undefined ? {} : { startTokenIndex }),
      /*
       * §parts. A practice is deliberately never bounded to a part: nothing is
       * reported at the end of one, so "you reached the end of part three" and
       * "record part four next" would both be claims about a reading the app
       * has already decided not to report on.
       */
      ...(part === undefined || practice ? {} : { part }),
    });
  }

  /* ------------------------------------------------- CCUX-014 start points */

  /**
   * The token the caret is sitting on, snapped to a whole sentence.
   *
   * Derived from the SOURCE offset through the compiled sentence spans, which
   * carry `source.utf16Start/End` for exactly this. It is null while a compile
   * is in flight or the editor has no caret — the menu then simply does not
   * offer "From here", rather than offering it pointing at the top.
   */
  let caretOffset = $state(0);

  const snapInput = $derived({
    sentences: result?.sentences ?? [],
    outline: result?.outline ?? [],
    totalTokens: result?.spokenWordCount ?? 0,
    // So a start point is quoted as written, not in the aligner's lower case.
    blocks: result?.blocks ?? [],
  });

  const caretStartPoint = $derived.by(() => {
    const sentences = snapInput.sentences;
    if (sentences.length === 0) return null;
    // The last sentence whose source span begins at or before the caret. The
    // caret can legitimately sit in whitespace, a cue or a heading's markup,
    // so "the sentence containing it" is not always defined — "the one it is
    // at or after" always is, and matches how the snapping reads elsewhere.
    let best: (typeof sentences)[number] | null = null;
    for (const sentence of sentences) {
      if (sentence.source.utf16Start <= caretOffset) best = sentence;
      else break;
    }
    if (best === null) return null;
    return snapToStart(best.startTokenIndex, snapInput);
  });

  /**
   * Where the last take of this script stopped.
   *
   * Loaded once per script rather than kept live: it changes only when a take
   * ends, and a take ending navigates through this route anyway.
   */
  let lastEndTokenIndex = $state<number | undefined>(undefined);

  $effect(() => {
    const id = scriptId;
    /*
     * Re-read when a take ends, not only when the script opens.
     *
     * `stopSession` fire-and-forgets the row's ending index, and this route is
     * where a finished take lands — so a single read at mount could observe the
     * newest session before its ending was written and then offer an older
     * ending, or none, for the whole mount. Depending on the summary makes the
     * dialog's arrival the trigger.
     */
    void $session.summary;
    lastEndTokenIndex = undefined;
    void listSessionRecords(id, 20)
      .then((records) => {
        if (scriptId !== id) return;
        // Newest first is what Rust returns; the first one with an ending is
        // the one to resume from. A take abandoned before it recorded an end
        // has nothing to offer and is skipped rather than treated as zero.
        lastEndTokenIndex = records.find((r) => (r.endTokenIndex ?? 0) > 0)?.endTokenIndex;
      })
      .catch(() => {
        // A history that will not load costs one menu row. It must never stop
        // somebody presenting.
      });
  });

  const lastEndingPoint = $derived(continueFrom(lastEndTokenIndex, snapInput));

  const presentStartItems = $derived(
    startMenuItems(
      {
        hereTokenIndex: caretStartPoint?.tokenIndex ?? null,
        hereLabel: startPlace(caretStartPoint),
        /*
         * §parts: starting at the caret starts the part the caret is IN.
         *
         * Two reasons. The plainer one is that it is true — on a divided script
         * every token belongs to exactly one part, and a take opened in the
         * middle of part three is a take of part three, begun part way. The
         * sharper one is that the parts menu is capped: its overflow row tells
         * anybody with more than twelve parts to put the cursor in one and use
         * this row, and before this that advice was false. It started an
         * unbounded take, so the parts a creator reached late in a long project
         * were exactly the ones the feature stopped working for.
         */
        herePart: caretStartPoint === null ? null : partAt(parts, caretStartPoint.tokenIndex),
        lastEndingTokenIndex: lastEndingPoint?.tokenIndex ?? null,
        lastEndingLabel: startPlace(lastEndingPoint),
        parts,
      },
      (tokenIndex, part) => void checkThenPresent(undefined, tokenIndex, false, part),
    ),
  );

  /**
   * What a start row's description names: the sentence's opening words, or the
   * heading it opens on. The menu adds the part.
   */
  function startPlace(point: StartPoint | null): string | null {
    if (point === null) return null;
    return point.excerpt ?? point.label;
  }

  /** Mark the first row of a run as the start of a named menu group. */
  function withGroup(items: PresentMenuItem[], heading: string): PresentMenuItem[] {
    return items.map((item, index) => (index === 0 ? { ...item, group: { heading } } : item));
  }

  /*
   * Start rows first, then the two shapes.
   *
   * Order matters: where to start is the choice somebody is most often
   * reaching for — a section retake is the high-frequency action this menu
   * exists for — and the mode is usually already correct from last time.
   */
  const presentModeItems = $derived([
    ...withGroup(presentStartItems, 'Start'),
    ...withGroup(
      presentMenuItems($settings.stage.presentationMode, (mode) => void checkThenPresent(mode)),
      'Present as',
    ),
    /*
     * The third launch question, finally answered here.
     *
     * `present-menu.ts` has said since it was written that the three choices at
     * launch are where to start, how to display, and whether this is a take or
     * a rehearsal — and that the third was not covered. It sits below the two
     * shapes because it is a rarer choice than either, and it does not carry a
     * start row of its own: a practice opens at the beginning of the script.
     *
     * That is a real limit, not a composition. `SplitButton` runs the row it is
     * given the moment it is chosen and closes, so there is no gesture that
     * picks a start row AND this one — practising a single section is simply
     * not reachable from this menu today. It is recorded in the plan's "what is
     * not done" rather than papered over here, because the shape of the fix is
     * a design decision (a start row per shape, or a practice that opens at the
     * caret) and not a wiring one.
     */
    {
      label: PRACTICE_LABEL,
      description: 'A rehearsal in a window · nothing is reported',
      group: {},
      onselect: () => void checkThenPresent(undefined, undefined, true),
    },
    {
      label: 'Review take setup…',
      description: 'Speech model, microphone and display',
      onselect: () => {
        const id = scriptId;
        void checkThenStart(id, { requested: true }, () => present(id));
      },
    },
  ]);

  /*
   * WHERE PRESENT IS ACTUALLY GOING (CCUX-004).
   *
   * Kept current from the moment the editor mounts, because the readout is
   * worth nothing after the button is pressed — at that point the operator can
   * see the destination and can no longer choose a different one.
   */
  /*
   * ONE effect, not two.
   *
   * The first version had a `watchTakeDestination` effect and a separate
   * `refreshTakeDestination` effect, both reading the same settings — so a
   * settings change tore the watcher down, rebuilt it (which refreshes), and
   * then refreshed again. Two concurrent resolutions of the same question,
   * every time somebody touched Settings.
   *
   * `$effect` re-runs on any dependency it read, and reading the settings here
   * means a settings change already restarts the watcher, which already
   * refreshes. The returned teardown removes the listeners in between, so
   * nothing accumulates.
   */
  $effect(() =>
    watchTakeDestination({
      mode: $settings.stage.presentationMode,
      optical: $settings.optical,
      // Where a prompter take actually opens when that panel is connected
      // (#302) — read here so pinning another panel restarts the watcher too.
      pinnedFingerprint: $settings.stage.displayFingerprint,
      // Where a reading take actually opens: back at the frame the last one
      // was left at, when "Restore windows" is on. Read here for the same
      // reason — a take ending rewrites the frame, and toggling the setting
      // decides whether it counts, so either has to restart the watcher.
      readerFrame: $settings.stage.readerFrame,
      restoreWindows: $settings.general.restoreWindows,
    }),
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
      assetRevision += 1;
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
   * Bring the editing surface back when the caller came from Preview, without
   * destroying what the author has typed.
   *
   * Edit and Preview used to render a `MarkdownEditor` from different `{#if}`
   * branches. Svelte reconciles branches, not positions, so every switch
   * destroyed the component — and with it the `EditorView` that owns the undo
   * stack and the selection. Moving to Preview to read a paragraph as it will
   * be rendered, and moving back, silently threw away the history for the
   * whole session.
   *
   * There is now one instance for both modes and the panes are shown and
   * hidden with CSS, so this only has to bring the surface back into view:
   * `tick()` for the class change to land, `requestMeasure()` because a
   * CodeMirror that was `display: none` has stale geometry, and `focus()`
   * because WebKit can otherwise leave the caret un-blinking in a pane the
   * user just asked for.
   */
  async function ensureEditingSurface(): Promise<void> {
    if (layout !== 'preview') return;
    updateWorkspace({ editorLayout: 'edit' });
    await tick();
    withView((view) => {
      view.requestMeasure();
      view.focus();
    });
  }

  /**
   * The mode switch itself. Going back to a pane that was hidden needs the
   * same remeasure a Preview click does — nothing was unmounted, but a hidden
   * CodeMirror measured itself at zero.
   *
   * It remeasures and does NOT focus, which is the difference between this and
   * `ensureEditingSurface`. The mode control is a radiogroup: arrow keys move
   * the selection through it, so pulling focus into the editor on the way out
   * of Preview meant the next arrow key moved the caret instead of reaching
   * Edit, and the group could not be operated the way its role promises.
   * Focus belongs to the actions that ask for the editor by name — a preview
   * block, a lint finding.
   */
  function changeMode(mode: EditorLayout): void {
    updateWorkspace({ editorLayout: mode });
  }

  /*
   * ONE place that reacts to the layout and the text scale.
   *
   * CodeMirror measures itself against a box it can see, and caches the result.
   * Coming back from Preview it was `hidden` — so the cache is a zero-height one
   * and the first click lands in the wrong place. Changing the split ratio moves
   * its width. Changing the document scale changes its line height. All three
   * need a `requestMeasure`, and there are FIVE ways to reach them: the
   * segmented control, the View menu, ⌘1/⌘2/⌘3, the Find commands, and a
   * restored workspace on mount.
   *
   * Reacting to the state rather than fixing it up at each call site is what
   * makes them all correct — the View menu writes the workspace store directly
   * and would otherwise have skipped the remeasure entirely.
   */
  $effect(() => {
    const currentLayout = layout;
    const scale = $workspace.documentScale;
    const ratio = $workspace.editorSplitRatio;
    void scale;
    void ratio;
    if (currentLayout === 'preview') return;
    void tick().then(() => withView((view) => view.requestMeasure()));
  });

  /**
   * The split divider is driven in PIXELS and stored as a RATIO.
   *
   * `PaneDivider` moves its value by one unit per pixel of pointer travel —
   * that is the whole of its contract, and it is the right one for a rail whose
   * width is a number of pixels. A ratio handed to it directly would move by 1.0
   * per pixel, so the first twitch would slam the divider to its limit.
   *
   * So the divider is given the editor pane's real width, and the answer is
   * converted back on the way in. The stored value stays a fraction because that
   * is what survives a window resize: a split remembered as "620px" becomes a
   * different split on a laptop, whereas "half" is half everywhere.
   */
  let workWidth = $state(0);

  /**
   * Neither half of a split may be squeezed below this.
   *
   * The ratio limits alone are not enough at a small window. At the declared
   * 980×680 minimum, with the sidebar and the outline both dragged wide, the
   * work area can fall to a couple of hundred pixels — and a 25% share of that
   * is a fifty-pixel pane, which for the preview is less than its own padding.
   * An absolute floor bounds the ratio dynamically, so the split degrades to
   * "half and half" rather than to "one pane and a sliver".
   */
  const SPLIT_MIN_PANE_PX = 220;

  const splitPixels = $derived(Math.round($workspace.editorSplitRatio * workWidth));
  const splitMinPixels = $derived(
    Math.round(Math.max(PANE_LIMITS.editorSplit.min * workWidth, Math.min(SPLIT_MIN_PANE_PX, workWidth / 2))),
  );
  const splitMaxPixels = $derived(
    Math.round(
      Math.min(
        PANE_LIMITS.editorSplit.max * workWidth,
        Math.max(workWidth - SPLIT_MIN_PANE_PX, workWidth / 2),
      ),
    ),
  );

  function setSplitFromPixels(pixels: number): void {
    if (workWidth <= 0) return;
    // Bounded by the same pixel floor the divider is given, so a drag and a
    // keyboard resize cannot reach a geometry the other one refuses.
    const bounded = Math.min(splitMaxPixels, Math.max(splitMinPixels, pixels));
    updateWorkspace({ editorSplitRatio: bounded / workWidth });
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
         *
         * Always to the top, with a line of context above it: the nearest edge
         * left a sentence in the bottom third running off the page, and a run
         * already in view did not move at all. The mark (lib/lint-run.ts) is
         * what says which words the note meant.
         */
        effects: [
          EditorView.scrollIntoView(EditorSelection.range(end, anchor), { y: 'start', yMargin: 48 }),
          showLintRun.of({ from: anchor, to: end }),
        ],
      });
      view.focus();
    });
  }

  /* --- Outline rail ---------------------------------------------------- */

  /**
   * One row of the outline, in document order, with where its section starts
   * in the SOURCE.
   *
   * Source offsets, not token indexes, decide which section the caret is in:
   * a heading with nothing spoken under it starts at the same token as the
   * heading after it, so by tokens the two are the same place and the empty
   * one could never be current. The compiler's synthetic "Opening" (prose
   * before the first heading) has no block of its own and starts at the top.
   */
  interface OutlineEntry {
    node: OutlineNode;
    depth: number;
    start: number;
    seconds: number;
  }

  const outlineEntries = $derived.by(() => {
    const starts = new Map(blocks.map((b) => [b.id, b.source.utf16Start]));
    const flat: OutlineEntry[] = [];
    const walk = (nodes: OutlineNode[], depth: number): void => {
      for (const node of nodes) {
        // A section with one word in it is short, not empty: the estimate
        // rounds one word to zero seconds, and zero is reserved for a section
        // with nothing spoken in it at all.
        const words = sectionWords.get(node.id) ?? 0;
        flat.push({
          node,
          depth,
          start: node.blockId === '' ? 0 : (starts.get(node.blockId) ?? 0),
          seconds: words > 0 ? Math.max(1, estimateDurationSeconds(words, speakingRate)) : 0,
        });
        walk(node.children, depth + 1);
      }
    };
    walk(outline, 0);
    return flat;
  });
  const outlineEntryById = $derived(new Map(outlineEntries.map((e) => [e.node.id, e])));

  /*
   * Headings somebody actually wrote. A script without any compiles to one
   * synthetic "Script" node spanning everything, and the rail used to list it
   * as a row that went nowhere when clicked — under a heading that said
   * "Outline", in place of the sentence explaining how to get one.
   */
  const hasHeadings = $derived(outlineEntries.some((e) => e.node.blockId !== ''));

  /** The section the caret is in: the last one starting at or before it. */
  const caretSectionId = $derived.by(() => {
    let current: string | null = null;
    for (const entry of outlineEntries) {
      if (entry.start <= caretOffset) current = entry.node.id;
      else break;
    }
    return current;
  });

  /*
   * In Preview there is no caret to follow — the place you are is what you are
   * reading. So Preview reads its own scroll: the last heading at or above the
   * top of the pane. A jump the rail made sets the answer itself and holds it
   * for the two frames its own scroll event takes to arrive, so a short last
   * section that cannot reach the top is not immediately re-read as the one
   * above it.
   */
  let previewSectionId = $state<string | null>(null);
  let previewJumpPending = false;

  function readPreviewSection(): void {
    const scroller = previewScroller;
    if (!scroller || previewJumpPending) return;
    const edge = scroller.getBoundingClientRect().top + paddingTop(scroller) + 1;
    let current: string | null = outlineEntries[0]?.node.id ?? null;
    for (const entry of outlineEntries) {
      if (entry.node.blockId === '') continue;
      const heading = scroller.querySelector(`[data-block-id="${entry.node.blockId}"]`);
      if (!heading) continue;
      if (heading.getBoundingClientRect().top <= edge) current = entry.node.id;
      else break;
    }
    previewSectionId = current;
  }

  $effect(() => {
    const scroller = previewScroller;
    if (!scroller || layout !== 'preview') return;
    void outlineEntries;
    let frame = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readPreviewSection);
    };
    void tick().then(() => untrack(readPreviewSection));
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
    };
  });

  const currentSectionId = $derived(
    layout === 'preview' ? (previewSectionId ?? caretSectionId) : caretSectionId,
  );

  /*
   * The current row stays on screen in the rail. Only when it CHANGES, and
   * only as far as it has to (`nearest`): someone scrolling the rail to look
   * at the end of the script must not be dragged back while they read it.
   */
  let outlineScroller: HTMLElement | null = $state(null);
  $effect(() => {
    const id = currentSectionId;
    const scroller = outlineScroller;
    if (id === null || !scroller) return;
    void tick().then(() => revealOutlineRow(id));
  });

  /*
   * Where the rail last scrolled ITSELF to. A scroll event that arrives at this
   * position is the rail revealing a row, not somebody scrolling it — and only
   * somebody scrolling it closes the opened-out title (`outlinePeek`).
   */
  let railScrolledTo: number | null = null;

  /** Bring a row fully into the rail's view, as far as it has to move and no further. */
  function revealOutlineRow(id: string): HTMLElement | null {
    const scroller = outlineScroller;
    const row = scroller?.querySelector<HTMLElement>(`[data-outline-id="${id}"]`) ?? null;
    if (!scroller || !row) return row;
    const view = scroller.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.top < view.top) scroller.scrollTop -= view.top - box.top;
    else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom;
    // Recorded even when nothing moved here: Tab focus scrolls the row in by
    // itself before the focus handler runs, and its scroll event arrives
    // afterwards at exactly this position.
    railScrolledTo = scroller.scrollTop;
    return row;
  }

  function onRailScroll(): void {
    if (outlineScroller !== null && outlineScroller.scrollTop === railScrolledTo) return;
    railScrolledTo = null;
    outlinePeek = null;
  }

  function paddingTop(el: Element): number {
    return parseFloat(getComputedStyle(el).paddingTop) || 0;
  }

  /*
   * A heading the rail jumps to comes to rest where the first line of the
   * script sits when nothing is scrolled: at the pane's own top padding. That
   * is the one position a reader already knows means "the start of this".
   *
   * Instant, in every pane, rather than smooth. A smooth jump through four
   * minutes of script is motion nobody asked for (and it ignored reduced
   * motion outright), and it is a jump the rail would otherwise watch pass
   * through every heading on the way.
   */
  function revealInEditor(offset: number, focus: boolean): void {
    withView((view) => {
      const pos = Math.min(offset, view.state.doc.length);
      const reveal = () =>
        EditorView.scrollIntoView(pos, { y: 'start', yMargin: paddingTop(view.contentDOM) });
      view.dispatch({ selection: { anchor: pos }, effects: reveal() });
      if (focus) view.focus();
      /*
       * Twice, a frame apart. Wrapped lines off screen have ESTIMATED heights,
       * so the first scroll lands wherever the estimate says the heading is —
       * in a long script, a section or more short of it. By the next frame the
       * editor has drawn and measured the lines it scrolled to, and the second
       * scroll lands on the heading itself.
       */
      requestAnimationFrame(() => view.dispatch({ effects: reveal() }));
    });
  }

  function revealInPreview(entry: OutlineEntry): void {
    const scroller = previewScroller;
    if (!scroller) return;
    const heading =
      entry.node.blockId === ''
        ? null
        : scroller.querySelector<HTMLElement>(`[data-block-id="${entry.node.blockId}"]`);
    const top = heading
      ? heading.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        paddingTop(scroller)
      : 0;
    previewSectionId = entry.node.id;
    previewJumpPending = true;
    scroller.scrollTop = Math.max(0, top);
    requestAnimationFrame(() => requestAnimationFrame(() => (previewJumpPending = false)));
  }

  function outlineNavigate(entry: OutlineEntry): void {
    // In Preview the editor is hidden: its caret still moves, so going back to
    // Edit lands here too, but focus stays in the rail rather than vanishing
    // into a pane nobody can see.
    revealInEditor(entry.start, layout !== 'preview');
    if (layout !== 'edit') revealInPreview(entry);
  }

  /*
   * ONE tab stop, like every source list in the app (Sidebar.svelte, §23.1).
   *
   * Tab lands on the current section and the arrows walk the rest. Eighteen
   * headings as eighteen tab stops was eighteen presses to get past the rail
   * to the notes and the readiness line under it.
   */
  let outlineFocusId = $state<string | null>(null);
  const outlineTabStopId = $derived(
    outlineFocusId ?? currentSectionId ?? outlineEntries[0]?.node.id ?? null,
  );

  /*
   * Reveal FIRST, then focus without the browser's own scroll. Focus scrolled
   * an off-screen row into view by itself, and that scroll closed the
   * opened-out title the same focus had just opened — so the rows most likely
   * to need it, the ones arrowed onto past the bottom of the rail, never showed
   * it.
   */
  function focusOutlineRow(id: string): void {
    outlineFocusId = id;
    revealOutlineRow(id)?.focus({ preventScroll: true });
  }

  function outlineKeydown(event: KeyboardEvent, id: string): void {
    if (event.key === 'Escape' && outlinePeek !== null) {
      event.preventDefault();
      outlinePeek = null;
      return;
    }
    const ids = outlineEntries.map((e) => e.node.id);
    const index = ids.indexOf(id);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % ids.length;
        break;
      case 'ArrowUp':
        next = (index - 1 + ids.length) % ids.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = ids.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = ids[next];
    if (target !== undefined) focusOutlineRow(target);
  }

  /*
   * The full title, offered only when the row has cut it short — measured when
   * the pointer arrives, the way a Library row does it (ScriptRow.svelte).
   */
  let outlineTip = $state<{ id: string; text: string } | null>(null);

  function titleIsCut(row: HTMLElement): boolean {
    const title = row.querySelector<HTMLElement>('.outline-title');
    return title !== null && title.scrollHeight > title.clientHeight + 1;
  }

  function measureOutlineTitle(row: HTMLElement, node: OutlineNode): void {
    outlineTip = titleIsCut(row) ? { id: node.id, text: node.title } : null;
  }

  /*
   * …and the same title for somebody arriving by KEYBOARD, who gets no
   * tooltip. The focused row opens out in place to its full length, drawn over
   * the rows below it rather than pushing them down, so arrowing through the
   * rail never makes the list jump. Fixed-position, so the rail's scroll box
   * cannot clip it; it carries the row's focus edge, because it covers the row
   * that would otherwise show one. Escape, a scroll, or leaving the row closes
   * it. Pointer focus does not open it — the tooltip is the pointer's.
   */
  let outlinePeek = $state<{
    entry: OutlineEntry;
    top: number;
    left: number;
    width: number;
  } | null>(null);

  /*
   * Kept inside the window. The overlay grows DOWN from the row, so a long
   * title focused near the bottom of a short window would run off it; measured
   * once it has drawn, and lifted just far enough to fit. It moves, the list
   * does not.
   */
  let outlinePeekEl: HTMLElement | null = $state(null);
  let outlinePeekTop = $state<number | null>(null);

  $effect(() => {
    const peek = outlinePeek;
    const el = outlinePeekEl;
    if (!peek || !el) {
      outlinePeekTop = null;
      return;
    }
    const margin = 8;
    const overflow = peek.top + el.offsetHeight - (window.innerHeight - margin);
    outlinePeekTop = overflow > 0 ? Math.max(margin, peek.top - overflow) : peek.top;
  });

  function offerOutlinePeek(row: HTMLElement, entry: OutlineEntry): void {
    if (!row.matches(':focus-visible') || !titleIsCut(row)) {
      outlinePeek = null;
      return;
    }
    const box = row.getBoundingClientRect();
    outlinePeek = { entry, top: box.top, left: box.left, width: box.width };
  }

  /** What a row says to a screen reader: the whole title, then its length. */
  function outlineRowLabel(entry: OutlineEntry): string {
    const length = describeSectionTime(entry.seconds);
    const scope = entry.node.children.length > 0 && entry.seconds > 0 ? ', including subsections' : '';
    return `${entry.node.title || 'Untitled heading'}, ${length}${scope}`;
  }

  /** The time column's own tooltip. */
  function outlineTimeTip(entry: OutlineEntry): string {
    const length = describeSectionTime(entry.seconds);
    const sentence = length.charAt(0).toUpperCase() + length.slice(1);
    return entry.node.children.length > 0 && entry.seconds > 0
      ? `${sentence} to say, including subsections`
      : entry.seconds > 0
        ? `${sentence} to say`
        : 'Nothing spoken in this section';
  }

  /*
   * §parts and cues, in the rail's head rather than under the list.
   *
   * Under the list they scrolled away with it on exactly the scripts long
   * enough to have parts worth counting. Parts rather than the take-marker
   * count this replaced: a script with no markers still has parts, divided on
   * its headings, so it is the number that means something for every script.
   * Each count appears only when there is something to count — "0 cues" told
   * nobody anything.
   */
  const outlineCounts = $derived(
    [
      parts.length > 0 ? `${parts.length} ${parts.length === 1 ? 'part' : 'parts'}` : '',
      cueCount > 0 ? `${cueCount} ${cueCount === 1 ? 'cue' : 'cues'}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );

  /**
   * Preview click returns to Edit mode at the block's source (§13.2).
   *
   * It only switched modes before. `goToOffset` ran against an `editorRef` that
   * Preview had already unmounted, so the one thing the handler exists to do —
   * land the caret on the block you clicked — never happened in the one mode it
   * was written for.
   *
   * Two things on top of that. The caret goes to the WORD that was clicked,
   * when the click was on a spoken one: the compiler knows where every spoken
   * token sits in the source, and a long paragraph is one long source line, so
   * "the start of the block" left the author hunting along it. And the source
   * is scrolled so that line sits where the click was — beside it in Both, under
   * the pointer after Preview gives way to Edit. `scrollIntoView: true` used to
   * take the nearest edge, which put a lower paragraph on the pane's last row
   * with the rest of it out of sight.
   */
  async function previewBlockClick(block: CompiledBlock, at: PreviewBlockClick): Promise<void> {
    // Measured before the switch: in Preview the block is about to disappear.
    const targetTop = at.clientY ?? at.element.getBoundingClientRect().top;
    const token =
      at.tokenIndex === undefined ? undefined : result?.script?.spokenTokens[at.tokenIndex];
    const offset =
      token && token.index === at.tokenIndex && token.blockId === block.id
        ? token.source.utf16Start
        : block.source.utf16Start;
    await ensureEditingSurface();
    withView((view) => {
      const pos = Math.min(offset, view.state.doc.length);
      const pane = view.scrollDOM.getBoundingClientRect();
      // Where the click was, but never in the outer bands of the pane: the line
      // keeps some context above it and most of the pane below it.
      const wanted = targetTop - pane.top - (at.clientY === undefined ? 0 : view.defaultLineHeight / 2);
      const yMargin = Math.min(Math.max(wanted, pane.height * 0.15), pane.height * 0.6);
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin }),
      });
      view.focus();
      markLanding(view, pos);
    });
  }

  /** "Show in editor" on a problem in the preview: the caret at its source. */
  async function goToProblem(problem: CompileDiagnostic): Promise<void> {
    if (!problem.source) return;
    const start = problem.source.utf16Start;
    await ensureEditingSurface();
    withView((view) => {
      const pos = Math.min(start, view.state.doc.length);
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
      markLanding(view, pos);
    });
  }

  async function revealFolder(): Promise<void> {
    // Said out loud, as File › Reveal in Finder does: a menu command that
    // fails silently looks like a menu command that did nothing.
    try {
      await scriptsService.revealScriptFolder(scriptId);
    } catch (err) {
      showToast(`That script’s folder could not be opened. ${describeError(err)}`, 'danger');
    }
  }

  /* --- F.8 save-failure sheet ----------------------------------------- */

  /*
   * Every answer the sheet gives stays IN the sheet.
   *
   * Retry used to close it before the save had even started, so a second
   * failure looked exactly like the first one and the person had to reopen the
   * sheet to reach Copy all text — the one action that actually protects the
   * text while saving is broken. Copying answered with a toast at the bottom of
   * the window, and a reveal that failed answered with nothing at all.
   *
   * One line under the explanation reports all three, and it is a status
   * region, so a screen reader hears each result without focus moving. With
   * nothing to report it carries the standing advice instead.
   *
   * The three outcomes are kept apart and composed, not written over each
   * other: copying while a retry is in flight must not erase "Saving…", and a
   * retry that then fails must not tell somebody who has already copied their
   * text to go and copy it.
   */
  let saveRetry = $state<'idle' | 'saving' | 'failed'>('idle');
  /** Failed retries since the sheet opened, so a repeat failure reads as new. */
  let saveRetryFailures = $state(0);
  let saveCopy = $state<'idle' | 'copied' | 'failed'>('idle');
  let saveRevealFailure = $state<string | null>(null);
  /**
   * Which opening of the sheet an answer belongs to. A copy, reveal or save
   * that settles after the sheet was closed reports nothing, rather than
   * leaving a stale line for the next time it opens.
   */
  let saveSheetOpening = 0;
  let retryButton: HTMLButtonElement | null = $state(null);

  /** The platform's words for this action, as the Library and the File menu say it. */
  const revealLabel = osCopy().revealInFileManager;

  /**
   * A save is on the wire — this sheet's Retry, or an autosave that was already
   * scheduled when the sheet opened. Both read the same way here.
   */
  const saveInFlight = $derived(saveRetry === 'saving' || $editor.saveState === 'saving');

  const saveSheetStatus = $derived.by(() => {
    const parts: string[] = [];
    if (saveInFlight) parts.push('Saving your changes…');
    if (saveRetry === 'failed') {
      parts.push(
        `Still not saved after ${saveRetryFailures === 1 ? 'one more try' : `${saveRetryFailures} more tries`}.`,
      );
    }
    if (saveCopy === 'copied') {
      parts.push('Your text is copied. Paste it into another app and save it there.');
    } else if (saveCopy === 'failed') {
      parts.push(
        'Couldn’t copy to the clipboard. Close this message, then select the text in the editor and copy it.',
      );
    } else if (saveRetry === 'failed') {
      parts.push('Copy all text and paste it into another app to keep it safe.');
    }
    if (saveRevealFailure !== null) parts.push(saveRevealFailure);
    if (parts.length === 0) return null;
    const failed = saveRetry === 'failed' || saveCopy === 'failed' || saveRevealFailure !== null;
    const tone = failed ? 'danger' : saveInFlight ? 'progress' : 'success';
    return { tone, text: parts.join(' ') };
  });

  /*
   * Escape and the scrim always work, even mid-save: a save that never answers
   * must not hold the person away from their script. The save carries on, and
   * the toolbar reports how it ends.
   *
   * Focus then goes to the editor when the toolbar control that opened the
   * sheet has gone — it is hidden while a save is in flight and after one
   * lands — because the dialog has nothing else to hand it back to.
   */
  function closeSaveIssue(): void {
    saveIssueOpen = false;
    saveSheetOpening += 1;
    saveRetry = 'idle';
    saveRetryFailures = 0;
    saveCopy = 'idle';
    saveRevealFailure = null;
    void tick().then(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) editorRef?.focus();
    });
  }

  /*
   * The sheet follows the store, not only its own Retry.
   *
   * An autosave scheduled by typing just before the sheet opened can land
   * underneath it, and then the sheet went on saying "Your changes aren't
   * saved" over a document that was — with its cause line gone, because a
   * save that works clears `lastError`. A save this sheet's Retry started is
   * left to `retrySave`, which reports its own outcome.
   */
  $effect(() => {
    if (!saveIssueOpen || saveRetry === 'saving') return;
    const outcome = $editor.saveState;
    if (outcome === 'conflict') {
      untrack(() => {
        closeSaveIssue();
        conflictOpen = true;
      });
      return;
    }
    if ((outcome === 'saved' || outcome === 'idle') && !editorHasUnsavedWork()) {
      untrack(() => {
        closeSaveIssue();
        showToast('Your changes are saved.', 'success');
      });
    }
  });

  /**
   * Save again, and report the result where it was asked for.
   *
   * `saveNow()` RESOLVES when the save fails — the failure is store state — so
   * the outcome is read from the store afterwards rather than inferred from the
   * promise. The sheet closes only on a save that landed.
   *
   * Retry is disabled while it runs, as the conflict sheet's arms are. Disabling
   * the focused button drops focus, so a failed retry puts it back.
   */
  async function retrySave(): Promise<void> {
    if (saveRetry === 'saving') return;
    const opening = saveSheetOpening;
    const savingScript = $editor.scriptId;
    saveRetry = 'saving';
    await saveNow();
    const outcome = $editor.saveState;
    /*
     * "Saved" only when it is true of everything on screen. A save can land
     * while newer typing is still unsaved (the sheet was dismissed mid-save and
     * the author carried on), and `saveState` says `saved` for it all the same.
     */
    const allSaved = $editor.scriptId === savingScript && !editorHasUnsavedWork();
    if (opening !== saveSheetOpening) {
      if (allSaved) showToast('Your changes are saved.', 'success');
      return;
    }
    if (outcome === 'error') {
      saveRetryFailures += 1;
      saveRetry = 'failed';
      await tick();
      const active = document.activeElement;
      if (active === null || active === document.body) retryButton?.focus();
      return;
    }
    closeSaveIssue();
    // The file changed on disk in the meantime: that question has its own sheet.
    if (outcome === 'conflict') {
      conflictOpen = true;
      return;
    }
    if (allSaved) showToast('Your changes are saved.', 'success');
  }

  async function copyAllText(): Promise<void> {
    const opening = saveSheetOpening;
    let copied = true;
    try {
      await navigator.clipboard.writeText($editor.source);
    } catch {
      copied = false;
    }
    if (opening === saveSheetOpening) saveCopy = copied ? 'copied' : 'failed';
  }

  async function revealFromSaveSheet(): Promise<void> {
    const opening = saveSheetOpening;
    saveRevealFailure = null;
    try {
      await scriptsService.revealScriptFolder(scriptId);
    } catch (err) {
      if (opening !== saveSheetOpening) return;
      const failed = osCopy().revealScriptFailed;
      const why = describeError(err);
      // A missing file is usually why the save failed too, and the sheet already says so.
      saveRevealFailure = why === $editor.lastError ? failed : `${failed} ${why}`;
    }
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
   *
   * The failure is reported INSIDE the sheet, beside the choice it belongs to.
   * It used to be a danger toast at the foot of the window: outside a modal the
   * keyboard cannot leave, and — danger toasts never expire — still up after a
   * retry had succeeded, contradicting the success beneath it.
   *
   * `reviewed` is the disk text the sheet showed. An arm refuses a file that
   * has changed since, and the sheet reads it again so the next choice is made
   * against what is really there.
   */
  async function resolveConflict(arm: ConflictArm, reviewed: string): Promise<void> {
    if (conflictArm !== null) return;
    conflictArm = arm;
    conflictFailure = null;
    // Read before the await: a successful arm replaces the title with the
    // disk one, and the toast has to name the copy that was actually made.
    const copyName = conflictCopyName;
    try {
      if (arm === 'disk') {
        const outcome = await useDiskVersion({ source: reviewed });
        conflictOpen = false;
        reportDiskVersion(outcome, copyName);
      } else {
        const kept = scriptId;
        await keepEditorVersion({ source: reviewed });
        conflictOpen = false;
        showToast('Kept your edits. The disk version is in this script’s revision history.', 'success', {
          key: CONFLICT_TOAST,
          durationMs: 0,
          action: { label: 'Open revision history', run: () => void openRevisionHistory(kept) },
        });
      }
      // The toolbar notice that opened the sheet went with the conflict, so the
      // Dialog has nothing to hand focus back to. The author was writing.
      await tick();
      editorRef?.focus();
    } catch (err) {
      conflictFailure =
        err instanceof DiskChangedAgainError
          ? {
              tone: 'warning',
              title: 'The file changed again while you were choosing.',
              detail: 'Nothing was changed. Check the comparison again before you choose.',
            }
          : {
              tone: 'danger',
              title:
                arm === 'disk'
                  ? 'Couldn’t save a copy of your edits, so nothing was changed.'
                  : 'Couldn’t save your edits, so nothing was changed.',
              detail: `Your text is still open here. ${describeError(err)}`,
            };
      if (err instanceof DiskChangedAgainError) conflictReread += 1;
    } finally {
      conflictArm = null;
    }
  }

  /** One receipt per resolution: a second conflict replaces the first's. */
  const CONFLICT_TOAST = 'script-conflict';

  /**
   * Say where the editor's text went, with the way to it.
   *
   * The receipts stay until dismissed: they carry the only one-step route to
   * the version that was not kept, and a link that times out is one the author
   * then has to go looking for.
   */
  function reportDiskVersion(outcome: ConflictOutcome, copyName: string): void {
    if (!outcome.copied) {
      showToast('Saving has resumed. The file already matched your edits.', 'success', {
        key: CONFLICT_TOAST,
      });
      return;
    }
    const copyId = outcome.copyId;
    showToast(`Loaded the disk version. Your edits are in the Library as “${copyName}”.`, 'success', {
      key: CONFLICT_TOAST,
      durationMs: 0,
      ...(copyId === undefined
        ? {}
        : { action: { label: 'Open copy', run: () => void navigate({ name: 'editor', scriptId: copyId }) } }),
    });
  }

  const conflictCopyName = $derived(conflictCopyTitle($editor.title));

  /**
   * Escape and the scrim are refused while an arm is in flight.
   *
   * Dismissing mid-operation is what let a slow resolution finish against a
   * script the user had already left, and it would also drop the only sheet
   * offering the choice at the moment it is most needed.
   */
  /**
   * Open a script's Revision history from a receipt that may outlive this editor.
   *
   * The receipt stays until dismissed, so by the time it is pressed the author
   * may be in another script or out of the editor altogether. The request names
   * the script; the editor showing it answers below, once it has finished
   * opening — this one if it still is, or the one the navigation brings up.
   */
  async function openRevisionHistory(id: string): Promise<void> {
    revisionHistoryRequest.set(id);
    const here = currentRoute();
    if (here.name === 'editor' && here.scriptId === id) return;
    if (!(await navigate({ name: 'editor', scriptId: id }))) revisionHistoryRequest.set(null);
  }

  $effect(() => {
    if (opening || $revisionHistoryRequest !== scriptId) return;
    revisionHistoryRequest.set(null);
    revisionsOpen = true;
  });

  function closeConflict(): void {
    if (conflictArm !== null) return;
    conflictOpen = false;
    // A failure belongs to the attempt it reports; reopening starts afresh.
    conflictFailure = null;
  }

  async function trashFromEditor(): Promise<void> {
    const accepted = await requestConfirm({
      // The words File › Move to Trash and the Library row use. "Delete
      // script?" over a button that says Move to Trash asked whether this was
      // permanent at the one moment the answer has to be unambiguous.
      title: 'Move to Trash?',
      body: `“${$editor.title}” will move to Trash and can be restored for 30 days.`,
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (!accepted) return;
    // Leave the document only if it actually moved. The store reports the
    // failure itself; navigating away regardless would add a second wrong thing
    // on top of the first — the script still here, and the author no longer in
    // it. That is what the mutator's boolean is for.
    if (!(await moveScriptToTrash(scriptId, { saveEditsFirst: true }))) return;
    await navigate({ name: 'library', view: 'all' });
  }

  /**
   * Open the revision browser (spec §21.4). The pending autosave is flushed
   * first for two reasons: the compare-and-swap needs the revision the editor
   * actually holds, and the text about to be replaced should be on disk (and
   * therefore snapshottable) before a restore replaces it.
   */
  async function openRevisions(): Promise<void> {
    try {
      await flushEditorEdits(scriptId);
      revisionsOpen = true;
    } catch (err) {
      showToast(`Could not open revision history. ${describeError(err)}`, 'danger');
    }
  }

  async function afterRestore(): Promise<void> {
    revisionsOpen = false;
    focusEditorWhenOpen = true;
    await beginOpen(scriptId);
    showToast('Revision restored. Your previous text was saved as a revision.', 'success');
  }

  /*
   * The Script actions menu, in the File menu's order and words (§18.3).
   *
   * Three short groups: what makes or recovers a version of this script, what
   * takes it out of the app, and — on its own, last, below a rule — the one
   * command that removes it. Trash used to sit flush under the folder command,
   * so overshooting a 32px row from the most ordinary item in the menu armed
   * the destructive one. The names come from `scriptActionLabels`, which the
   * Library's row menus use too.
   */
  const actionLabels = scriptActionLabels();
  // Typed, as the Library's `rowMenuItems` is: left to inference, the handlers'
  // return types were circular through the derived list and came out `any`.
  const overflowItems = $derived<ContextMenuItem[]>([
    // Through the store, not the service: the store is where a duplicate that
    // fails gets said out loud, and it reloads the library either way. Calling
    // the service directly from here had no catch and no notice at all.
    {
      label: actionLabels.duplicate,
      shortcut: accel('Mod+D'),
      onselect: () => void duplicateScript(scriptId),
    },
    { label: actionLabels.revisionHistory, onselect: () => void openRevisions() },
    {
      label: actionLabels.exportMarkdown,
      separated: true,
      onselect: () => void exportScriptToFile(scriptId, $editor.title, 'markdown'),
    },
    { label: actionLabels.reveal, onselect: () => void revealFolder() },
    {
      label: actionLabels.moveToTrash,
      danger: true,
      separated: true,
      onselect: () => void trashFromEditor(),
    },
  ]);

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
    // Re-read on layout changes: the toolbar is not rendered in Preview.
    void layout;
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    const active = Math.min(toolbarIndex, buttons.length - 1);
    buttons.forEach((button, i) => {
      button.tabIndex = i === active ? 0 : -1;
    });
  });

  function onToolbarKeydown(event: KeyboardEvent): void {
    /*
     * Escape goes back to the text without inserting anything, and shows the
     * caret where it was left. Without it the only way back from the row was
     * Tab, which stops at Syntax reference on the way. The most local thing
     * answers the key, so nothing behind the editor sees it.
     */
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      withView((view) => {
        view.focus();
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) });
      });
      return;
    }
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

  /** A button reached any other way becomes the group's tab stop. */
  function onToolbarFocusIn(event: FocusEvent): void {
    const index = toolbarButtons().indexOf(event.target as HTMLButtonElement);
    if (index >= 0) toolbarIndex = index;
  }

  /*
   * The pointer never takes focus out of the text.
   *
   * Every insert hands focus back to the editor anyway, but a press that
   * landed between two buttons — on a divider, in a gap — focused the toolbar
   * itself and left it there, so the next keystroke went nowhere. Refusing the
   * focus change on press keeps the caret where the writer left it whatever
   * the pointer hits, and the click still runs. Because focus no longer moves
   * on a click, the clicked button is made the group's tab stop here rather
   * than in `focusin`.
   */
  function onToolbarMousedown(event: MouseEvent): void {
    if (event.button === 0) event.preventDefault();
  }

  function onToolbarClick(event: MouseEvent): void {
    const button = (event.target as Element | null)?.closest('button');
    const index = button ? toolbarButtons().indexOf(button) : -1;
    if (index >= 0) toolbarIndex = index;
  }
</script>

<!--
  One level of the outline, and the levels under it.

  Three voices for four-plus levels: a top-level section in semibold, the level
  under it in regular weight, and anything deeper in the secondary grey. The
  indent says how deep; the voice says which rows are the script's big pieces,
  without anybody having to trace left edges down the rail.
-->
{#snippet outlineBranch(nodes: OutlineNode[], depth: number)}
  <!-- `role="list"` is not redundant: WebKit drops list semantics from a
       `<ul>` whose markers are styled away (see Welcome.svelte). -->
  <ul class="outline" class:nested={depth > 0} role="list">
    {#each nodes as node (node.id)}
      {@const entry = outlineEntryById.get(node.id)}
      {#if entry}
        {@const current = currentSectionId === node.id}
        <li class="outline-node" class:part={depth === 0} class:branch={node.children.length > 0}>
          <button
            type="button"
            class="outline-item level-{Math.min(depth, 2)}"
            class:current
            data-outline-id={node.id}
            aria-current={current ? 'location' : undefined}
            aria-label={outlineRowLabel(entry)}
            title={outlineTip?.id === node.id ? outlineTip.text : undefined}
            tabindex={outlineTabStopId === node.id ? 0 : -1}
            style="padding-left: {10 + depth * 14}px"
            onclick={() => outlineNavigate(entry)}
            onkeydown={(event) => outlineKeydown(event, node.id)}
            onfocus={(event) => {
              outlineFocusId = node.id;
              revealOutlineRow(node.id);
              offerOutlinePeek(event.currentTarget, entry);
            }}
            onblur={() => {
              if (outlinePeek?.entry.node.id === node.id) outlinePeek = null;
            }}
            onpointerenter={(event) => measureOutlineTitle(event.currentTarget, node)}
          >
            <span class="outline-title" class:untitled={node.title === ''}>
              {node.title || 'Untitled heading'}
            </span>
            <span class="outline-time" class:zero={entry.seconds <= 0} title={outlineTimeTip(entry)}>
              {formatSectionTime(entry.seconds)}
            </span>
          </button>
          {#if node.children.length > 0}
            {@render outlineBranch(node.children, depth + 1)}
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
{/snippet}

<div class="page">
  {#if opening}
    <!--
      One panel over the whole route, not a line inside the work area.
      The header and the toolbar used to assemble on their own schedule around
      that line, so the pieces arrived one at a time; covering all of them means
      the editor appears once, complete.
    -->
    <div class="opening" role="status">
      <p class="opening-message">Opening script…</p>
    </div>
  {:else}
    <Toolbar
      title={$editor.title || 'Untitled script'}
      backLabel="Library"
      onback={() => goBack()}
      editableTitle
      bind:titleElement={titleInput}
      ontitlechange={(t) => void setTitle(t)}
      showSecondary={layout !== 'preview'}
    >
      {#snippet status()}
        <!--
          Only EXCEPTIONAL save state is in the toolbar now.
          §11.2 and §11.7: "Saved" is transient and belongs in the status bar,
          where it can appear and go without moving anything; a failed save and a
          conflict are things the operator has to act on, so they stay here, next
          to the document's name, with an icon as well as a colour (§9.4).
        -->
        {#if $editor.saveState === 'error'}
          <button type="button" class="save-issue danger" onclick={() => (saveIssueOpen = true)}>
            <Icon name="alert" size={14} />
            <span>{saveLabel}</span>
          </button>
        {:else if $editor.saveState === 'conflict'}
          <button type="button" class="save-issue warning" onclick={() => (conflictOpen = true)}>
            <Icon name="alert" size={14} />
            <span>{saveLabel}</span>
          </button>
        {/if}
      {/snippet}
      {#snippet actions()}
        <SegmentedControl
          label="Editor mode"
          options={[
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
            { value: 'split', label: 'Both' },
          ]}
          value={layout}
          onchange={(mode) => void changeMode(mode as EditorLayout)}
        />
        <!-- A panel glyph, not `doc`: `doc` is "All scripts" in the sidebar a
             few hundred pixels away, so the toggle read as a document command. -->
        <IconButton
          icon="panel-right"
          label={$workspace.outlineVisible ? 'Hide outline' : 'Show outline'}
          active={$workspace.outlineVisible}
          onclick={() => updateWorkspace({ outlineVisible: !$workspace.outlineVisible })}
        />
        <OverflowMenu items={overflowItems} label="Script actions" />
        <!--
          THE DESTINATION, BESIDE THE BUTTON THAT USES IT (CCUX-004).

          Settings' prompter-display section names the panel used for calibration,
          preview and display tests. Single-window presentation fills whichever
          monitor THIS window is on. Both are correct and they are not the same
          panel, so a user could calibrate one, press Present from the other and
          get behaviour that follows the architecture while contradicting the
          interface.

          IN A ROW, NOT A STACK. It was a two-line column, and a column inside a
          fixed-height toolbar does three ugly things at once: `align-items:
          stretch` widened the button to the caption's width, the button rose to
          the top of the row, and the caption hung off the bottom. One line to
          the left of the button keeps the toolbar a toolbar and lets Present be
          the size of its own label.

          The one line is a GLANCE. The explanation and the remedy live in the
          readiness sheet, which lists a destination mismatch as a finding with
          a way to act on it — a toolbar is the wrong place to argue a case.
        -->
        <div class="present-group">
          {#if $takeDestination}
            {@const destination = $takeDestination}
            <p
              class="present-destination"
              class:mismatch={destination.mismatch !== null}
              title={destination.mismatch?.detail ?? destination.summary}
            >
              <!--
                One live region for the pair, so a screen reader is told the
                destination and its caveat as one fact rather than two, and gets
                the WHOLE mismatch — what is different and what to do. A sighted
                user is invited to hover by the colour change; nobody else is.
                `polite`, because this changes when a window is dragged and must
                never interrupt.
              -->
              <span class="sr-only" role="status" aria-live="polite">
                {destinationAnnouncement(destination)}
              </span>
              <span class="present-destination-text" aria-hidden="true">
                {destination.summary}
              </span>
            </p>
          {/if}
          <SplitButton
            variant="primary"
            label={$takeStarting ? 'Opening stage…' : 'Present'}
            menuLabel="How to present"
            disabled={$takeStarting}
            items={presentModeItems}
            onclick={() => void checkThenPresent()}
          />
        </div>
      {/snippet}
      {#snippet secondary()}
        {#if layout !== 'preview'}
          <!--
            GROUPED, per §11.4: text structure, then inline formatting, then
            media, then the teleprompter's own semantics. They used to be one
            undifferentiated run of nine controls, so "insert a cue" sat beside
            "bold" with nothing to say they are different kinds of thing.

            ONE KIND OF CONTROL. Heading, Bold and Italic were typeset letters
            in private 28px buttons beside 32px IconButtons, so the row had two
            sizes, two focus treatments and a press only half of it showed, and
            the italic I read as a slash. They are drawn marks from the icon
            set now, and every member is a compact IconButton — the 28px tier,
            which is what leaves the 36px row room to draw a whole focus ring.

            Heading must not wear a chevron, which means "go forward"
            everywhere else in the product.

            "Insert cue" gives up `flag` to the part break. The compiler models
            part breaks as navigation targets — a flag is exactly that — and a
            cue is an aside to the presenter, drawn as a note.

            The tooltips carry what the icon cannot: the key that does the same
            thing, and for the two teleprompter inserts, what they are.
          -->
          <div
            class="insert-toolbar"
            role="toolbar"
            tabindex="-1"
            aria-label="Insert"
            aria-orientation="horizontal"
            bind:this={toolbarEl}
            onkeydown={onToolbarKeydown}
            onfocusin={onToolbarFocusIn}
            onmousedown={onToolbarMousedown}
            onclick={onToolbarClick}
          >
            <IconButton compact size={16} icon="heading" label="Cycle heading level" title="Cycle heading level (H1 to H6, then plain text)" onclick={() => withView(inserts.cycleHeading)} />
            <span class="toolbar-rule" aria-hidden="true"></span>
            <IconButton compact size={16} icon="bold" label="Bold" title={`Bold (${accel('Mod+B')})`} onclick={() => withView(inserts.insertBold)} />
            <IconButton compact size={16} icon="italic" label="Italic" title={`Italic (${accel('Mod+I')})`} onclick={() => withView(inserts.insertItalic)} />
            <IconButton compact size={16} icon="link" label="Insert link" title={`Insert link (${accel('Mod+K')})`} onclick={() => withView(inserts.insertLink)} />
            <span class="toolbar-rule" aria-hidden="true"></span>
            <IconButton compact size={16} icon="image" label="Insert image" title="Insert image…" onclick={() => void insertImage()} />
            <IconButton compact size={16} icon="diagram" label="Insert diagram block" title="Insert diagram block (Mermaid)" onclick={() => withView(inserts.insertDiagram)} />
            <span class="toolbar-rule" aria-hidden="true"></span>
            <IconButton compact size={16} icon="cue" label="Insert cue" title="Insert cue (a direction to you, never read aloud)" onclick={() => withView(inserts.insertCue)} />
            <IconButton compact size={16} icon="flag" label="Insert part break" title="Insert part break (starts a new named part)" onclick={() => withView(inserts.insertTakeMarker)} />
          </div>
          <!--
            The syntax reference, beside the controls that insert two of the
            constructs it explains (#305). Outside the toolbar group rather than
            its last member: the group is named "Insert", and this inserts
            nothing.
          -->
          <span class="secondary-spacer" aria-hidden="true"></span>
          <Button
            size="sm"
            variant="ghost"
            title="Script syntax reference"
            disabled={$takeStarting}
            onclick={openSyntaxReference}
          >
            <Icon name="book-open" size={14} />
            Syntax reference
          </Button>
        {/if}
      {/snippet}
    </Toolbar>

    <div class="body">
      <div class="work">
        <!--
          ONE editor and ONE preview for both modes, shown and hidden with
          CSS. Rendering them from separate `{#if}` branches per mode is what
          destroyed the CodeMirror instance — and the undo history with it — on
          every Edit/Preview switch.
        -->
        <div
          class="panes"
          class:split={layout === 'split'}
          style="--doc-scale: {$workspace.documentScale}"
          bind:clientWidth={workWidth}
        >
          <div
            class="editor-pane"
            hidden={layout === 'preview'}
            style={layout === 'split' ? `flex: 0 0 ${$workspace.editorSplitRatio * 100}%` : undefined}
          >
            <MarkdownEditor
              bind:this={editorRef}
              value={$editor.source}
              placeholder="Start writing, paste a script, or import Markdown…"
              onchange={setSource}
              onselectionchange={(offset) => (caretOffset = offset)}
            />
          </div>
          {#if layout === 'split'}
            <!--
              The split divider works in FRACTIONS, not pixels, so the ratio
              survives a window resize. Its min/max come from `PANE_LIMITS`,
              which stops either half being dragged to nothing — a zero-width
              editor is a mode with no way back out of it.
            -->
            <PaneDivider
              orientation="vertical"
              side="leading"
              label="Editor and preview split"
              pane="Editor"
              valuetext={(pixels) => {
                const share = workWidth > 0 ? Math.round((pixels / workWidth) * 100) : 50;
                return `Editor ${share}%, preview ${100 - share}%`;
              }}
              value={splitPixels}
              min={splitMinPixels}
              max={splitMaxPixels}
              defaultValue={Math.round(PANE_LIMITS.editorSplit.default * workWidth)}
              onresize={setSplitFromPixels}
            />
          {/if}
          <div class="preview" hidden={layout === 'edit'} bind:this={previewScroller}>
            <!-- Mounted for the life of the pane, so the failure is a CHANGE to
                 a live region a screen reader is already watching — a region
                 inserted together with its message can go unannounced. -->
            <p class="sr-only" role="status">
              {compileFailed ? 'This script could not be rendered. Your text is safe in the editor.' : ''}
            </p>
            {#if compileFailed}
              <!--
                What happened, that nothing is lost, and two ways on (NN/g): try
                the compile again — a compiler that died is started afresh — or,
                from Preview, go back to the text. Beside the source the editor is
                already on screen, so the narrow pane takes the compact message.
              -->
              <div class="preview-state" class:compact={layout === 'split'}>
                <EmptyState
                  variant={layout === 'split' ? 'compact' : 'plain'}
                  title="This script could not be rendered"
                  body="Your text is safe in the editor. The preview tries again each time you change the script."
                  detail={previewFailureDetail || undefined}
                >
                  {#snippet actions()}
                    <Button size="sm" onclick={retryCompile}>Try again</Button>
                    {#if layout === 'preview'}
                      <Button size="sm" onclick={() => void ensureEditingSurface()}>Edit the script</Button>
                    {/if}
                  {/snippet}
                </EmptyState>
              </div>
            {:else if blocks.length > 0}
              <RenderBlocks
                {blocks}
                images={previewImages}
                problems={previewProblems}
                onblockclick={(b, at) => void previewBlockClick(b, at)}
                onproblemclick={(p) => void goToProblem(p)}
              />
            {:else}
              <div class="preview-state" class:compact={layout === 'split'}>
                {#if layout === 'split'}
                  <EmptyState
                    variant="compact"
                    title="Nothing to preview yet"
                    body="Your script appears here as you write it."
                  />
                {:else}
                  <EmptyState
                    title="Nothing to preview yet"
                    body="Write your script in Edit, and it appears here the way it will read."
                  >
                    {#snippet actions()}
                      <Button size="sm" onclick={() => void ensureEditingSurface()}>Start writing</Button>
                    {/snippet}
                  </EmptyState>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      </div>

      {#if $workspace.outlineVisible}
        <!--
          A real divider, and a width that is remembered.
          The rail was `flex: 0 0 264px` with no way to change it — §11.5 asks
          for a draggable 220-420px range that persists, because how wide an
          outline wants to be depends entirely on the script in it.
        -->
        <PaneDivider
          orientation="vertical"
          side="trailing"
          label="Outline width"
          pane="Outline"
          value={$workspace.outlineWidth}
          min={PANE_LIMITS.editorOutline.min}
          max={PANE_LIMITS.editorOutline.max}
          defaultValue={PANE_LIMITS.editorOutline.default}
          onresize={(w) => setPaneWidth('editorOutline', w)}
        />
        <aside class="panel" aria-label="Outline" style="width: {$workspace.outlineWidth}px">
          <div class="panel-head">
            <p class="panel-title">Outline</p>
            {#if hasHeadings && outlineCounts !== ''}
              <p class="panel-count">{outlineCounts}</p>
            {/if}
          </div>

          <div class="panel-body" bind:this={outlineScroller} onscroll={onRailScroll}>
            {#if hasHeadings}
              <!--
                Nested lists, so the structure a sighted reader gets from the
                indents is the structure a screen reader is told: "list, 3
                items" inside the part they belong to. The indent lives inside
                each full-width button, so the space left of a deep row is still
                that row's to click.
              -->
              <nav
                class="outline-nav"
                aria-label="Sections"
                onfocusout={(event) => {
                  const next = event.relatedTarget;
                  if (!(next instanceof Node) || !event.currentTarget.contains(next)) outlineFocusId = null;
                }}
              >
                {@render outlineBranch(outline, 0)}
              </nav>
            {:else if result && !compileFailed}
              <div class="outline-empty">
                <p class="outline-empty-title">No headings yet</p>
                <p class="outline-empty-hint">
                  Start a line with <kbd>#</kbd> and a space to add a section.
                </p>
              </div>
            {/if}
          </div>

          {#if outlinePeek}
            {@const peek = outlinePeek}
            <div
              class="outline-peek level-{Math.min(peek.entry.depth, 2)}"
              class:current={currentSectionId === peek.entry.node.id}
              aria-hidden="true"
              bind:this={outlinePeekEl}
              style="top: {outlinePeekTop ?? peek.top}px; left: {peek.left}px; width: {peek.width}px; padding-left: {10 +
                peek.entry.depth * 14}px"
            >
              <span class="outline-peek-title">{peek.entry.node.title}</span>
              <span class="outline-time">{formatSectionTime(peek.entry.seconds)}</span>
            </div>
          {/if}

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
            {:else if $compiled.status === 'ready' && wordCount === 0 && diagnostics.length === 0}
              <!-- A clean compile of nothing is not a script ready to present:
                   the green tick beside "0 words" taught that the line checks
                   syntax rather than whether there is anything to say. Neutral,
                   because an empty page is a start, not a fault. -->
              <span class="foot-line neutral">No spoken text yet.</span>
            {:else if $compiled.status === 'ready' && blockingCount === 0 && diagnostics.length === 0}
              <!-- A clean compile is the SCRIPT's half of "ready". It said
                   "Ready to present." on its own, on a machine with no speech
                   model, beside a sheet saying the take could not follow
                   anybody's voice (#301). -->
              <span class="foot-line good">
                <Icon name="check" size={14} />
                {voiceModelProblem === null ? 'Ready to present.' : 'The script is ready.'}
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
            <!-- The model's half, whatever the compile says: neither implies
                 the other, and a script with notes in it is no more likely to
                 be followed. Worded by the same finding the sheet shows. -->
            {#if voiceModelProblem}
              {@const action = voiceModelProblem.action}
              <p class="diagnostic warning voice-model">
                <Icon name="alert" size={13} />
                <span>
                  {voiceModelProblem.detail}
                  {#if action?.settingsSection}
                    {@const section = action.settingsSection}
                    <button
                      type="button"
                      class="diagnostic-text"
                      onclick={() => void openSettingsWindow(section)}
                    >
                      {action.label}
                    </button>
                  {/if}
                </span>
              </p>
            {/if}
          </div>
        </aside>
      {/if}
    </div>

    <!--
      The document's state, always visible, even with the outline closed (§11.7).
      That is the point of a status bar: the compile state and the issue count
      used to live only in the rail's footer, so closing the rail — which is what
      somebody does to concentrate — also silenced the one place that said
      whether the script would render.
    -->
    <StatusBar items={statusItems} trailing={trailingStatus} />
  {/if}
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

<!--
  F.8 save-failure sheet.

  It answers the person's first question before it explains anything: the text
  is still here, and what would lose it. Focus opens on that answer rather than
  on a button (the house rule for a status sheet), so a screen reader starts
  with it and Return cannot fire an action nobody chose. The cause is the
  authored copy from `describeError`, set as prose: it is a sentence for a
  person, not a log line.
-->
<Dialog open={saveIssueOpen} title="Your changes aren’t saved" onclose={closeSaveIssue}>
  <div class="save-verdict" tabindex="-1" data-autofocus>
    <p class="save-verdict-title">Your text is still open in this window.</p>
    <p class="save-verdict-next">
      Press Esc or click outside this message to go back to it. Until your latest changes are saved,
      they exist only in this window, so quitting CandidCue or a crash could lose them.
    </p>
  </div>
  {#if $editor.lastError}
    <p class="save-cause">{$editor.lastError}</p>
  {/if}
  <p class="save-status {saveSheetStatus?.tone ?? 'advice'}" role="status" aria-atomic="true">
    <span class="save-status-mark" aria-hidden="true">
      <Icon
        name={saveSheetStatus === null
          ? 'info'
          : saveSheetStatus.tone === 'success'
            ? 'check'
            : saveSheetStatus.tone === 'danger'
              ? 'alert'
              : 'refresh'}
        size={14}
      />
    </span>
    <span>{saveSheetStatus?.text ?? 'If Retry keeps failing, copy all text and paste it into another app.'}</span>
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => void revealFromSaveSheet()}>{revealLabel}</Button>
    <Button onclick={() => void copyAllText()}>Copy all text</Button>
    <!--
      Both labels are laid out and only one is visible, so the button is as wide
      as the longer one in both states and the row does not jump left while the
      save is in flight. `visibility: hidden` also keeps the idle one out of the
      accessible name.
    -->
    <Button
      variant="primary"
      disabled={saveInFlight}
      bind:element={retryButton}
      onclick={() => void retrySave()}
    >
      <span class="retry-label" class:busy={saveInFlight}>
        <span class="idle">Retry</span>
        <span class="pending">Saving…</span>
      </span>
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

  The sheet itself — the comparison, its states and its footer — is
  ScriptConflictSheet; the arms stay here, beside the toasts and navigation
  that report them.
-->
<ScriptConflictSheet
  open={conflictOpen}
  {scriptId}
  title={$editor.title}
  source={$editor.source}
  copyName={conflictCopyName}
  busy={conflictArm}
  failure={conflictFailure}
  reread={conflictReread}
  onusedisk={(reviewed) => void resolveConflict('disk', reviewed)}
  onkeep={(reviewed) => void resolveConflict('keep', reviewed)}
  onclose={closeConflict}
/>

<style>
  .page {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /*
   * The save issue, beside the title.
   *
   * A quiet inline control with an icon and a word — not a `StatusPill`.
   * §9.4: pills are for short categorical states where the shape helps
   * scanning, and a single always-in-the-same-place status is not that. It also
   * has to keep the toolbar's height stable, which a pill's padding does not.
   */
  .save-issue {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: var(--toolbar-control-h);
    padding: 0 var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    font-size: var(--text-xs);
    font-weight: 600;
    white-space: nowrap;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .save-issue.danger {
    color: var(--danger);
  }
  .save-issue.danger:hover {
    background: var(--danger-soft);
  }
  .save-issue.warning {
    color: var(--warning);
  }
  .save-issue.warning:hover {
    background: var(--warning-soft);
  }

  /*
   * The insert toolbar lives in the `Toolbar`'s secondary row now, so it brings
   * no band of its own — no background, no border, no page inset. Those belong
   * to the row that hosts it, which is what keeps the two rows reading as one
   * piece of chrome rather than two stacked strips.
   *
   * NOT `overflow: hidden`. A focus ring paints 4px outside its button, and
   * clipping here cut every ring down to a pair of brackets (and the last
   * button's to one). The host row clips sideways only, so a ring at the
   * row's height is drawn whole.
   *
   * Pulled out by --space-1, as the title bar's back control is, so the first
   * mark sits under the back chevron rather than on an edge of its own.
   */
  .insert-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    margin-inline-start: calc(-1 * var(--space-1));
  }
  .insert-toolbar:focus {
    outline: none;
  }
  .secondary-spacer {
    flex: 1 1 auto;
  }
  .toolbar-rule {
    width: 1px;
    height: 16px;
    flex: 0 0 auto;
    background: var(--divider);
    margin: 0 var(--space-2);
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

  /*
   * Full-bleed and borderless on purpose: this is the route standing in for
   * itself for a moment, not a card floating over it. It fills the same box the
   * header and body will, so the cut to the loaded editor moves nothing.
   */
  .opening {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: var(--space-6) var(--page-x);
    background: var(--bg-panel);
  }

  .opening-message {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
  }

  .panes {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    min-width: 0;
  }
  /* The panes are hidden rather than unmounted, so the editor keeps its undo
     history across mode switches. `display` is set on both below, which
     beats the UA's `[hidden]` rule — so it has to be restated here or a
     "hidden" pane stays on screen. */
  .panes > [hidden] {
    display: none;
  }
  .editor-pane {
    display: flex;
    flex-direction: column;
    /*
     * The pane SHRINKS, and `min-width: 0` is what lets it.
     *
     * It was `flex-shrink: 0`. With no inline basis (Edit and Preview modes)
     * the basis is `auto` — the pane's max-content width, which CodeMirror
     * reports as the full 70ch measure plus its insets — so on any window too
     * narrow for that the pane kept its measure and ran under the outline
     * rail instead of wrapping: 661px of editor in a 470px slot, the script's
     * lines painting over "Outline" and the readiness line. Split mode never
     * saw it because its inline `flex: 0 0 N%` overrides all of this, and the
     * `PANE_LIMITS` floor on that fraction is what keeps the editor from being
     * dragged to nothing there.
     */
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    /*
     * View › Larger/Smaller Editor Text (§11.3).
     *
     * A `font-size` on the pane rather than a `zoom` or a `transform`: those
     * scale the whole box, including CodeMirror's own measurement of it, and
     * the caret ends up in the wrong place. `--doc-scale` is set on `.panes` and
     * `cm-theme.ts` sizes the content in `em`, so the type grows and the layout
     * stays honest.
     *
     * DELIBERATELY NOT the stage's font size. The View menu says "Editor Text"
     * for exactly this reason — the glass is sized from a measured viewing
     * distance, and a menu item that quietly changed it would undo a
     * calibration somebody took with a tape measure.
     */
    font-size: calc(1em * var(--doc-scale, 1));
  }

  /* Only ever on screen in Preview, where it is the sole pane — so the
     centred column that used to be conditional is simply what it is. */
  .preview {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    /* The reading inset, not the dense one: rendered script is the one surface
       on this route that is genuinely reading material (§9.1). */
    padding: var(--space-6) var(--page-x-wide);
    font-size: calc(1em * var(--doc-scale, 1));
    background: var(--bg-panel);
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  /* Beside the source, the preview takes the source's own inset. Each half of
     a split is a narrow column already, and the reading inset spent 64px of a
     ~380px pane on margin — and set the two texts at different distances from
     the divider they are being compared across. */
  .panes.split .preview {
    padding-inline: var(--page-x);
  }
  /*
   * The blank and failed states: the house `EmptyState`, in the reading
   * column. Beside the source it is the compact one, pulled out to the pane's
   * own inset so its first line sits level with the source's first line and its
   * text on the column edge the document's text uses, rather than inset by the
   * message's padding on top of the pane's.
   */
  .preview-state {
    width: 100%;
    max-width: var(--prose-measure);
  }
  .preview-state.compact {
    /* Stretched rather than centred: the pane centres its column, and a centred
       box splits a negative margin evenly between its two sides. */
    align-self: stretch;
    width: auto;
    margin: calc(-1 * var(--space-5)) calc(-1 * var(--space-4)) 0;
  }

  /* Outline / vocabulary rail — warm chrome, seam on the left via border on
     the container (a straight panel edge, not a rounded box). */
  .panel {
    /* The width is an inline style now, from the persisted pane size — the
       divider beside it is what changes it (§11.5). `flex: 0 0 auto` so the
       inline width is what decides, rather than being a basis flex can override. */
    flex: 0 0 auto;
    /* A flex item's automatic minimum is its CONTENT's minimum, and a heading
       row was `white-space: nowrap` — so one long headline made the rail's
       min-content width the width of that headline and the basis above stopped
       meaning anything. The rail grew to ~750px and took the editor's column
       with it. Rows clamp to two lines now; this is still what lets them. */
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-chrome);
    /* No border: the `PaneDivider` beside it draws the line, and two would be a
       two-pixel rule with a seam down the middle. */
  }
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
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
  .panel-count {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-meta);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
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
    gap: 1px;
  }
  .outline.nested {
    margin-top: 1px;
  }
  /* A little air around each top-level section that has sections of its own,
     so the script reads as its parts before it reads as its rows. Only around
     branches: a script of flat headings stays one even column. */
  .outline-node.part.branch + .outline-node.part,
  .outline-node.part + .outline-node.part.branch {
    margin-top: var(--space-2);
  }

  /* The house source-list row (Sidebar.svelte): 30px, a 5px radius, primary
     text, a neutral hover — with two lines allowed for the title. One line cut
     a deep heading in a narrow rail down to "Fallback i…", which named
     nothing; two lines let almost every real heading be read without a hover,
     and the few longer ones still end in an ellipsis with the full title on
     hover. The left padding is inline: 10px plus 14px per level. */
  .outline-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    min-height: var(--source-row-h);
    padding-block: 6px;
    padding-right: 10px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    text-align: left;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .outline-item.level-0 {
    font-weight: 600;
  }
  .outline-item.level-1 {
    font-weight: 400;
  }
  .outline-item.level-2 {
    font-weight: 400;
    color: var(--text-secondary);
  }
  .outline-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  /*
   * Where the caret is (or, in Preview, what is at the top of the pane): the
   * neutral fill and 600 text every source list uses for "you are here". No
   * bar and no clay — see Sidebar.svelte for why.
   *
   * The time goes to primary too. On this fill the faint grey measures 4.25:1,
   * under the floor the rest of the column clears.
   */
  .outline-item.current,
  .outline-item.current:hover {
    background: var(--bg-source-selected);
    color: var(--text-primary);
    font-weight: 600;
  }
  .outline-title {
    flex: 1 1 auto;
    min-width: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .outline-title.untitled {
    font-style: italic;
    color: var(--text-muted);
  }
  .outline-time {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .outline-item.current .outline-time {
    color: var(--text-primary);
  }

  /* The focused row, opened out to its full title (see `offerOutlinePeek`).
     The row's own type and padding, so it reads as that row grown rather than
     as a tooltip; the floating surface and shadow say it sits over the rows
     beneath. */
  .outline-peek {
    position: fixed;
    z-index: 20;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding-block: 6px;
    padding-right: 10px;
    border-radius: 5px;
    background: var(--bg-elevated);
    box-shadow: var(--shadow-pop);
    outline: 2px solid var(--focus-quiet);
    outline-offset: -2px;
    color: var(--text-primary);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    pointer-events: none;
  }
  .outline-peek.level-0,
  .outline-peek.current {
    font-weight: 600;
  }
  .outline-peek.level-2:not(.current) {
    color: var(--text-secondary);
  }
  .outline-peek-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* No headings yet: what the rail is for, and the one keystroke that starts
     it. Plain text on the rail's edge — there is nothing here to click. */
  .outline-empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-1) var(--rail-pill-inset, 10px) 0;
  }
  /* Primary and regular weight: in the label's own grey and weight it read as
     a second "Outline" heading rather than as what the rail has to say. */
  .outline-empty-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
  }
  .outline-empty-hint {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .outline-empty-hint kbd {
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    font-weight: 600;
    color: var(--text-primary);
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
  .voice-model {
    margin: 0;
  }
  .voice-model:not(:first-child) {
    margin-top: var(--space-2);
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

  /*
   * The save-failure sheet has classes of its own: `.dialog-body` and
   * `.dialog-detail` also dress the conflict sheet.
   *
   * The verdict is set like the take-readiness verdict — a 15px line that
   * answers, then the 13px line that qualifies it — and unframed, as the
   * session summary's outcome is: the dialog is the only box.
   */
  .save-verdict {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* A reading position, not a control: it takes focus only so a screen reader
     and the next Tab start from it. */
  .save-verdict:focus {
    outline: none;
  }
  .save-verdict-title {
    margin: 0;
    font-size: var(--text-base);
    line-height: 21px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .save-verdict-next,
  .save-cause {
    margin: 0;
    color: var(--text-secondary);
    text-wrap: pretty;
  }

  .save-status {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    column-gap: var(--space-2);
    align-items: start;
    margin: 0;
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .save-status-mark {
    display: grid;
    place-items: center;
    height: var(--lh-label);
  }
  .save-status.success,
  .save-status.danger {
    font-weight: 600;
  }
  .save-status.success {
    color: var(--success);
  }
  .save-status.danger {
    color: var(--danger);
  }

  .retry-label {
    display: inline-grid;
  }
  .retry-label > span {
    grid-area: 1 / 1;
    text-align: center;
  }
  .retry-label .pending,
  .retry-label.busy .idle {
    visibility: hidden;
  }
  .retry-label.busy .pending {
    visibility: visible;
  }

  /*
   * The Present destination line (CCUX-004).
   *
   * Stacked under the button rather than inside it: the button's label is the
   * ACTION and must stay one short word, while this is a statement of fact that
   * can run to a panel name. `--text-2xs` keeps it subordinate — it is there to
   * be checked, not read every time.
   */
  .present-group {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  /*
   * One quiet line, right-aligned into the button.
   *
   * `--text-2xs` and muted, because it is there to be CHECKED rather than read
   * on every glance — the moment it matters is the moment before somebody
   * presses Present, and at that moment they look for it.
   */
  .present-destination {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: 1.3;
    color: var(--text-muted);
    text-align: right;
    /* Wide enough for "Teleprompter · Built-in Retina Display" without an
       ellipsis on a normal window; the media query below drops it entirely
       rather than letting it shrink to a stub. */
    max-width: 34ch;
    min-width: 0;
  }
  .present-destination-text {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /*
   * A mismatch is INFORMATION, not an error — presenting where the window is,
   * is a deliberate supported behaviour — so it warms rather than alarms.
   * `--accent-strong` because small terracotta text needs it to clear AA.
   */
  .present-destination.mismatch {
    color: var(--accent-strong);
  }

  /* Announced but not drawn. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /*
   * The destination is the first thing to go when the toolbar runs out of room.
   *
   * §21.3: collapse optional things before compressing the core. Present is the
   * core; a line naming the panel is a convenience, and a squeezed one that
   * shows "Telepr…" is worse than none — it looks like a fault rather than a
   * readout. The readiness sheet still carries it at any width.
   *
   * Not even the shape alone, which was tried: at the 980px minimum "Reading
   * window" costs the script title 35px, and the toolbar's actions never give
   * up room (Toolbar.svelte), so a sixteen-character title was clipped
   * mid-word. Inside the Present menu the tick and "same as clicking Present"
   * answer the question at every width.
   */
  @media (max-width: 1100px) {
    .present-destination {
      display: none;
    }
  }
</style>
