<!--
  The Settings window's shell (desktop refinement §14.1).

  ---------------------------------------------------------------------------
  WHAT IT IS AND IS NOT
  ---------------------------------------------------------------------------
  It hosts two surfaces and nothing else: Settings, and the calibration wizard
  Settings launches. There is no library, no editor and no session here — this
  window cannot present.

  That does NOT make the editor and session commands absent: the menu bar is
  shared by the whole application, and `menu.rs` delivers each command to the
  window in front. So this window receives them, and deals with them the only
  honest way — by greying them while it is focused (`PREFERENCES_COMMANDS`) and
  ignoring any that arrive anyway. An earlier version of this comment claimed
  they were absent "by construction"; they were not, and ⌘W closed the document
  window behind this one.

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
  import {
    closePreferences,
    installMenuStateOnFocus,
    focusAppWindow,
    installWindowMenuCommands,
    PREFERENCES_COMMANDS,
    pushWindowMenuState,
    revealLogs,
  } from '../control/services/desktop-shell';
  import { describeError } from '../control/services/errors';
  import {
    installOverlaySync,
    installSettingsSectionSync,
    installSettingsSync,
  } from '../control/services/settings-sync';
  import { navigate, route, setInitialRoute } from '../control/stores/router';
  import { loadSettings } from '../control/stores/settings';
  import { showToast } from '../control/stores/toasts';
  import { isSettingsSection } from '../control/lib/commands';
  import { SETTINGS_OVERLAY_KEY } from '../control/services/settings';
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

    /*
     * "Show me Privacy" while this window is ALREADY open.
     *
     * The section is read from the workspace store on mount, which covers
     * opening the window. It does not cover being asked for a section when the
     * window exists — Rust brings it forward and nothing mounts, so without
     * this the Welcome screen's privacy link would raise a window still showing
     * whatever section it was left on.
     */
    const teardownSection = installSettingsSectionSync((section) => {
      navigate({ name: 'settings', section });
    });

    /*
     * Overlay settings, which never reach Rust.
     *
     * Stage font and stage type size are composed into the settings document
     * from a `localStorage` overlay (`services/settings.ts`), not written to the
     * database — so `settings://changed` says nothing about them and this window
     * would keep showing what it read at launch. `localStorage` raises a
     * `storage` event in the OTHER documents of the origin, which is exactly
     * this case; re-reading composes the document again from Rust plus the
     * overlay as it now stands.
     *
     * The WORKSPACE store is deliberately not watched. It holds this window's
     * own pane geometry, and adopting another window's layout would move panes
     * under the user's hands.
     */
    const teardownOverlay = installOverlaySync([SETTINGS_OVERLAY_KEY], () => {
      void loadSettings(true).catch((err: unknown) => {
        console.debug('settings could not be re-read after an overlay change', err);
      });
    });

    /*
     * THE MENU BAR, WHILE THIS WINDOW IS IN FRONT.
     *
     * `menu.rs` delivers a menu command to the focused window, so this one
     * really does receive Save, Present and Insert › Link when it is the window
     * the user is looking at. Answering only what Settings can answer — and
     * greying the rest — is what stops ⌘W from closing the document window
     * behind this one and Insert from writing Markdown into a hidden editor.
     *
     * The state is pushed again on every focus change because the menu is one
     * shared object: whichever window last spoke is the one it describes, and
     * that has to be the window in front rather than the window that most
     * recently changed its mind.
     */
    const pushState = () => void pushWindowMenuState(PREFERENCES_COMMANDS);
    pushState();
    const teardownFocus = installMenuStateOnFocus(pushState);
    const teardownMenu = installWindowMenuCommands({
      /* ⌘W. Its label reads "Close Window" off the editor, and this is the
         window it is pressed over. */
      'file.close-script': close,
      'window.main': () => void focusAppWindow('control'),
      'window.stage': () => void focusAppWindow('stage'),
      /* ⌘F — the toolbar's Search settings field. The registry calls this
         `edit.find` in every window; what it finds differs. */
      'edit.find': () => {
        document
          .querySelector<HTMLInputElement>('input[type="search"][aria-label="Search settings"]')
          ?.focus();
      },
      /* ⌘, with Settings already open is "bring Settings forward", and it
         already is. Answered rather than ignored so the chord is not silently
         dead in the one window it names. */
      'view.settings': () => {},
      'window.settings': () => {},
      'help.reveal-logs': () => {
        void revealLogs().catch((err: unknown) => {
          showToast(`The log folder could not be opened. ${describeError(err)}`, 'danger');
        });
      },
      /* Rust delivers this to the document window, where the update notice
         lives (`menu.rs::CONTROL_ROUTED_COMMANDS`). Should it ever arrive here
         instead, bringing that window forward is the honest half of it. */
      'help.check-for-updates': () => void focusAppWindow('control'),
    });

    void (async () => {
      try {
        await loadSettings();
        /*
         * Open on the section the user was last in (§14.4). The workspace store
         * is `localStorage`, which IS shared across webviews of the same origin.
         *
         * `openSettingsWindow` flushes the section synchronously before asking
         * Rust to open the window — the workspace store's writes are debounced,
         * and without that flush "Settings › Privacy" from the Welcome screen
         * opened on whatever section was last read here. Read once, on mount:
         * a window that is ALREADY open is told which section to show by
         * `SETTINGS_SECTION_EVENT` instead, because it will not mount again.
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

    return () => {
      teardownSync();
      teardownSection();
      teardownOverlay();
      teardownFocus();
      teardownMenu();
    };
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
