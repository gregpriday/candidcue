<!--
  The Settings window's shell (desktop refinement §14.1).

  ---------------------------------------------------------------------------
  WHAT IT IS AND IS NOT
  ---------------------------------------------------------------------------
  It hosts two surfaces and nothing else: Settings, and the calibration wizard
  Settings launches. There is no library, no editor and no session here — this
  window cannot present, and every command that would need one is absent from
  it by construction rather than by being disabled.

  Calibration comes WITH Settings rather than staying behind in the control
  window, and that is the arrangement the control shell's own comment already
  argued for: "it is a settings flow — reached from Settings, and returning
  there when it finishes". Splitting the two across windows would mean choosing
  Calibrate in one window and having a different one come forward.

  ---------------------------------------------------------------------------
  IT USES THE SHARED ROUTER, SCOPED TO THIS WEBVIEW
  ---------------------------------------------------------------------------
  `stores/router.ts` is a module singleton, and a module singleton in a separate
  webview is a separate instance — so navigating here does not move the control
  window and vice versa. That is what lets `Settings.svelte` keep calling
  `navigate({ name: 'calibrate', … })` unchanged.

  The one route this window cannot render is `library`, which is what Settings'
  old back control navigated to. It is a CLOSE here instead: there is nowhere to
  go back to, because opening Settings never took you anywhere.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import ConfirmHost from '../control/components/ConfirmHost.svelte';
  import ToastRegion from '../control/components/ToastRegion.svelte';
  import Calibrate from '../control/routes/Calibrate.svelte';
  import Settings from '../control/routes/Settings.svelte';
  import { closePreferences } from '../control/services/desktop-shell';
  import { describeError } from '../control/services/errors';
  import { installSettingsSync } from '../control/services/settings-sync';
  import { route, setInitialRoute } from '../control/stores/router';
  import { loadSettings } from '../control/stores/settings';
  import { showToast } from '../control/stores/toasts';
  import { isSettingsSection } from '../control/lib/commands';
  import { workspace } from '../control/stores/workspace';

  let ready = $state(false);
  let failure = $state<string | null>(null);

  onMount(() => {
    /*
     * Adopt changes made in the OTHER window.
     *
     * Two webviews, two copies of the settings store. Rust broadcasts the whole
     * revisioned document after every successful write (`settings://changed`),
     * and this is what makes this window notice one — without it, a preference
     * changed from a Live-route control would leave this window editing against
     * a revision that no longer exists, and the next save here would fail its
     * optimistic-concurrency check for reasons the user could not see.
     */
    const teardownSync = installSettingsSync();

    void (async () => {
      try {
        await loadSettings();
        /*
         * Open on the section the user was last in (§14.4). The workspace store
         * is `localStorage`, which IS shared across webviews of the same origin
         * — so the section the control window recorded is the section this
         * window opens at, with no IPC and no coordination.
         */
        const stored = $workspace.settingsSection;
        setInitialRoute({
          name: 'settings',
          section: isSettingsSection(stored) ? stored : 'general',
        });
        ready = true;
      } catch (err) {
        failure = describeError(err);
      }
    })();

    return teardownSync;
  });

  function close(): void {
    void closePreferences().catch((err: unknown) => {
      showToast(`This window could not be closed. ${describeError(err)}`, 'danger');
    });
  }
</script>

<!--
  A NAMED main landmark (§23.2).

  This window has a section rail and a toolbar of its own, so its content region
  needs a name for the same reason the control window's does — "jump to main"
  should say where it landed. It is also what makes the window sweepable by the
  route-health suite, which asks every window whether it rendered anything at
  all by looking for its main region.
-->
<main class="shell" aria-label="Settings">
  {#if failure !== null}
    <!--
      Settings that will not load is not a reason to show an empty window. It
      names the failure and offers the way out, which is the same shape the
      control window's boot failure takes.
    -->
    <section class="failure" role="alert">
      <h1 class="failure-title">Settings could not be loaded</h1>
      <p class="failure-body">{failure}</p>
      <p class="failure-note">Close this window and try again.</p>
    </section>
  {:else if !ready}
    <div class="loading" role="status">
      <p>Loading settings…</p>
    </div>
  {:else if $route.name === 'calibrate'}
    <Calibrate displayFingerprint={$route.displayFingerprint} rigName={$route.rigName} />
  {:else if $route.name === 'settings'}
    <Settings section={$route.section} onclose={close} />
  {:else}
    <!--
      Any other route is `Settings.svelte`'s old "back to the library" — a
      destination this window does not have. Closing is what that gesture means
      here, and doing it rather than painting an empty shell means the control
      goes on working without Settings having to know which window it is in.
    -->
    <Settings section="general" onclose={close} />
  {/if}

  <ToastRegion />
  <ConfirmHost />
</main>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-app);
    color: var(--text-primary);
  }

  .loading,
  .failure {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-8);
    text-align: center;
  }
  .loading p {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .failure-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 650;
    letter-spacing: var(--ls-title);
  }
  .failure-body {
    margin: 0;
    max-width: 44ch;
  }
  .failure-note {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
</style>
