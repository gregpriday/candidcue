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
  import ShortcutsDialog from './components/ShortcutsDialog.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import ToastRegion from './components/ToastRegion.svelte';
  import Editor from './routes/Editor.svelte';
  import Library from './routes/Library.svelte';
  import Live from './routes/Live.svelte';
  import Settings from './routes/Settings.svelte';
  import Calibrate from './routes/Calibrate.svelte';
  import Welcome from './routes/Welcome.svelte';
  import { createAndOpenScript } from './lib/app-actions';
  import {
    STOP_SESSION_CONFIRM_BODY,
    editorNavigationDecision,
    initialRouteForBoot,
    isFatalBootCode,
    recentScriptIdForBoot,
  } from './lib/app-lifecycle';
import { rememberReaderFrame } from './lib/reader-frame';
  import { installShortcuts, onShortcut } from './lib/shortcuts';
  import { initAudioTrace } from './services/audio-trace';
  import { exportSupportBundle } from './services/diagnostics';
  import { describeError, errorCode } from './services/errors';
  import { listScripts } from './services/scripts';
  import { defaultAppSettings } from './services/settings-types';
  import { initAppStatus } from './stores/app-status';
  import { requestConfirm } from './stores/confirm';
  import { editor, editorHasUnsavedWork, saveNow } from './stores/editor';
  import { loadLibrary } from './stores/library';
  import { awaitViewportSettled, exitPresentation, painted } from './services/control-window';
  import { canvasIsBlack, coverIsUp, presentingPhase, setPresentingPhase } from './stores/presenting';
  import { navigate, registerNavigationGuard, route, setInitialRoute } from './stores/router';
  import { clearSession, session, stopSession } from './stores/session';
  import { loadSettings } from './stores/settings';
  import { showToast } from './stores/toasts';

  let ready = $state(false);
  let shortcutsOpen = $state(false);

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
   * Calibration keeps the sidebar.
   *
   * It is a settings flow — reached from Settings, and returning there when it
   * finishes — so hiding the chrome would strand somebody mid-wizard with no
   * way out but the window controls. Only the take hides navigation, and it
   * does so because a presenter is reading.
   */
  const showSidebar = $derived(
    $route.name === 'library' ||
      $route.name === 'editor' ||
      $route.name === 'settings' ||
      $route.name === 'calibrate',
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

  onMount(() => {
    // §30.1 triage. Off unless the operator switched it on for this window;
    // see audio-trace.ts for why the audio path needs it at all.
    initAudioTrace();
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
        const accepted = await requestConfirm({
          title: 'Stop the session?',
          body: STOP_SESSION_CONFIRM_BODY,
          confirmLabel: 'Stop session',
          danger: true,
        });
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

    return () => {
      disposed = true;
      teardownShortcuts();
      teardownHelp();
      unregisterLiveGuard();
      unregisterSaveGuard();
    };
  });

  async function newScriptFromSidebar(): Promise<void> {
    await createAndOpenScript('new');
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
  {#if !ready}
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
    {#if showSidebar}
      <Sidebar onnew={() => void newScriptFromSidebar()} onshortcuts={() => (shortcutsOpen = true)} />
    {/if}
    <main class="content">
      {#if $route.name === 'welcome'}
        <Welcome />
      {:else if $route.name === 'library'}
        <Library />
      {:else if $route.name === 'editor'}
        <Editor scriptId={$route.scriptId} />
      {:else if $route.name === 'live'}
        <Live sessionId={$route.sessionId} scriptId={$route.scriptId} />
      {:else if $route.name === 'settings'}
        <Settings section={$route.section} />
      {:else if $route.name === 'calibrate'}
        <Calibrate displayFingerprint={$route.displayFingerprint} rigName={$route.rigName} />
      {:else}
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
