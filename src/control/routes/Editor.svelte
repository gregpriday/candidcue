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
  import Icon from '../components/Icon.svelte';
  import IconButton from '../components/IconButton.svelte';
  import MarkdownEditor from '../components/MarkdownEditor.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
import SplitButton from '../components/SplitButton.svelte';
  import PaneDivider from '../components/PaneDivider.svelte';
  import StatusBar from '../components/StatusBar.svelte';
  import Toolbar from '../components/Toolbar.svelte';
  import type { StatusBarItem } from '../components/status-bar-item';
  import { formatAccelerator } from '../lib/commands';
  import { setDropTargetScript } from '../services/desktop-shell';
  import { detectPlatform } from '../lib/platform';
  import {
    PANE_LIMITS,
    setPaneWidth,
    updateWorkspace,
    workspace,
    type EditorLayout,
  } from '../stores/workspace';
  import RenderBlocks from '../components/RenderBlocks.svelte';
  import RevisionHistory from '../components/RevisionHistory.svelte';
  import ScriptLintPanel from '../components/ScriptLintPanel.svelte';
  import SegmentedControl from '../components/SegmentedControl.svelte';
  import { exportScriptToFile } from '../lib/app-actions';
  import { presentMenuItems, type PresentMenuItem } from '../lib/present-menu';
  import { PRACTICE_LABEL } from '../../shared/take-vocabulary';
import { startTake, takeStarting, type TakePartRequest } from '../lib/start-take';
  import { destinationAnnouncement } from '../lib/take-destination';
  import { startMenuItems } from '../lib/present-menu';
  import { checkThenStart } from '../lib/check-then-start';
  import { voiceModelFinding } from '../lib/take-readiness';
  import { openSettingsWindow } from '../lib/open-settings';
  import { speechModelReadiness } from '../stores/speech-model-readiness';
  import { continueFrom, describeStartPoint, snapToStart } from '../lib/take-start-point';
  import { partAt } from '../../shared/markdown/parts';
  import { listSessionRecords } from '../services/session-records';
  import { session } from '../stores/session';
  import { takeDestination, watchTakeDestination } from '../stores/destination';
  import { openSyntaxReference } from '../stores/syntax-reference';
import type { PresentationMode } from '../services/settings-types';
  import { isCompileSettledForScript, isEditorOpening } from '../lib/editor-readiness';
  import { estimateDurationSeconds, formatSpeakingDuration } from '../lib/format';
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
  import { lintScriptSource, type ScriptLintFinding } from '../lib/script-lint';
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
    editor,
    editorHasUnsavedWork,
    flushEditorEdits,
    keepEditorVersion,
    openScript,
    saveNow,
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
  let conflictResolving = $state(false);
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
      if (compileFailed) {
        items.push({
          key: 'compile',
          label: 'Could not render',
          icon: 'alert',
          tone: 'danger',
          title: compileErrorDetail ?? undefined,
        });
      } else if ($compiled.status === 'compiling') {
        items.push({ key: 'compile', label: 'Reading the script…' });
      } else if ($compiled.status === 'ready') {
        items.push({
          key: 'words',
          label: `${wordCount.toLocaleString()} ${wordCount === 1 ? 'word' : 'words'}`,
        });
        items.push({ key: 'duration', label: formatSpeakingDuration(durationSeconds) });
        if (cueCount > 0) {
          items.push({ key: 'cues', label: `${cueCount} ${cueCount === 1 ? 'cue' : 'cues'}` });
        }
      }
      if (diagnostics.length > 0) {
        const errors = diagnostics.filter((d) => d.severity === 'error').length;
        items.push({
          key: 'issues',
          label:
            errors > 0
              ? `${errors} ${errors === 1 ? 'issue' : 'issues'}`
              : `${diagnostics.length} ${diagnostics.length === 1 ? 'note' : 'notes'}`,
          icon: errors > 0 ? 'alert' : 'info',
          tone: errors > 0 ? 'danger' : 'warning',
          // Clicking opens the panel that lists them, which is a meaningful
          // destination — so, and only so, this one is a button (§11.7).
          onclick: () => updateWorkspace({ outlineVisible: true }),
        });
      }
      return items;
    })(),
  );

  const trailingStatus = $derived<StatusBarItem[]>(
    (() => {
      const items: StatusBarItem[] = [];
      if ($workspace.documentScale !== 1) {
        items.push({
          key: 'scale',
          label: `${Math.round($workspace.documentScale * 100)}%`,
          title: 'Editor text size',
        });
      }
      /*
       * Only the NORMAL save states appear here; `error` and `conflict` are in
       * the toolbar beside the title, because they need acting on and the
       * status bar is not where somebody looks for something to do.
       */
      if ($editor.saveState === 'saving') items.push({ key: 'save', label: 'Saving…' });
      else if ($editor.saveState === 'saved') items.push({ key: 'save', label: 'Saved' });
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
        hereLabel: caretStartPoint === null ? null : describeStartPoint(caretStartPoint),
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
        lastEndingLabel: lastEndingPoint === null ? null : lastEndingPoint.label,
        parts,
      },
      (tokenIndex, part) => void checkThenPresent(undefined, tokenIndex, false, part),
    ),
  );

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
      description: 'Read it through in a window, following your voice. Nothing is reported.',
      group: {},
      onselect: () => void checkThenPresent(undefined, undefined, true),
    },
    {
      label: 'Review take setup…',
      description: 'Check the model, microphone and display before opening the stage.',
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
   * was written for.
   */
  async function previewBlockClick(block: CompiledBlock): Promise<void> {
    await ensureEditingSurface();
    goToOffset(block.source.utf16Start);
  }

  /** A section's length at the rate the whole script was estimated at. */
  function sectionDuration(node: OutlineNode): string {
    return formatSpeakingDuration(
      estimateDurationSeconds(sectionWords.get(node.id) ?? 0, speakingRate),
    );
  }

  function flattenOutline(nodes: OutlineNode[], depth = 0): Array<{ node: OutlineNode; depth: number }> {
    const flat: Array<{ node: OutlineNode; depth: number }> = [];
    for (const node of nodes) {
      flat.push({ node, depth });
      flat.push(...flattenOutline(node.children, depth + 1));
    }
    return flat;
  }

  async function revealFolder(): Promise<void> {
    await scriptsService.revealScriptFolder(scriptId);
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
  const revealLabel = mac ? 'Reveal in Finder' : 'Show in File Explorer';

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
      const failed = mac ? 'Couldn’t reveal this script in Finder.' : 'Couldn’t show this script in File Explorer.';
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

            Heading is a typographic glyph rather than an icon, like Bold and
            Italic beside it: the icon set has no heading mark. It wore a
            chevron, which means "go forward" everywhere else in the product.

            "Insert cue" gives up `flag` to the part break. The compiler models
            part breaks as navigation targets — a flag is exactly that — and a
            cue is an aside to the presenter.
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
          >
            <button type="button" class="glyph" aria-label="Cycle heading level" title="Cycle heading level" onclick={() => withView(inserts.cycleHeading)}><strong>H</strong></button>
            <span class="toolbar-rule" aria-hidden="true"></span>
            <button type="button" class="glyph" aria-label="Bold" title={`Bold (${accel('Mod+B')})`} onclick={() => withView(inserts.insertBold)}><strong>B</strong></button>
            <button type="button" class="glyph" aria-label="Italic" title={`Italic (${accel('Mod+I')})`} onclick={() => withView(inserts.insertItalic)}><em>I</em></button>
            <IconButton icon="link" label="Insert link" onclick={() => withView(inserts.insertLink)} />
            <span class="toolbar-rule" aria-hidden="true"></span>
            <IconButton icon="image" label="Insert image" onclick={() => void insertImage()} />
            <IconButton icon="diagram" label="Insert diagram block" onclick={() => withView(inserts.insertDiagram)} />
            <span class="toolbar-rule" aria-hidden="true"></span>
            <IconButton icon="info" label="Insert cue" onclick={() => withView(inserts.insertCue)} />
            <IconButton icon="flag" label="Insert part break" onclick={() => withView(inserts.insertTakeMarker)} />
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
              <RenderBlocks
                {blocks}
                images={previewImages}
                onblockclick={(b) => void previewBlockClick(b)}
              />
            {:else}
              <p class="preview-empty">Your rendered script will appear here.</p>
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
                  <!--
                    Parts rather than the take-marker count this replaced. They
                    are not the same number — a script with no markers still has
                    parts, divided on its headings — and of the two it is the one
                    that means something for every script. Two counts describing
                    the same authored marks, in two vocabularies, was the worse
                    half of the pair.
                  -->
                  {#if parts.length > 0}
                    · {parts.length}
                    {parts.length === 1 ? 'part' : 'parts'}
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
   */
  .insert-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow: hidden;
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
  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-h);
    height: var(--toolbar-control-h);
    flex: 0 0 auto;
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
    /* The width is an inline style now, from the persisted pane size — the
       divider beside it is what changes it (§11.5). `flex: 0 0 auto` so the
       inline width is what decides, rather than being a basis flex can override. */
    flex: 0 0 auto;
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
    /* No border: the `PaneDivider` beside it draws the line, and two would be a
       two-pixel rule with a seam down the middle. */
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
   */
  @media (max-width: 1100px) {
    .present-destination {
      display: none;
    }
  }
</style>
