<!--
  Control window shell (spec §10, §45.1): store-based route machine, library
  sidebar while browsing/editing, Editor → Live in one press (there is no
  screen between them — see lib/start-take.ts), workspace theme at rest and
  studio theme during Live.
-->
<script lang="ts">
  import { onMount } from 'svelte';
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
  import { installShortcuts, onShortcut } from './lib/shortcuts';
  import { initAudioTrace } from './services/audio-trace';
  import { initAppStatus } from './stores/app-status';
  import { requestConfirm } from './stores/confirm';
  import { saveNow } from './stores/editor';
  import { loadLibrary } from './stores/library';
  import { awaitViewportSettled, exitPresentation, painted } from './services/control-window';
  import { canvasIsBlack, coverIsUp, presentingPhase, setPresentingPhase } from './stores/presenting';
  import { navigate, registerNavigationGuard, route, setInitialRoute } from './stores/router';
  import { clearSession, session, stopSession } from './stores/session';
  import { loadSettings } from './stores/settings';

  let ready = $state(false);
  let shortcutsOpen = $state(false);

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
    const teardownShortcuts = installShortcuts();
    const teardownHelp = onShortcut((action) => {
      if (action === 'command-help') shortcutsOpen = true;
    });

    /* Leaving an active live session requires an explicit stop (spec §45.1). */
    const unregisterLiveGuard = registerNavigationGuard(async (to, from) => {
      if (from.name === 'live' && to.name !== 'live' && $session.active) {
        const accepted = await requestConfirm({
          title: 'Stop the session?',
          body: 'Leaving Live stops the session: the realtime connection closes and the stage leaves full screen.',
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
          if (restored) await awaitViewportSettled(restored);
        } finally {
          setPresentingPhase('off');
        }
      }
      return true;
    });

    /* Flush any pending editor autosave when navigating away (spec §13.5). */
    const unregisterSaveGuard = registerNavigationGuard(async (_to, from) => {
      if (from.name === 'editor') await saveNow();
      return true;
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
       */
      await exitPresentation().catch(() => {});
      setPresentingPhase('off');

      const status = await initAppStatus();
      await loadSettings();
      await loadLibrary();
      setInitialRoute(status.firstLaunch ? { name: 'welcome' } : { name: 'library', view: 'all' });
      ready = true;
    })();

    return () => {
      teardownShortcuts();
      teardownHelp();
      unregisterLiveGuard();
      unregisterSaveGuard();
    };
  });

  async function newScriptFromSidebar(): Promise<void> {
    await createAndOpenScript('new');
  }
</script>

<div class="shell" data-theme={theme}>
  {#if !ready}
    <div class="boot">
      <p class="boot-mark">CandidCue</p>
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
</style>
