<!--
  Control window shell (spec §10, §45.1): store-based route machine, library
  sidebar while browsing/editing, contextual Editor → Preflight → Live
  transitions, workspace theme at rest and studio theme during Live.
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
  import Preflight from './routes/Preflight.svelte';
  import Settings from './routes/Settings.svelte';
  import Welcome from './routes/Welcome.svelte';
  import { createAndOpenScript } from './lib/app-actions';
  import { installShortcuts, onShortcut } from './lib/shortcuts';
  import { initAudioTrace } from './services/audio-trace';
  import { initAppStatus } from './stores/app-status';
  import { requestConfirm } from './stores/confirm';
  import { saveNow } from './stores/editor';
  import { loadLibrary } from './stores/library';
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
  const showSidebar = $derived(
    $route.name === 'library' || $route.name === 'editor' || $route.name === 'settings',
  );

  /* Keep the document root in sync so scrollbars/body match the shell. */
  $effect(() => {
    document.documentElement.dataset['theme'] = theme;
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
        stopSession();
        clearSession();
      }
      return true;
    });

    /* Flush any pending editor autosave when navigating away (spec §13.5). */
    const unregisterSaveGuard = registerNavigationGuard(async (_to, from) => {
      if (from.name === 'editor') await saveNow();
      return true;
    });

    void (async () => {
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
      {:else if $route.name === 'preflight'}
        <Preflight scriptId={$route.scriptId} />
      {:else if $route.name === 'live'}
        <Live sessionId={$route.sessionId} scriptId={$route.scriptId} />
      {:else if $route.name === 'settings'}
        <Settings section={$route.section} />
      {/if}
    </main>
  {/if}

  <ToastRegion />
  <ConfirmHost />
  <ShortcutsDialog open={shortcutsOpen} onclose={() => (shortcutsOpen = false)} />
</div>

<style>
  .shell {
    display: flex;
    height: 100%;
    background: var(--bg-app);
    color: var(--text-primary);
    transition: background var(--dur-slow) var(--ease-out);
  }

  .content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
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
