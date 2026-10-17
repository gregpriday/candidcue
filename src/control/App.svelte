<!--
  Control window shell (spec §10, §45.1): store-based route machine, library
  sidebar while browsing/editing, Editor → Live in one press (there is no
  screen between them — see lib/start-take.ts), workspace theme at rest and
  studio theme during Live.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import Button from './components/Button.svelte';
  import ConfirmHost from './components/ConfirmHost.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import SessionSummary from './components/SessionSummary.svelte';
  import ShortcutsDialog from './components/ShortcutsDialog.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import ToastRegion from './components/ToastRegion.svelte';
  import Editor from './routes/Editor.svelte';
  import Library from './routes/Library.svelte';
  import Live from './routes/Live.svelte';
  import Recovery from './routes/Recovery.svelte';
  import Welcome from './routes/Welcome.svelte';
  import { createAndOpenScript, exportScriptToFile, importMarkdown } from './lib/app-actions';
  import { isSettingsSection, type CommandActions, type CommandContext } from './lib/commands';
  import { openSettingsWindow } from './lib/open-settings';
  import { takeStarting } from './lib/start-take';
  import {
    checkThenStartTake,
    dismissTakeReadiness,
    startAnyway,
    takeReadinessPrompt,
  } from './lib/check-then-start';
  import { speechModelReadiness } from './stores/speech-model-readiness';
  import TakeReadinessSheet from './components/TakeReadinessSheet.svelte';
  import {
    dispatchDroppedImages,
    dispatchInsert,
    dispatchRouteCommand,
  } from './stores/command-bus';
  import {
    closeControlWindow,
    composeWindowTitle,
    installDragDrop,
    focusAppWindow,
    installMenuCommands,
    installMenuStateOnFocus,
    openPreferences,
    openThirdPartyNotices,
    openWebDestination,
    type DragHoverPayload,
    type DragImportedPayload,
    pushMenuState,
    pushWindowTitle,
    revealLogs,
  } from './services/desktop-shell';
  import {
    stepDocumentScale,
    flushWorkspace,
    updateWorkspace,
    workspace,
    type EditorLayout,
  } from './stores/workspace';
  import {
    editorNavigationDecision,
    initialRouteForBoot,
    isFatalBootCode,
    recentScriptIdForBoot,
    sessionEndConfirmation,
  } from './lib/app-lifecycle';
import { rememberReaderFrame } from './lib/reader-frame';
  import { emitShortcut, installShortcuts, onShortcut } from './lib/shortcuts';
  import { initAudioTrace } from './services/audio-trace';
  import { exportSupportBundle } from './services/diagnostics';
  import { describeError, errorCode } from './services/errors';
  import { isTauriRuntime } from './services/ipc';
  import {
    getBootStatus,
    getStartupFindings,
    writeUnsavedRecovery,
    type BootStatusReport,
  } from './services/recovery';
  import { installShutdownHandshake } from './services/shutdown';
  import {
    emitSettingsSection,
    installOverlaySync,
    installSettingsSync,
  } from './services/settings-sync';
  import { SETTINGS_OVERLAY_KEY } from './services/settings';
  import { listScripts } from './services/scripts';
  import { defaultAppSettings } from './services/settings-types';
  import { initAppStatus } from './stores/app-status';
  import { pendingConfirm, requestConfirm } from './stores/confirm';
  import { editor, editorHasUnsavedWork, saveNow } from './stores/editor';
  import {
    duplicateScript,
    library,
    loadLibrary,
    moveScriptToTrash,
  } from './stores/library';
  import * as scriptsService from './services/scripts';
  import { awaitViewportSettled, exitPresentation, painted } from './services/control-window';
  import { canvasIsBlack, coverIsUp, presentingPhase, setPresentingPhase } from './stores/presenting';
  import {
    navigate,
    registerNavigationGuard,
    route,
    setInitialRoute,
    type SettingsSection,
  } from './stores/router';
  import {
    awaitPendingPersistence,
    clearSession,
    identifyStageDisplays,
    installLiveSettingsFollow,
    liveMirrorX,
    session,
    stopSession,
  } from './stores/session';
  import { loadSettings } from './stores/settings';
  import { showToast } from './stores/toasts';

  let ready = $state(false);
  let shortcutsOpen = $state(false);
  /**
   * Files are over the window right now (§20.2).
   *
   * Null when nothing is being dragged. Carries the count Rust would accept, so
   * the overlay can say "not this kind of file" rather than inviting a drop that
   * will be refused — §10.5's rule that an unsupported file gets a concise
   * rejection instead of silence, applied a moment EARLIER than the drop.
   */
  let dragHover = $state<DragHoverPayload | null>(null);

  /*
   * Why boot has a failure state at all.
   *
   * `ready` is a two-value flag with three outcomes: still starting, started,
   * and never going to start. Without the third, a rejection anywhere in the
   * boot sequence left `ready` false forever and the wordmark on screen — an app
   * that looks like it is still loading, indefinitely, with force-quit the only
   * way out. The splash and the failure share the `.boot` block deliberately:
   * this has to render before anything else exists, so it cannot depend on a
   * route, a store that failed to load, or a component further down the shell.
   */
  let bootFailure = $state<string | null>(null);
  /**
   * Set when Rust reports the database did not come up.
   *
   * Distinct from `bootFailure`, which is "something threw during boot". This
   * one is a specific, actionable state with its own screen: the application
   * must not open, and recovery must.
   */
  let recoveryStatus = $state<BootStatusReport | null>(null);
  let bootExporting = $state(false);
  let bootExportNote = $state<string | null>(null);

  /*
   * The dark studio theme belongs to a RUNNING take, not to the Live route.
   *
   * Deriving it from the route alone meant the app stayed dark after the take
   * ended: Escape stops the session without navigating, the F.17 summary opens
   * on the still-current live route, and the workspace theme only returned once
   * the operator dismissed the summary and something navigated away. It read as
   * the app being slow to come back, when in fact it had not been asked to.
   *
   * The theme exists to keep the screen out of a presenter's eyes while they
   * are presenting. The moment the take is over that reason is gone, so the
   * summary is read on the workspace theme, like every other thing anyone reads.
   */
  const theme = $derived($route.name === 'live' && $session.active ? 'studio' : 'workspace');
  /*
   * The two screens this window still has.
   *
   * Settings and Calibration moved to the Preferences window (§14.1), so the
   * old note about calibration keeping the sidebar has moved with them —
   * that window has no sidebar at all, and its own Done control is the way out.
   * Only a take hides the rail here, and it does so because a presenter is
   * reading.
   */
  const showSidebar = $derived($route.name === 'library' || $route.name === 'editor');

  /**
   * What the main region is, for the landmark's accessible name (§23.2).
   *
   * Named rather than left anonymous because this window has several regions —
   * a navigation rail, a toolbar, an inspector, a status bar — and "main" on its
   * own tells a screen-reader user which of them they have jumped to only by
   * elimination. It follows the route, so the answer is always the thing on
   * screen rather than a fixed word chosen once.
   */
  const mainLandmarkLabel = $derived(
    (() => {
      switch ($route.name) {
        case 'editor':
          return $editor.title ? `Script: ${$editor.title}` : 'Script editor';
        case 'live':
          return 'Live console';
        case 'settings':
          return 'Settings';
        case 'calibrate':
          return 'Display calibration';
        case 'welcome':
          return 'Setup';
        default:
          return 'Script library';
      }
    })(),
  );

  /* Keep the document root in sync so scrollbars/body match the shell. */
  $effect(() => {
    document.documentElement.dataset['theme'] = theme;
  });

  /**
   * The page canvas goes black for the length of a take.
   *
   * Not cosmetic, and not the same job as the cover below. `body`'s background
   * is `--bg-app` — warm paper under the workspace theme, still a light-ish
   * grey under studio — and the stage's true black comes from `.stage-root`,
   * an absolutely-positioned element. When the window grows, the viewport gains
   * area before the layout reaches it, and what paints there is the CANVAS. So
   * a take that did not set this shows a strip of `--bg-app` down the side of
   * every window change, plate or no plate.
   *
   * Set on the document element rather than in this component's own scoped
   * style block, because the canvas background propagates from `body` — which
   * is outside every component in this app.
   *
   * (And because writing that tag name literally here breaks the build:
   * svelte2tsx scans the script for block tags without knowing it is inside a
   * comment, so a style-open in a doc comment leaves the parser convinced the
   * script never closed. `svelte` itself compiles the file happily, so the only
   * symptom is `pnpm check` failing at the last line of the file.)
   */
  $effect(() => {
    const black = canvasIsBlack($presentingPhase);
    if (black) document.documentElement.dataset['presenting'] = 'true';
    else delete document.documentElement.dataset['presenting'];
  });

  /*
   * The menu bar, kept in step with the application.
   *
   * `ready` gates it deliberately: `menu::install` builds every item disabled,
   * and the whole point of that is that the menu cannot act on a library that
   * has not loaded or an editor that does not exist yet. Pushing state during
   * boot would enable File › Present a beat before there is anything to
   * present.
   */
  $effect(() => {
    /*
     * RECOVERY GETS A MENU TOO, and it is the one launch that needs one most.
     *
     * `menu::install` builds every item disabled and this effect is what
     * enables them — but a boot that fails to open the database returns before
     * `ready` is ever set, so the menu bar stayed entirely grey on the screen
     * whose whole job is getting somebody out of trouble. Help › Reveal Logs
     * and Export Support Bundle are exactly what that screen wants, and both
     * are classified recovery-safe in Rust (`backup_tests.rs`).
     *
     * The context handed over is deliberately NOT `commandContext`: the stores
     * it reads never loaded. `recoveryCommandContext` is a flat, honest "nothing
     * is open and nothing can be started", which leaves the Help items enabled
     * — they answer `() => true` — and everything else greyed.
     */
    if (recoveryStatus !== null) {
      void pushMenuState(recoveryCommandContext);
      return;
    }
    if (!ready) return;
    void pushMenuState(commandContext);
  });

  /**
   * The application as recovery sees it: nothing open, nothing runnable.
   *
   * A constant rather than a derived, because in recovery none of its inputs
   * exist — the library never loaded, the editor never opened, and the session
   * store is at its initial value.
   */
  const recoveryCommandContext: CommandContext = {
    route: { name: 'library', view: 'all' },
    sessionActive: false,
    stageRigResolved: false,
    sessionPaused: false,
    stageBlanked: false,
    stageMirrored: false,
    scriptOpen: false,
    saveState: 'idle',
    editorHasUnsavedWork: false,
    librarySelectionId: null,
    libraryInTrash: false,
    sidebarVisible: false,
    outlineVisible: false,
    editorLayout: 'edit',
    takeStarting: false,
  };

  /*
   * The window's title, and the macOS modified dot.
   *
   * `edited` is the editor's unsaved state rather than "the document differs
   * from disk in some way": a conflict is NOT reported as modified, because the
   * dot means "you have work that is not written" and a conflict means
   * something stronger that the editor's own warning bar says properly.
   *
   * It is also gated on BEING IN THE EDITOR. The dot is a property of the
   * document the window is showing, and the editor store outlives the route —
   * so leaving a failed save for the Library used to show "Library — CandidCue"
   * with a modified dot beside it, claiming unsaved work in a window that is not
   * displaying a document at all.
   */
  $effect(() => {
    if (!ready) return;
    const title = composeWindowTitle({
      routeName: $route.name,
      scriptTitle: $route.name === 'editor' ? $editor.title : $session.scriptTitle || null,
      libraryView: $route.name === 'library' ? $route.view : undefined,
      sessionActive: $session.active,
    });
    const edited =
      $route.name === 'editor' &&
      $editor.saveState !== 'conflict' &&
      editorHasUnsavedWork();
    void pushWindowTitle(title, edited);
  });

  onMount(() => {
    // §30.1 triage. Off unless the operator switched it on for this window;
    // see audio-trace.ts for why the audio path needs it at all.
    initAudioTrace();

    /*
     * The speech model's readiness, followed for the life of the window (#301).
     *
     * Held here rather than by whichever screen shows it, because a take can be
     * launched from a screen that shows none of it — the Library, the
     * summary's Present again, a menu command — and each of those reads the
     * answer once, at launch. A store with no subscriber has no listener, and
     * would hand that read an assumption instead of the answer.
     */
    const releaseModelReadiness = speechModelReadiness.subscribe(() => {});

    /*
     * A held launch belongs to the screen it was asked for on. Leave that
     * screen — a menu command, a take starting from somewhere else — and the
     * sheet would follow, still holding a launch for a context that is gone.
     */
    const releaseReadinessOnNavigate = route.subscribe(() => dismissTakeReadiness());

    /*
     * Native menu clicks. Installed for the life of the window, and reading
     * both context and actions at dispatch time — a menu bar outlives every
     * route, so capturing either would pin the whole menu to whatever screen
     * happened to be up when the app started.
     */
    const teardownMenu = installMenuCommands(
      () => commandContext,
      () => commandActions,
    );

    /*
     * And re-describe the menu whenever this window comes back to the front.
     *
     * The menu bar is one object with two windows writing to it. Settings greys
     * everything it cannot do while it is focused, so without this the document
     * window inherited that state on the way back — File all greyed over an
     * open script — until something else happened to invalidate the command
     * context and trigger a push.
     */
    const teardownMenuFocus = installMenuStateOnFocus(() => void pushMenuState(commandContext));

    /*
     * Markdown dropped on the window.
     *
     * Hosted by the shell rather than by the Library, because the drop target is
     * the WINDOW: Rust reports a drag over the window and does not know which
     * route is up. Dropping a script while the editor is open should still
     * import it, which a Library-only listener would silently refuse.
     */
    /*
     * Adopt settings written by the Preferences window.
     *
     * Two webviews, two copies of the document. Without this, changing the stage
     * font in Settings would leave this window composing the next take from the
     * value it read at launch — and its next own write would fail an
     * optimistic-concurrency check nobody could account for.
     */
    const teardownSettingsSync = installSettingsSync();
    /*
     * And into the take on the glass, not only into the next one. The Settings
     * window is the control surface on the desk while this window is the
     * prompter on the other display; `stores/session.ts` says why.
     */
    const teardownLiveSettingsFollow = installLiveSettingsFollow();

    /*
     * And the OVERLAY, which the broadcast above cannot carry.
     *
     * Stage font and stage type size are composed into the settings document
     * from a `localStorage` overlay rather than written to the database, so a
     * change made in the Settings window commits no revision and emits no
     * `settings://changed`. This is the window that composes the take from
     * those values; without this it would go on using the ones it read at
     * launch, and the presenter would see the old type size on the glass while
     * Settings showed the new one.
     */
    const teardownOverlaySync = installOverlaySync([SETTINGS_OVERLAY_KEY], () => {
      /* Caught, because this runs from a `storage` event with nobody above it:
         an unhandled rejection here is a window-level error report about a
         re-read the user did not ask for and cannot act on. The overlay stays
         as it was and the next change tries again. */
      void loadSettings(true).catch((err: unknown) => {
        console.debug('settings could not be re-read after an overlay change', err);
      });
    });

    const teardownDrop = installDragDrop({
      onhover: (payload) => {
        dragHover = payload.active ? payload : null;
      },
      onimported: (payload) => {
        dragHover = null;
        void handleDroppedImport(payload);
      },
    });
    /*
     * The boot sequence outlives the component if the shell is torn down
     * mid-launch (HMR, a reload landing on a slow IPC round trip). None of the
     * calls below can be cancelled, so let them settle and drop the final
     * commits — a route set or a `ready` flip against an unmounted tree is at
     * best wasted and at worst a write nobody can see or undo.
     *
     * Scoped honestly: this covers the route, `ready` and the toast, and NOT
     * the stores each boot call writes on its way past. `initAppStatus`,
     * `loadSettings` and `loadLibrary` are global and commit before this is
     * consulted, so a torn-down boot can still land an older snapshot over a
     * newer one. Closing that needs a generation token through those loaders,
     * which is a bigger change than this one and only reachable under HMR — a
     * full webview reload throws the whole JS context away.
     */
    let disposed = false;
    const teardownShortcuts = installShortcuts();
    const teardownHelp = onShortcut((action) => {
      if (action === 'command-help') shortcutsOpen = true;
    });

    /* Leaving an active live session requires an explicit stop (spec §45.1). */
    const unregisterLiveGuard = registerNavigationGuard(async (to, from) => {
      if (from.name === 'live' && to.name !== 'live' && $session.active) {
        /*
         * "End", not "stop", and the same body as Live's own dialog. §115's
         * complaint was one action wearing several names; this guard is the
         * fourth way out of a take and would have kept the old word alive.
         */
        const accepted = await requestConfirm(sessionEndConfirmation($session.practice));
        if (!accepted) return false;
        /*
         * The window has to come back too, and covered — this is a geometry
         * change like any other.
         *
         * Live's own exits un-present, but this guard is the path for every
         * OTHER way out of a take: a shortcut, a sidebar click, anything that
         * navigates while a session is live. It used to stop the session and
         * leave the window borderless with no titlebar; then it un-presented
         * bare, which fixed the window and left the reverse transition artifact
         * — `clearSession()` unmounts the stage, so the shrinking window shows
         * the light editor arriving in pieces.
         *
         * The cover goes up FIRST, before `clearSession()` tears the stage
         * down, so nothing between here and the destination is ever on screen
         * mid-resize. `finally` because this is a navigation guard: returning
         * true hands control to a router that runs more guards, and a phase
         * stuck at `closing` is an app the operator cannot see.
         *
         * `exitPresentation` is a no-op in Rust when nothing was presented, so
         * it is safe on the paths that reach here without one.
         */
        setPresentingPhase('closing');
        try {
          await painted();
          stopSession();
          clearSession();
          const restored = await exitPresentation().catch(() => null);
          // Awaited so the write cannot be overtaken by the next take's forced
          // settings read — see `leavePresentation` in Live.svelte.
          await rememberReaderFrame(restored);
          if (restored) await awaitViewportSettled(restored);
        } finally {
          setPresentingPhase('off');
        }
      }
      return true;
    });

    /*
     * Flush any pending editor autosave when navigating away (spec §13.5) — and
     * then check that the flush actually landed.
     *
     * `saveNow()` reports a conflict or a failed write through store state and
     * resolves normally either way, so awaiting it proves nothing on its own.
     * This guard used to await it and return true unconditionally, which meant
     * that with a save failing, clicking Library abandoned the only copy of the
     * text without a word — and the conflict sheet, whose entire job is to let
     * the operator choose between their text and the disk's, could be walked
     * past without ever appearing.
     *
     * The confirmation always offers a way THROUGH. A failing save is already a
     * bad situation; a guard that cannot be satisfied would turn it into a
     * screen the operator cannot leave, which is the same trap as a boot that
     * never finishes. `saveNow()` is wrapped even though it does not currently
     * throw: if that contract ever changes, the escape path has to survive it.
     */
    const unregisterSaveGuard = registerNavigationGuard(async (to, from) => {
      if (from.name !== 'editor') return true;

      let saveThrew = false;
      try {
        await saveNow();
      } catch {
        saveThrew = true;
      }

      const decision = editorNavigationDecision({
        to,
        from,
        hasUnsavedWork: saveThrew || editorHasUnsavedWork(),
      });
      if (decision === 'allow') return true;
      // Live is vetoed rather than asked about — see app-lifecycle.ts.
      if (decision === 'veto') return false;

      /*
       * A conflict gets its own question, because it is a different question.
       *
       * The other three states are one accident — the write has not happened
       * yet, or it failed — and "they may be lost" is the honest summary. A
       * conflict is not an accident: the file changed on disk, both versions
       * are real, and Editor.svelte has a sheet for choosing between them.
       * Wrapping that in "may be lost" would describe the one case where the
       * loss is certain and the remedy is one screen away.
       */
      const conflicted = get(editor).saveState === 'conflict';
      return await requestConfirm(
        conflicted
          ? {
              title: 'Leave without resolving the conflict?',
              body: 'This script also changed on disk. Stay to choose which version to keep — leaving now discards the version in CandidCue.',
              confirmLabel: 'Discard my version',
              cancelLabel: 'Stay and resolve',
              danger: true,
            }
          : {
              title: 'Leave with unsaved changes?',
              body: 'Your latest changes are not saved. If you leave now, they may be lost.',
              confirmLabel: 'Leave anyway',
              cancelLabel: 'Stay in editor',
              danger: true,
            },
      );
    });

    void (async () => {
      /*
       * GIVE THE WINDOW BACK BEFORE SHOWING ANYTHING.
       *
       * The presentation latch lives in Rust and deliberately outlives the
       * renderer, so it survives a webview reload — but nothing else about a
       * take does. The session store, the transport, the aligner and this
       * store all come back as "no take in progress", because they cannot come
       * back any other way: the audio and the transcript are gone.
       *
       * So a reload mid-take (a crash in the web content process, a dev-server
       * HMR failure, ⌘R) would boot the Library inside a borderless,
       * monitor-sized, above-the-menu-bar window with no titlebar, and no
       * remaining code path that knows to undo it. Rust plans this as a no-op
       * when nothing was presented, which is the overwhelmingly common case, so
       * it costs one IPC round trip at startup to close a hole that otherwise
       * needs a force-quit.
       *
       * Before `ready`, so the first thing painted is already the right shape.
       *
       * Deliberately NOT remembering the reader frame here, unlike the other
       * exits. This runs before `loadSettings`, so the settings store still
       * holds defaults at revision 1 — a patch from here would be written
       * against a revision that is not the document's, and `patchSettings`
       * announces that failure to an operator who has not yet seen the app
       * finish launching. The frame from the take that was interrupted is lost,
       * which is the right trade: it is a crash-recovery path, and the last
       * ORDERLY exit already stored a frame.
       */
      try {
        await exitPresentation().catch(() => {});
        setPresentingPhase('off');

        /*
         * Did the database come up? Asked FIRST, before anything reads it.
         *
         * `database::init` failing used to abort Tauri's setup hook, which
         * runs before a webview exists — so `DATABASE_CORRUPT` and a failed
         * migration could never reach the boot-failure screen written for
         * them, and the user got an application that vanished. Rust carries
         * the failure into the running process now, and this is where the
         * shell decides to render recovery instead of the app.
         *
         * A REJECTION here fails closed, and that is a change from the first
         * version of this code. `getBootStatus` already answers
         * `{ databaseReady: true }` without touching IPC when there is no Tauri
         * runtime — a browser dev session — so a rejection means the command
         * exists and something went wrong asking it. Treating that as "assume
         * the database is fine" would open the editor over an unknown backend,
         * which is the exact situation this guard was added for.
         */
        const boot = await getBootStatus().catch(
          (err: unknown): BootStatusReport => ({
            databaseReady: false,
            code: 'DATABASE_UNAVAILABLE',
            message: `CandidCue could not determine whether its database opened. ${describeError(err)}`,
            dataDirectory: '',
          }),
        );
        if (!boot.databaseReady) {
          if (disposed) return;
          recoveryStatus = boot;
          return;
        }

        const status = await initAppStatus();

        /*
         * A settings read that fails is not a reason to refuse to start.
         *
         * The store already holds `defaultAppSettings()`, so the fallback is a
         * working app with the wrong preferences — plainly better than no app,
         * and `loaded` stays false so Settings and the next take both retry the
         * real read. The exception is a database that could not be migrated or
         * whose integrity check failed: those are rethrown to the boot failure
         * screen, because opening the app there would invite somebody to write
         * a script into a store that cannot keep it.
         *
         * Routing reads the value this returned rather than the store, so it
         * cannot race a subscription that has not fired yet.
         */
        let launchSettings = defaultAppSettings();
        let settingsWarning: string | null = null;
        try {
          launchSettings = await loadSettings();
        } catch (err) {
          if (isFatalBootCode(errorCode(err))) throw err;
          settingsWarning = describeError(err);
        }

        // Needed even when a script is about to open: the sidebar reads it.
        await loadLibrary();

        const recentScriptId = await recentScriptIdForBoot({
          firstLaunch: status.firstLaunch,
          launchBehavior: launchSettings.general.launchBehavior,
          listRecent: () => listScripts({ view: 'recent' }),
        });

        if (disposed) return;
        setInitialRoute(
          initialRouteForBoot({
            firstLaunch: status.firstLaunch,
            launchBehavior: launchSettings.general.launchBehavior,
            recentScriptId,
          }),
        );
        ready = true;

        /*
         * After `ready`, and it does not need to wait for a paint: ToastRegion
         * lives outside the boot branch and is mounted for the whole life of the
         * shell. Raised last so it lands on the app rather than on the splash.
         */
        /*
         * Anything startup reconciliation repaired, collected now that there
         * is a window to tell.
         *
         * Rust used to emit `diagnostic://warning` for this, from inside
         * `setup` — before this webview had run any JavaScript — so it landed
         * on a page with no listeners and vanished. Asking is the delivery that
         * cannot be raced, and it is now the only one.
         */
        void getStartupFindings()
          .then((findings) => {
            if (findings === null || disposed) return;
            showToast(
              'CandidCue repaired some script records while starting. ' +
                'Settings › Diagnostics has the details.',
              'info',
            );
          })
          .catch(() => {
            // An older build has no such command. The diagnostics file and the
            // log still hold the report.
          });

        if (settingsWarning !== null) {
          showToast(
            `CandidCue could not load your settings, so this launch is using defaults. ${settingsWarning}`,
            'danger',
          );
        }
      } catch (err) {
        if (disposed) return;
        bootFailure = describeError(err);
      }
    })();

    /*
     * Close and quit, coordinated (§47.6).
     *
     * Rust intercepts both, asks here, and waits ~4s. Before this, closing the
     * window or pressing ⌘Q went straight to process exit: a debounced save
     * still inside its window was simply lost, the take's session row stayed
     * open until the next launch swept it as abandoned, and the reader frame
     * was never persisted.
     *
     * The steps are built at shutdown time rather than captured now, so they
     * see the state as it is when the user quits, not as it was at boot.
     */
    const teardownShutdown = installShutdownHandshake(() => [
      {
        /*
         * First, and the only irreplaceable one. Everything below is
         * repaired, re-derived or restarted on the next launch; the newest
         * edits to a script are not.
         *
         * `saveNow()` RESOLVES WHEN THE SAVE FAILS. That is correct while the
         * app is open — a conflict or a failed write is reported through store
         * state and the editor's own sheets — and wrong at the moment it
         * closes, because there is no longer a screen to report to. Awaiting
         * it and moving on would have quit with the text gone and the step
         * recorded as completed.
         *
         * So the flush is checked, and anything still unsaved is parked in
         * `quarantine/unsaved/` rather than lost. Never written over the
         * canonical file: in a conflict that file holds someone else's newer
         * text, and overwriting it here would resolve the conflict by
         * destroying one side of it, silently, during a quit.
         */
        name: 'flush-editor',
        run: async () => {
          await saveNow();
          if (!editorHasUnsavedWork()) return;

          const { scriptId, source } = get(editor);
          if (scriptId === null) return;
          const at = await writeUnsavedRecovery(scriptId, source);
          // Thrown so the step is reported as FAILED. It did not do what it
          // was for — the script was not saved — and Rust logs the reason.
          throw new Error(`the script could not be saved; its text is at ${at}`);
        },
      },
      {
        // Through the same path a normal end uses, so a take that ended by
        // quitting is not a different kind of record from one that ended by
        // pressing End.
        name: 'end-take',
        run: async () => {
          if (get(session).active) {
            stopSession();
            clearSession();
          }
          /*
           * AWAITED, and that is the whole point of this step.
           *
           * `stopSession` issues the session-row closure as
           * `void promise.catch(…)` — right during a take, where a slow
           * database must never stall the stop path, and wrong at the moment
           * the process exits. Without this the handshake reported "the take
           * was finished" and Rust exited out from under a write that was
           * still on the wire.
           *
           * The next launch can close an orphaned session row. It cannot
           * recover the ending token Editor starts the next take from.
           */
          await awaitPendingPersistence();
        },
      },
      {
        // So the next take opens where this one was.
        name: 'reader-frame',
        run: async () => {
          const restored = await exitPresentation().catch(() => null);
          await rememberReaderFrame(restored);
        },
      },
    ]);

    return () => {
      disposed = true;
      teardownMenu();
      teardownMenuFocus();
      teardownDrop();
      teardownSettingsSync();
      teardownLiveSettingsFollow();
      teardownOverlaySync();
      teardownShortcuts();
      teardownHelp();
      unregisterLiveGuard();
      unregisterSaveGuard();
      teardownShutdown();
      releaseModelReadiness();
      releaseReadinessOnNavigate();
    };
  });

  async function newScriptFromSidebar(): Promise<void> {
    await createAndOpenScript('new');
  }

  /* ------------------------------------------------------------------------
   * NATIVE MENU AND WINDOW IDENTITY (desktop refinement §5, §6)
   *
   * The shell is where this belongs and nowhere else. It is the one component
   * mounted for the whole life of the window, it already holds the navigation
   * guards every command has to respect, and it can see every store a command's
   * availability depends on. A route owning any part of it would mean the menu
   * went dead for the length of whatever route forgot to.
   * ---------------------------------------------------------------------- */

  /**
   * The application, as a flat snapshot, for the availability predicates.
   *
   * Rebuilt by Svelte whenever any input changes, which is exactly the cadence
   * the menu wants: a take starting, a script closing and a save failing are all
   * things the menu bar has to notice within a frame.
   *
   * ---------------------------------------------------------------------------
   * TWO FIELDS ARE PLAIN FUNCTION CALLS, AND THEY TRACK ONLY BY NEIGHBOURING
   * ---------------------------------------------------------------------------
   * `editorHasUnsavedWork()` and `liveMirrorX()` are ordinary functions that
   * read their stores with `get()`. `get()` subscribes and immediately
   * unsubscribes, so it registers NO dependency in a `$derived` — on their own,
   * these two would compute once and then be stale for ever.
   *
   * They are correct here because `$editor.saveState` and `$session.active` are
   * read in the same expression, and a `$` store read subscribes to the whole
   * store rather than to the field. So any editor change re-runs the first and
   * any session change re-runs the second — and `toggleStageMirror` does write
   * the session store (`recomposeStageSettings`), which is what makes the mirror
   * checkmark track.
   *
   * That is a real dependency held together by adjacency. If either `$` read is
   * ever removed from this object, its neighbour goes silently stale: the menu
   * would keep offering Save on a document with nothing to save, and the mirror
   * checkmark would freeze. Keep both reads, or convert the two functions to
   * derived stores.
   */
  const commandContext = $derived<CommandContext>({
    route: $route,
    sessionActive: $session.active,
    /* §17.2: a calibrated rig sizes its own type, so Larger/Smaller Stage Text
       is greyed rather than refused after it is chosen. */
    stageRigResolved: $session.stageRigResolved === true,
    sessionPaused: $session.paused !== 'none',
    stageBlanked: $session.stageBlanked,
    // Read through a function rather than from `SessionState`, because the
    // mirror is the take's own flip or its panel's saved answer — see
    // `liveMirrorX`. `$session` is referenced so this recomputes when the take
    // changes.
    stageMirrored: $session.active ? liveMirrorX() : false,
    scriptOpen: $editor.scriptId !== null,
    saveState: $editor.saveState,
    editorHasUnsavedWork: editorHasUnsavedWork(),
    librarySelectionId: $library.selectedId,
    libraryInTrash: $library.view === 'trash',
    sidebarVisible: $workspace.sidebarVisible,
    outlineVisible: $workspace.outlineVisible,
    editorLayout: $workspace.editorLayout,
    takeStarting: $takeStarting,
  });

  /**
   * What each command actually does.
   *
   * Every entry that leaves a screen goes through `navigate()`, which runs the
   * unsaved-work and end-take guards registered above. That is the property
   * that makes a native menu safe to add: File › New Script from inside a take
   * asks the same question the sidebar does, because it is the same code.
   *
   * Close Window is the one exit that does not navigate — it quits — so it asks
   * that question itself (`requestWindowClose`), in the same words.
   */
  const commandActions: CommandActions = {
    newScript: () => void createAndOpenScript('new'),
    importMarkdown: () => void importMarkdown(),
    save: () => void saveNow(),
    duplicate: (scriptId) => void duplicateScript(scriptId),
    rename: () => dispatchRouteCommand('file.rename-script'),
    exportMarkdown: (scriptId) => {
      const title = titleForScript(scriptId);
      void exportScriptToFile(scriptId, title, 'markdown');
    },
    revealScript: (scriptId) => {
      void scriptsService.revealScriptFolder(scriptId).catch((err: unknown) => {
        showToast(`That script's folder could not be opened. ${describeError(err)}`, 'danger');
      });
    },
    moveToTrash: (scriptId) => void confirmMoveToTrash(scriptId),
    closeScript: () => void navigate({ name: 'library', view: get(library).view }),
    /*
     * ⌘W outside the editor.
     *
     * `window.close()` is deliberately NOT used: it bypasses the
     * `CloseRequested` interception in `app.rs` on some webview builds, and that
     * interception is the only thing that flushes an unsaved script and closes
     * an open session row. Asking the WINDOW to close is what raises the event
     * the handshake hangs off — and Rust has to do the asking, because the
     * capability does not let the renderer (`requestWindowClose`).
     */
    closeWindow: () => void requestWindowClose(),
    present: (mode) => {
      const id = commandTargetScriptId();
      if (id === null) return;
      void checkThenStartTake(id, mode ? { presentationMode: mode } : {});
    },
    /*
     * A practice does not take `presentationMode` from anywhere.
     *
     * `startTake` forces the window, for the reason given at `practice` in
     * `StartTakeOptions`: a rehearsal that filled the display would be a take
     * with a different name on it.
     */
    practise: () => {
      const id = commandTargetScriptId();
      if (id === null) return;
      void checkThenStartTake(id, { practice: true });
    },
    find: () => dispatchRouteCommand('edit.find'),
    findNext: () => dispatchRouteCommand('edit.find-next'),
    findPrevious: () => dispatchRouteCommand('edit.find-previous'),
    replace: () => dispatchRouteCommand('edit.replace'),
    showLibrary: () => void navigate({ name: 'library', view: get(library).view }),
    toggleSidebar: () => updateWorkspace({ sidebarVisible: !get(workspace).sidebarVisible }),
    toggleOutline: () => updateWorkspace({ outlineVisible: !get(workspace).outlineVisible }),
    setEditorLayout: (layout: EditorLayout) => updateWorkspace({ editorLayout: layout }),
    /*
     * ⌘+ / ⌘− / ⌘0 mean "text size HERE" — and here is not always the editor.
     *
     * These used to be editor-only, which read as harmless because the stage
     * type size had its own keys in the shortcut table. It was not harmless:
     * the keys were the SAME two, and a menu accelerator is claimed by the
     * window whether or not the item is enabled (see `file.close-script`). So
     * during a take the disabled Larger Editor Text swallowed ⌘=, and the
     * presenter's type-size keys did nothing in the packaged app while working
     * perfectly in the browser.
     *
     * Routed through the shortcut bus in Live for the same reason the Session
     * menu is: Live owns the rig-resolved ceiling on stage type, and reaching
     * past it from here is how a menu item and a key come to disagree.
     */
    stepScale: (direction) => {
      if (get(route).name !== 'live') {
        stepDocumentScale(direction);
        return;
      }
      if (direction === 1) void emitShortcut('stage-text-up');
      else if (direction === -1) void emitShortcut('stage-text-down');
    },
    stageAppearance: () => dispatchRouteCommand('view.stage-appearance'),
    insert: (what) => dispatchInsert(what),
    /*
     * ⌘, opens a WINDOW now (§14.1), it does not navigate.
     *
     * That is the whole point: changing a preference no longer costs you the
     * script you had open, and closing Settings puts you back where you were
     * because you never went anywhere. The section it opens at comes from the
     * workspace store, which is `localStorage` and therefore shared across
     * webviews — so the window opens where this one last left Settings, with no
     * coordination at all.
     */
    settings: () => void openSettingsWindow(),
    /*
     * The Session menu is routed through the SHORTCUT BUS rather than calling
     * the session store directly.
     *
     * Live already subscribes there with every guard it needs — the section
     * bounds, the rig-resolved type ceiling. Calling `togglePlayPause()` from
     * here would work and would skip all of them, which is how a menu item and
     * a key come to do subtly different things. The one guard a menu command
     * must skip, the delegate-to-the-embedded-stage list, it skips because
     * `emitShortcut` delivers it as `'menu'` (#284).
     */
    startTake: () => {
      const id = commandTargetScriptId();
      if (id !== null) void checkThenStartTake(id);
    },
    playPause: () => void emitShortcut('play-pause'),
    moveSentence: (delta) => void emitShortcut(delta < 0 ? 'back-sentence' : 'forward-sentence'),
    moveChapter: (delta) => void emitShortcut(delta < 0 ? 'prev-chapter' : 'next-chapter'),
    blankStage: () => void emitShortcut('blank-stage'),
    toggleMirror: () => void emitShortcut('toggle-mirror'),
    identifyDisplays: () => void identifyStageDisplays(),
    endTake: () => void emitShortcut('stop-session'),
    showMainWindow: () => void focusMainWindow(),
    /*
     * Window › Stage. Enabled by RUST only while a stage webview exists — the
     * appearance preview and the calibration wizard are what create one — so
     * reaching this always has a window to bring forward.
     */
    showStageWindow: () => void focusAppWindow('stage'),
    keyboardShortcuts: () => (shortcutsOpen = true),
    setupAssistant: () => void navigate({ name: 'welcome' }),
    exportSupportBundle: () => void exportSupportBundleFromMenu(),
    revealLogs: () => {
      void revealLogs().catch((err: unknown) => {
        showToast(`The log folder could not be opened. ${describeError(err)}`, 'danger');
      });
    },
    privacy: () => void openSettingsWindow('privacy'),
    /*
     * Reported rather than swallowed. The browser not opening is invisible from
     * inside the app — nothing changes on screen — so a user who clicks Help ›
     * Project README and sees nothing has no way to tell whether they missed the
     * click or the app failed. One toast is the difference.
     */
    openWebDestination: (destination) => {
      void openWebDestination(destination).catch((err: unknown) => {
        showToast(`That page could not be opened. ${describeError(err)}`, 'danger');
      });
    },
    thirdPartyNotices: () => {
      void openThirdPartyNotices().catch((err: unknown) => {
        showToast(`The notices could not be opened. ${describeError(err)}`, 'danger');
      });
    },
  };

  /** The script a File command acts on: the open one, or the selected row. */
  function commandTargetScriptId(): string | null {
    const current = get(route);
    if (current.name === 'editor') return current.scriptId;
    const lib = get(library);
    if (current.name === 'library' && lib.view !== 'trash') return lib.selectedId;
    return null;
  }

  function titleForScript(scriptId: string): string {
    const open = get(editor);
    if (open.scriptId === scriptId && open.title) return open.title;
    return get(library).scripts.find((s) => s.id === scriptId)?.title ?? 'Script';
  }


  async function confirmMoveToTrash(scriptId: string): Promise<void> {
    const title = titleForScript(scriptId);
    const accepted = await requestConfirm({
      // Named, per §18.4: "Are you sure?" tells somebody with forty scripts
      // nothing about which one is about to move.
      title: 'Move to Trash?',
      body: `“${title}” will move to Trash and can be restored for 30 days.`,
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (!accepted) return;
    /*
     * Leave the editor FIRST when the script being trashed is the open one.
     *
     * Trashing the open script and staying put leaves the editor holding a
     * document whose canonical file has moved — every subsequent autosave then
     * fails against a path that is gone, and the conflict sheet appears for a
     * conflict nobody caused. Navigation runs the save guard on the way out,
     * which either saves the last edits or has the author agree to leave them
     * behind — so the trash below must not try to save them again (#255).
     */
    if (get(route).name === 'editor' && get(editor).scriptId === scriptId) {
      const left = await navigate({ name: 'library', view: get(library).view });
      if (!left) return;
    }
    await moveScriptToTrash(scriptId);
  }

  async function exportSupportBundleFromMenu(): Promise<void> {
    try {
      const result = await exportSupportBundle();
      if (result.cancelled) return;
      showToast(
        result.path === undefined
          ? 'Support bundle saved.'
          : `Support bundle saved to ${result.path}.`,
        'success',
      );
    } catch (err) {
      showToast(`The support bundle could not be written. ${describeError(err)}`, 'danger');
    }
  }

  /**
   * Report what a drop did, and open the script if exactly one arrived.
   *
   * "Exactly one" is the discriminator rather than "the last one": dropping a
   * folder's worth of scripts is a bulk import, and yanking the user into the
   * editor for whichever file the OS happened to list last would take them away
   * from the list they are about to want to look at.
   */
  async function handleDroppedImport(payload: DragImportedPayload): Promise<void> {
    for (const warning of payload.warnings) showToast(warning, 'info');

    /*
     * Images first, and they short-circuit.
     *
     * A drop of images into the open script is a different gesture from a drop
     * of scripts into the library: nothing to reload, nothing to navigate to,
     * and the text has already gone where it belongs. Reporting it with a toast
     * as well would be announcing something the user is looking straight at.
     */
    if (payload.images.length > 0 && payload.imageScriptId !== null) {
      const inserted = await dispatchDroppedImages(payload.imageScriptId, payload.images);
      if (!inserted) {
        // Imported, but the editor was not in a state to place it. Say so
        // rather than leaving an asset in the script with no reference to it.
        showToast(
          payload.images.length === 1
            ? 'The image was added to the script, but the editor had moved on before it could be placed.'
            : 'The images were added to the script, but the editor had moved on before they could be placed.',
          'info',
        );
      }
    }

    if (payload.rejected.length > 0) {
      // Named, and capped. §10.5 asks for a concise rejection; a toast listing
      // forty file names is not concise, and the first two are enough to make
      // the KIND of file obvious, which is the actual information.
      const names = payload.rejected.slice(0, 2).join(', ');
      const rest = payload.rejected.length - 2;
      showToast(
        rest > 0
          ? `CandidCue imports Markdown and plain text. ${names} and ${rest} more were not imported.`
          : `CandidCue imports Markdown and plain text. ${names} was not imported.`,
        'info',
      );
    }
    if (payload.failed.length > 0) {
      // Capped like the rejected list above. An unbounded join put forty file
      // names in a toast, which is not a message anybody reads.
      const names = payload.failed.slice(0, 2).join(', ');
      const rest = payload.failed.length - 2;
      showToast(
        rest > 0
          ? `${names} and ${rest} more could not be read. The files may be damaged or in use.`
          : `${names} could not be read. The file may be damaged or in use.`,
        'danger',
      );
    }
    if (payload.imported === 0) return;

    await loadLibrary();
    if (payload.imported === 1 && payload.scriptId !== null) {
      // Through `navigate`, so a drop while the editor holds unsaved work asks
      // the same question every other way out of the editor asks.
      const moved = await navigate({ name: 'editor', scriptId: payload.scriptId });
      /*
       * A VETOED navigation still imported the script.
       *
       * `navigate` returns false when a guard refuses — the operator chose
       * "Stay in editor" at the unsaved-changes prompt. Returning silently
       * there meant the drop appeared to do nothing at all: no editor, no
       * notice, and the script sitting in a Library they are not looking at.
       */
      if (moved) return;
      showToast('Script imported. It is in your library.', 'success');
      return;
    }
    showToast(`${payload.imported} scripts imported`, 'success');
  }

  /** A Close Window between its ⌘W and Rust's answer — see `requestWindowClose`. */
  let windowCloseInFlight = false;

  /**
   * File › Close Window: ask Rust to close this window, so the shutdown
   * handshake runs (§6.3). Closing the document window quits the app.
   *
   * Through Rust. This used to call `getCurrentWindow().close()`, which the
   * capability does not permit, inside a `catch` that read the refusal as
   * "browser dev" — ⌘W off the editor did nothing at all (#266). The browser
   * no-op is now an explicit runtime check, so a real failure reaches a toast.
   *
   * A RUNNING TAKE IS ASKED ABOUT FIRST. The handshake ends a take on its way
   * out without a word, which is right for the red close button and ⌘Q and
   * wrong for a menu item whose key sits next to ⌘Q's and is pressed by habit.
   * Every other way out of a take asks "End this take?", and this one quits
   * as well. It asks whatever `confirmEndSession` says, as the navigation
   * guard does: that setting is about Live's own End, and a quit is not that.
   *
   * The question is asked BEFORE the close is requested, never from inside
   * the handshake: once `CloseRequested` lands, shutdown has begun against a
   * deadline that a person reading a dialog would run out.
   *
   * Three states decline instead of asking, and each is the safe direction —
   * nothing ends, and pressing ⌘W again once it has passed works:
   *   - a take opening or a presentation closing: the transition cover is up,
   *     and a dialog behind it is a frozen screen with a question nobody can
   *     see (`editorNavigationDecision` vetoes for the same reason);
   *   - a question already on screen: `requestConfirm` holds one at a time,
   *     and replacing it would strand whoever was waiting for that answer;
   *   - a close already in flight, so a held ⌘W raises one dialog, not a
   *     stack of them.
   */
  async function requestWindowClose(): Promise<void> {
    if (!isTauriRuntime() || windowCloseInFlight) return;
    if (get(takeStarting) || coverIsUp(get(presentingPhase))) return;
    if (get(pendingConfirm) !== null) return;
    windowCloseInFlight = true;
    try {
      const current = get(session);
      if (current.active && !(await requestConfirm(sessionEndConfirmation(current.practice)))) {
        return;
      }
      // No `stopSession()` here. The handshake's `end-take` step finishes the
      // take and awaits its writes; doing it twice would race the two.
      await closeControlWindow();
    } catch (err) {
      showToast(describeError(err), 'danger');
    } finally {
      windowCloseInFlight = false;
    }
  }

  /**
   * Window › CandidCue — bring the document window forward.
   *
   * Through Rust. This used to call `getCurrentWindow().setFocus()` directly,
   * which the capability does not permit — see `focusAppWindow`.
   */
  async function focusMainWindow(): Promise<void> {
    await focusAppWindow('control');
  }

  /**
   * The one action the boot failure screen offers.
   *
   * The authored copy for a failed migration tells the operator to export a
   * support bundle from Settings — and a launch that stopped here is precisely a
   * launch with no Settings to reach. Rather than quote an instruction nobody
   * can follow, the screen carries the export itself. Rust owns the folder
   * picker, so cancelling is an ordinary outcome and not a failure; a genuine
   * failure is reported in place, which leaves the operator no worse off than
   * the button not being there.
   */
  async function exportBootSupportBundle(): Promise<void> {
    bootExporting = true;
    bootExportNote = null;
    try {
      const result = await exportSupportBundle();
      // `path` is optional on the result type, so it is checked rather than
      // interpolated — "saved to undefined" would read as a bug in the report
      // somebody is exporting precisely because something is already wrong.
      if (!result.cancelled) {
        bootExportNote =
          result.path === undefined
            ? 'Support bundle saved.'
            : `Support bundle saved to ${result.path}.`;
      }
    } catch (err) {
      bootExportNote = `The support bundle could not be written. ${describeError(err)}`;
    } finally {
      bootExporting = false;
    }
  }
</script>

<div class="shell" data-theme={theme}>
  {#if recoveryStatus !== null}
    <!--
      Rendered INSTEAD of the application, not on top of it. The rule the
      readiness review asked for is that the normal application cannot open
      until recovery has produced a writable, valid database — so there is no
      route past this, and the recovery actions all end by saying "quit and
      reopen", which is what re-runs `database::init`.
    -->
    <Recovery status={recoveryStatus} />
  {:else if !ready}
    <div class="boot">
      {#if bootFailure === null}
        <p class="boot-mark">CandidCue</p>
      {:else}
        <section class="boot-failure" role="alert">
          <h1 class="boot-failure-title">CandidCue could not finish starting</h1>
          <p class="boot-failure-body">{bootFailure}</p>
          <Button variant="default" disabled={bootExporting} onclick={() => void exportBootSupportBundle()}>
            {bootExporting ? 'Exporting…' : 'Export support bundle'}
          </Button>
          {#if bootExportNote !== null}
            <p class="boot-failure-note">{bootExportNote}</p>
          {/if}
          <!--
            No second export instruction here. The authored copy above may already
            carry one (the migration text points at Settings → Diagnostics, which
            a launch that stopped here cannot reach) and the button is the answer
            to it — repeating the advice underneath, hedged with "if it happens
            again", contradicts the copy it sits below.
          -->
          <p class="boot-failure-note">Quit CandidCue and open it again.</p>
        </section>
      {/if}
    </div>
  {:else}
    <!--
      The sidebar is shown when the ROUTE has one and the user has not hidden
      it. Two conditions rather than one, because they answer different
      questions: the route decides whether a navigation rail is meaningful (a
      take has none), and the workspace flag records a choice the user made and
      that View › Show Sidebar toggles.
    -->
    {#if showSidebar && $workspace.sidebarVisible}
      <Sidebar
        onnew={() => void newScriptFromSidebar()}
        onsettings={() => void openSettingsWindow()}
      />
    {/if}
    <!--
      A NAMED landmark (§23.2).

      Screen-reader users navigate by landmark, and an unnamed `<main>` in a
      window that also has a navigation rail and (per route) a toolbar, an
      inspector and a status bar is one anonymous region among several. The name
      follows the route, so "jump to main" announces where it lands.
    -->
    <main class="content" aria-label={mainLandmarkLabel}>
      {#if $route.name === 'welcome'}
        <Welcome />
      {:else if $route.name === 'library'}
        <Library />
      {:else if $route.name === 'editor'}
        <Editor scriptId={$route.scriptId} />
      {:else if $route.name === 'live'}
        <Live sessionId={$route.sessionId} scriptId={$route.scriptId} />
      {:else}
        <!--
          Settings and Calibration are NOT rendered here any more (§14.1).
          Both live in the Preferences window; `openSettingsWindow` opens it and
          `Settings.svelte` navigates to Calibrate inside it. Nothing in this
          window sets those routes, so falling through to the Library is the
          correct answer for a route that cannot occur rather than a hole.
        -->
        <!--
          A route with no branch used to paint an empty `<main>`.

          With the sidebar hidden for that route it is not a blank screen, it is
          a trap: no navigation, no back control, nothing to press. That is a
          worse failure than a wrong screen, and it is invisible in a unit test
          because navigation genuinely SUCCEEDED — the route store holds a valid
          value and nothing threw.

          So the fallthrough goes somewhere real rather than nowhere.
        -->
        <Library />
      {/if}
    </main>
  {/if}

  <ToastRegion />
  <ConfirmHost />
  <!--
    "Before this take", for every way of starting one (CCUX-013, #301). Hosted
    here, not on the editor, because File › Present, the Library and the
    summary's Present again launch from screens that are not the editor, and
    used to skip the check entirely. Only ever mounted; almost never open —
    `resolveReadiness` says nothing on a healthy familiar setup, which is the
    design.
  -->
  <TakeReadinessSheet
    verdict={$takeReadinessPrompt?.verdict ?? null}
    onstart={() => void startAnyway()}
    onclose={dismissTakeReadiness}
  />
  <!--
    One context menu for the whole window, hosted here. See
    `stores/context-menu.ts`: a menu per row would be one popover component per
    script in the Library, and "only one open at a time" would be a rule
    everybody had to remember rather than a fact about the tree.
  -->
  <ContextMenu />
  <!--
    The take's report, hosted here rather than on the route that produced it.

    A take now ends by navigating back to the editor, and the summary is the
    destination of that navigation rather than a passenger on the screen it left
    — so it has to outlive Live. See the note at the top of the component.
  -->
  <SessionSummary />
  <ShortcutsDialog open={shortcutsOpen} onclose={() => (shortcutsOpen = false)} />
</div>

<!--
  The cover that spans a presentation transition.

  Outside `.shell` and `position: fixed`, because the one thing it must do is
  span the WINDOW rather than a route: while it is up, the window is changing
  size, the editor is being torn down and the stage is being built, and an
  element positioned against any of those would be the wrong size for part of
  the interval.

  `aria-hidden` and no focusable contents: it is up for a few hundred
  milliseconds around a transition the operator already asked for, and
  announcing it would interrupt the toast or dialog that actually has something
  to say.
-->
{#if coverIsUp($presentingPhase)}
  <div class="present-cover" aria-hidden="true"></div>
{/if}

<!--
  The drop target (§20.2), shown ONLY while files are genuinely over the window.

  Outside `.shell` and `position: fixed` for the same reason the cover is: the
  drop applies to the window rather than to a route, and a drop landing during a
  route change must not be caught by an element that is being unmounted.

  `pointer-events: none` throughout. This is a picture of what will happen, not
  a surface to hit — intercepting the pointer would mean the drop landed on this
  overlay rather than on the window, which is where Rust is listening.

  Suppressed during a take. A presenter is reading off this glass, and a
  full-window overlay appearing because somebody at the desk dragged a file past
  the window would put a grey wash over the script mid-sentence.
-->
{#if dragHover !== null && !$session.active}
  <div class="drop-target" class:rejecting={dragHover.accepted === 0} aria-hidden="true">
    <div class="drop-card">
      <p class="drop-title">
        {dragHover.accepted === 0
          ? 'CandidCue cannot import this'
          : dragHover.acceptsImages
            ? 'Drop to add'
            : 'Drop to import'}
      </p>
      <p class="drop-body">
        <!--
          The copy follows what Rust would ACTUALLY do with this set, which
          depends on where the drop lands: an image over the editor is an
          insertion, and over the Library it is a rejection. Saying "cannot
          import this" over an editor that was about to import it happily is the
          overlay lying about the next half-second.
        -->
        {#if dragHover.accepted === 0}
          Markdown (.md) and plain text (.txt) can be imported. Open a script to
          add images to it.
        {:else if dragHover.acceptsImages}
          {dragHover.accepted === 1
            ? 'The image will be added to this script.'
            : `${dragHover.accepted} files will be added to this script.`}
        {:else if dragHover.accepted === 1}
          The file will be added to your library and opened.
        {:else}
          {dragHover.accepted} files will be added to your library.
        {/if}
      </p>
    </div>
  </div>
{/if}

<style>
  /*
   * The seam under the native titlebar.
   *
   * Tauri gives every macOS window `NSWindowStyleMaskFullSizeContentView` (see
   * `windows/present.rs`), so the titlebar is transparent and what shows through
   * it is this app's own `--bg-app`. macOS insets the PAGE CONTENT below the
   * titlebar while the canvas keeps painting the full window height — so the
   * strip above `.shell` is warm paper, `.shell` starts at the titlebar's bottom
   * edge, and the window reads as one undivided surface with the traffic lights
   * floating in it and nothing to say where the chrome ends.
   *
   * A border on `.shell` therefore lands exactly on that boundary without
   * anybody having to know the titlebar's height — which is just as well,
   * because it is not a number the page can read and it is not the same number
   * on every macOS release (32px on this one, 28px on older ones). If a future
   * webview stops applying the inset, the line degrades to a hairline along the
   * top of the window rather than to a misplaced rule.
   */
  .shell {
    display: flex;
    height: 100%;
    border-top: 1px solid var(--border-seam);
    background: var(--bg-app);
    color: var(--text-primary);
    transition: background var(--dur-slow) var(--ease-out);
  }

  /*
   * No seam during a take: the window has no titlebar then (the style mask is
   * rewritten for the length of the take), so the line would have nothing to
   * separate — it would just be a grey hairline across the top of the glass.
   */
  :global(html[data-presenting='true']) .shell {
    border-top-color: transparent;
  }

  .content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /*
   * Opaque black, over everything, and NOT animated.
   *
   * A fade would defeat the point: the frames it faded through are the ones
   * that show the half-painted window. It appears instantly, the geometry moves
   * behind it, and it is removed only once whatever comes next has painted —
   * so the cut happens between two settled pictures, which is the one kind of
   * cut nobody notices.
   *
   * The z-index clears the toast region and the dialog host deliberately. A
   * toast raised during the transition is still there when the cover drops, and
   * a toast painted over a window that is mid-resize is exactly the artifact
   * being removed.
   */
  .present-cover {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: #000;
    pointer-events: none;
  }

  /*
   * The drop target.
   *
   * A wash and an inset dashed rule rather than a solid panel: the user needs to
   * see WHERE they are dropping, which means seeing the window underneath. The
   * rule is inset by a comfortable margin so it reads as "into this window"
   * rather than as a border that has appeared around the content.
   */
  .drop-target {
    position: fixed;
    inset: 0;
    z-index: 9000;
    display: grid;
    place-items: center;
    pointer-events: none;
    background: color-mix(in srgb, var(--bg-app) 72%, transparent);
    box-shadow: inset 0 0 0 2px var(--accent);
    /* A dashed inset rule, drawn without a second element. */
    outline: 2px dashed var(--accent);
    outline-offset: -12px;
  }
  .drop-target.rejecting {
    box-shadow: inset 0 0 0 2px var(--border-strong);
    outline-color: var(--border-strong);
  }

  .drop-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-5) var(--space-8);
    text-align: center;
  }
  .drop-title {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }
  .drop-body {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .boot {
    flex: 1;
    display: grid;
    place-items: center;
  }
  .boot-mark {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-muted);
  }

  /*
   * Bounded and centred rather than full-bleed: this is a short piece of prose
   * somebody has to read carefully and then act on, and a measure that runs the
   * width of a monitor is one nobody reads carefully.
   */
  .boot-failure {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    max-width: 44ch;
    padding: var(--space-8);
    text-align: center;
  }
  .boot-failure-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }
  .boot-failure-body {
    margin: 0;
    color: var(--text-primary);
  }
  .boot-failure-note {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
</style>
