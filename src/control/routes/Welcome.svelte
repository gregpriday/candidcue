<!--
  First-launch welcome (spec §9.1, copy from Appendix F.1). Restrained: no
  account creation, no promotional imagery; the user can postpone setup.

  The two readiness lines used to be prose. They named the only two things that
  have to be true before a take works and then offered no way to do either, so
  a microphone that was never granted or a prompter panel that is no longer
  plugged in was discovered at Present — after the writing, which is the
  expensive place to find out. They now report what is actually true and link
  to the control that fixes it.

  THIS IS NOT A PREFLIGHT GATE. Nothing here disables a CTA, blocks Present, or
  prompts for hardware; the rows are a readout plus a link. The app deliberately
  has no blocking readiness step, and re-growing one on the first screen would
  be the same mistake in a friendlier place.

  Tone is load-bearing and easy to get wrong: on a genuine first launch the
  microphone has NEVER been granted, so `microphoneGranted` is false for every
  new user. Painting that yellow would mean the first thing anybody sees is a
  screen reporting a fault, when what it is really reporting is "you have not
  done this yet". Expected setup is accent-toned. Warning is reserved for a rig
  that has actually degraded — a display that was chosen and is now unplugged —
  which is the one case here where something known-good stopped being true.

  None of these states claim the rig WORKS. `microphoneGranted` records that a
  grant was once made, and enumerating a panel is not the same as having read
  from it, so the labels say the narrow thing each check actually proves
  ("Access allowed", "Connected") rather than a green "Ready".
-->
<script lang="ts">
  import { openSettingsWindow } from '../lib/open-settings';
  import BrandMark from '../components/BrandMark.svelte';
  import Button from '../components/Button.svelte';
  import Icon from '../components/Icon.svelte';
  import SpeechLanguagePicker from '../components/SpeechLanguagePicker.svelte';
  import StatusPill, { type PillTone } from '../components/StatusPill.svelte';
  import { createAndOpenScript, importMarkdown } from '../lib/app-actions';
  import { displayName, resolvePrompterDisplay } from '../lib/take-destination';
  import * as stageService from '../services/stage';
  import {
    isBusy as isModelBusy,
    isDamaged as isModelDamaged,
    phaseLabel,
    type SpeechModelStatus,
  } from '../services/speech-models';
  import type { DisplayDescriptor } from '../services/stage-types';
  import { markWelcomed } from '../stores/app-status';
  import { navigate, type SettingsSection } from '../stores/router';
  import { openPreferences } from '../services/desktop-shell';
  import { updateWorkspace } from '../stores/workspace';
  import { describeError } from '../services/errors';
  import { showToast } from '../stores/toasts';
  import { loadSettings, settings } from '../stores/settings';

  /**
   * Connected displays are not part of the boot sequence, so unlike the
   * settings document this screen has to go and ask. `checking` is a real
   * state rather than an empty list: "no displays yet" and "no displays"
   * look identical in an array and mean opposite things.
   *
   * `windowDisplay` is the panel this window is on, which is where a prompter
   * take opens whenever nothing pinned is connected (#302). Null when it could
   * not be named — that is "unknown", not a failed probe.
   */
  type DisplayProbe =
    | { kind: 'checking' }
    | { kind: 'loaded'; displays: DisplayDescriptor[]; windowDisplay: DisplayDescriptor | null }
    | { kind: 'failed' };

  let probe = $state<DisplayProbe>({ kind: 'checking' });

  $effect(() => {
    // The reply must not land on an unmounted screen: this runs on the first
    // paint of a first launch, which is exactly when somebody is most likely
    // to click straight through to the editor.
    let live = true;
    // And an older read must not land over a newer one.
    let request = 0;
    const read = async (): Promise<void> => {
      const mine = ++request;
      try {
        const [displays, windowDisplay] = await Promise.all([
          stageService.listDisplays(),
          stageService.currentWindowDisplay().catch(() => null),
        ]);
        if (live && mine === request) probe = { kind: 'loaded', displays, windowDisplay };
      } catch {
        // Deliberately not surfaced in detail. Stage settings already reports
        // the enumeration error properly and offers a retry; repeating it here
        // would put a stack-shaped message on the welcome screen.
        if (live && mine === request) probe = { kind: 'failed' };
      }
    };
    void read();
    /*
     * Asked again when a monitor comes or goes, or this window is dragged to
     * another one — Rust reports both on one event — because either can change
     * where an unpinned take opens. Not on focus: that would re-ask every time
     * somebody clicked back into the app, for an answer only a move changes.
     */
    const stopWatching = stageService.watchDisplayChanges(() => void read());
    return () => {
      live = false;
      stopWatching();
    };
  });

  /*
   * The microphone answer is a plain settings read, and must stay one.
   *
   * WKWebView does not implement `navigator.permissions.query({name:'microphone'})`,
   * so a live query reports 'unsupported' on the one platform that ships. macOS
   * grants the microphone to the APPLICATION, so the grant genuinely survives;
   * only the webview's ability to see it is missing. `audio.microphoneGranted`
   * is the record of that grant — the same source Settings falls back to, and
   * the reason this screen never calls getUserMedia or enumerates devices.
   */
  const micGranted = $derived($settings.audio.microphoneGranted);

  const readerMode = $derived($settings.stage.presentationMode === 'reader');
  const chosenFingerprint = $derived($settings.stage.displayFingerprint);
  const connectedDisplays = $derived(probe.kind === 'loaded' ? probe.displays : []);
  const windowDisplay = $derived(probe.kind === 'loaded' ? probe.windowDisplay : null);
  /**
   * Where a prompter take would actually land, by Present's own rule: the
   * pinned panel when it is connected, otherwise the panel this window is on.
   *
   * Not `chooseStageDisplay`, which this used to be. That is the preview
   * target, and it prefers an external display — so a first-run user with a
   * second monitor read here that takes open on it, pressed Present, and
   * watched the monitor in front of them become the prompter (#302).
   */
  const destination = $derived(
    resolvePrompterDisplay({
      displays: connectedDisplays,
      pinnedFingerprint: chosenFingerprint,
      windowDisplay,
    }),
  );
  /**
   * A pinned display that is not currently connected (§52 fingerprints), the
   * same predicate Stage settings shows its inline alert from. A fingerprint is
   * panel identity, so an unplugged display simply stops matching and the take
   * opens on the panel this window is on instead.
   */
  const pinnedMissing = $derived(
    probe.kind === 'loaded' && connectedDisplays.length > 0 && destination.reason === 'pin-missing',
  );
  /** The fallback, named — or described, when the OS could not name it. */
  const windowPanel = $derived(
    windowDisplay === null
      ? 'the display the CandidCue window is on'
      : `${displayName(windowDisplay)}, where the CandidCue window is`,
  );

  interface RowState {
    tone: PillTone;
    pill: string;
    detail: string;
    /** Only 'attention' tints the row; expected setup is accent, faults warn. */
    emphasis: 'quiet' | 'setup' | 'attention';
    /** The fix control's label. Speech has none while its picker is the action. */
    action?: string;
  }

  const micState = $derived<RowState>(
    micGranted
      ? {
          tone: 'neutral',
          // Deliberately past tense, in the PILL as much as the sentence. The
          // flag records that a grant was made on this machine; it is not
          // cleared when the grant is revoked in System Settings or when the
          // device is unplugged, so it cannot support a claim about right now.
          // A status capsule reads as current state, so "Access allowed" was
          // the same overclaim as "CandidCue can hear you" in the more
          // prominent of the two places — and both would have been the
          // confident wrong answer in exactly the cases somebody most needs a
          // true one.
          pill: 'Previously allowed',
          detail: 'Access was allowed on this computer. Test the level before a real take.',
          emphasis: 'quiet',
          action: 'Test microphone',
        }
      : {
          tone: 'accent',
          pill: 'Set up',
          detail: 'Choose a microphone and check the level. Nothing is recorded.',
          emphasis: 'setup',
          action: 'Set up microphone',
        },
  );

  const displayState = $derived<RowState>(resolveDisplayState());

  /**
   * The speech model is a download now (#152), so first run has to say so.
   *
   * This row LINKS to Settings rather than carrying its own Download button.
   * The install is a state machine — progress, verification, unpacking, cancel,
   * failure, retry — and running it from two screens means two copies of that
   * logic drifting apart. One place owns it; this says whether it has happened.
   *
   * Non-blocking, like every other row here: writing, importing and the stage
   * all work without a recogniser. Only voice following needs one.
   */
  /**
   * Reported BY the picker below, not fetched here.
   *
   * This row used to keep its own snapshot and its own listener, and both were
   * wrong once more than one model could be installed: `getSpeechModelStatus()`
   * with no argument asks about the CATALOGUE DEFAULT rather than the selected
   * language, and the listener accepted a progress event for any model at all —
   * so downloading an inactive language moved a row describing the active one.
   * The picker already owns that state machine; one owner, one answer.
   */
  let modelStatus = $state<SpeechModelStatus | null>(null);

  const speechState = $derived<RowState>(resolveSpeechState());

  /*
   * No fix link on this row. Every state that needs doing is done in the picker
   * beneath it — Download, Stop, Download again — and a link to Settings › Speech
   * beside it was a second door into the same component, one that also took you
   * away from the screen.
   *
   * The details are short because the picker states the rest: the language in
   * use, the sizes, what is missing. This line only says why the step exists.
   */
  function resolveSpeechState(): RowState {
    if (!modelStatus) {
      return {
        tone: 'neutral',
        pill: 'Checking…',
        detail: 'Looking for the speech model.',
        emphasis: 'quiet',
      };
    }
    if (isModelBusy(modelStatus)) {
      return {
        tone: 'neutral',
        pill: phaseLabel(modelStatus),
        // Phase-neutral: the pill already names the phase, and "installing"
        // under a pill reading "Downloading" was two answers to one question.
        detail: 'You can carry on writing while this finishes.',
        emphasis: 'quiet',
      };
    }
    if (modelStatus.installed) {
      return {
        tone: 'neutral',
        pill: 'Installed',
        // The narrow claim, like every other row: the files are here. Whether
        // a take follows also needs a microphone, which this row cannot see.
        detail: 'Speech data is installed. Transcription happens on this machine.',
        emphasis: 'quiet',
      };
    }
    if (isModelDamaged(modelStatus)) {
      // Not "Set up": this machine DID download it, and calling it a one-time
      // download not yet done would be wrong on both counts (#258). A fault, so
      // it warns: the accent is for expected setup, and must not read as one.
      return {
        tone: 'warning',
        pill: 'Damaged',
        detail: 'Download it again to restore voice following. Writing works without it.',
        emphasis: 'setup',
      };
    }
    return {
      tone: 'accent',
      pill: 'Set up',
      detail: 'Voice following needs a one-time download. Writing works without it.',
      emphasis: 'setup',
    };
  }

  /**
   * Whether the picker is on screen.
   *
   * Folded only when the active language is KNOWN to be installed. What is
   * left in it then is a language switch and a Remove button, which on a
   * first-run checklist made one finished item four times the height of its
   * neighbours — so it waits behind "Change language" instead.
   *
   * Every other answer shows it, unknown included: the download, the progress
   * and Stop, and the repair all live in it, and so do its own load error and
   * Try again. Folding while the status was still unknown would hide exactly
   * the screen that explains why it never became known.
   *
   * Folded, never unmounted. The picker is what reports `modelStatus` to this
   * row, so taking it out of the tree would freeze the row on its last answer.
   */
  let speechExpanded = $state(false);
  const speechNeedsAction = $derived(modelStatus !== null && !modelStatus.installed);
  const pickerOpen = $derived(speechExpanded || !modelStatus?.installed);

  /*
   * Once it has been open because something needed doing, it STAYS open. A
   * download finishing must not fold the panel out from under somebody who is
   * still looking at it — or who has focus in its language select — and
   * shrink the screen around them. They fold it themselves; only a launch that
   * finds the data already installed starts folded.
   */
  $effect(() => {
    if (speechNeedsAction) speechExpanded = true;
  });

  function resolveDisplayState(): RowState {
    if (readerMode) {
      // Reader mode presents in an ordinary window at desk distance, so there
      // is no second panel to choose and nothing here to be wrong. The action
      // must not say "Choose display" either: a reading window ignores the
      // pin entirely, so it would offer a choice nothing reads.
      return {
        tone: 'neutral',
        pill: 'This window',
        detail: 'Reader mode presents in this window. No second screen needed.',
        emphasis: 'quiet',
        action: 'Stage settings',
      };
    }
    if (probe.kind === 'checking') {
      return {
        tone: 'neutral',
        pill: 'Checking…',
        detail: 'Looking for connected displays.',
        emphasis: 'quiet',
        action: 'Choose display',
      };
    }
    // A failed enumeration and an empty one are one state on this screen: both
    // mean CandidCue cannot say which panel the prompt will open on, and the
    // fix for both is the same screen.
    if (probe.kind === 'failed' || connectedDisplays.length === 0) {
      return {
        tone: 'neutral',
        pill: 'Couldn’t check',
        detail: 'CandidCue could not list the connected displays. Takes still open.',
        emphasis: 'quiet',
        action: 'Choose display',
      };
    }
    if (pinnedMissing) {
      return {
        tone: 'warning',
        pill: 'Needs attention',
        detail: `The display you chose is not connected. Until it is back, takes open on ${windowPanel}.`,
        emphasis: 'attention',
        action: 'Fix display',
      };
    }
    if (destination.reason === 'pinned') {
      return {
        tone: 'neutral',
        pill: 'Connected',
        detail: `Takes open on ${displayName(destination.display)}.`,
        emphasis: 'quiet',
        action: 'Choose display',
      };
    }
    return {
      tone: 'neutral',
      pill: 'Automatic',
      detail: `Takes open on ${windowPanel}.`,
      emphasis: 'quiet',
      action: 'Choose display',
    };
  }

  /*
   * Neither fix-link marks the welcome seen.
   *
   * Going to look at a setting is not finishing onboarding, and the actions
   * that DO mean "I have started" already mark it: creating a script, a
   * successful import, and the explicit skip to the library. So somebody who
   * opens the microphone screen and quits still gets this screen back next
   * launch, which is the honest outcome — they have not started yet.
   */
  /*
   * The readiness rows open the SETTINGS WINDOW (§14.1), at their own section.
   *
   * They used to navigate the control window to the Settings route, which is
   * exactly the trip §16.1 asks a setup assistant not to make: somebody halfway
   * through getting ready is sent to another screen and has to find their way
   * back. Now the window opens beside the checklist and closing it leaves them
   * where they were, with the row they came to fix visibly answered.
   *
   * Through the shared `openSettingsWindow` rather than doing it here.
   *
   * This used to write the section and call `openPreferences` itself, which
   * looked equivalent and was missing both halves that make the handoff work:
   * the workspace store's writes are debounced by 250 ms and the window mounts
   * faster than that, so the section arrived too late to be read — and a window
   * that was already open never re-read it at all, so choosing Microphone
   * brought Settings forward on whatever section it was last left on.
   */
  function openSettingsAt(section: SettingsSection): void {
    void openSettingsWindow(section);
  }

  function openMicrophoneSettings(): void {
    openSettingsAt('audio');
  }

  function openDisplaySettings(): void {
    openSettingsAt('stage');
  }

  function skipToLibrary(): void {
    markWelcomed();
    void navigate({ name: 'library', view: 'all' });
  }

  function openPrivacy(): void {
    /* The Settings WINDOW (§14.1). Navigating here reached a route this window
       no longer renders, which fell through to the Library. */
    void openSettingsWindow('privacy');
  }
</script>

<!--
  Two regions, side by side: starting a script on the left, setting up for a
  take on the right.

  This was one centred column — a hero, a row of buttons, then the checklist
  stacked under them — which is a landing page's rhythm around what is really a
  setup utility. It left most of a desktop window empty at the sides and pushed
  the speech download, the privacy link and the way out to the library below the
  fold at every window size. Side by side, both answers are on screen at once,
  and nothing in the setup column can push the way in further down.
-->
<div class="welcome">
  <div class="inner">
    <section class="start" aria-labelledby="welcome-heading">
      <div class="intro">
        <!-- The one place in the window the mark appears: the sidebar gave
             its tile up (it read as a microphone button), and the app icon is
             what carries the identity everywhere else. -->
        <p class="wordmark"><BrandMark size={22} /><span>CandidCue</span></p>
        <h1 id="welcome-heading" class="heading">Speak naturally. Keep your place.</h1>
        <p class="body">
          CandidCue is a voice-following teleprompter for your second screen. Write or import a
          Markdown script, choose a microphone, and present while the text follows you.
        </p>
      </div>

      <h2 class="region-title">Start a script</h2>
      <!--
        §16.1: "Make 'Create a script' the primary action. Make 'Open sample'
        secondary."

        This was the other way round, and the reasoning was real: the sample is
        the only one of the three that hands back something written to be read
        ALOUD, and reading aloud is the only way to see what this app does. An
        empty script cannot demonstrate following.

        What settles it is which one is a DEAD END. Somebody who came here to
        write their own script and is offered a demo as the loudest thing on the
        screen has to decline it first; somebody who wanted the demo and is
        offered "Create" first loses nothing — the sample is right beside it,
        named, and one press away. The stronger argument was about teaching the
        product, and a setup assistant's job is to get out of the way.
      -->
      <div class="actions">
        <Button variant="primary" onclick={() => createAndOpenScript('new')}>
          Create your first script
        </Button>
        <!--
          The lesser two wrap TOGETHER. Left to wrap one at a time, the narrow
          window put Import alone on a second line, where a borderless button
          reads as a stray label rather than the third of a set.
        -->
        <span class="more-actions">
          <Button onclick={() => createAndOpenScript('sample')}>Open the sample script</Button>
          <!--
            Import is TERTIARY (§16.1): three equally weighted buttons is a screen
            asking a question rather than offering a way in. It is also the one of
            the three that a returning user reaches for, and they have File › Import
            Markdown and ⇧⌘I — so it costs nothing to make it the quietest here.
          -->
          <Button variant="ghost" onclick={() => importMarkdown()}>Import Markdown</Button>
        </span>
      </div>

      <!-- The way past all of this, directly under the ways in, so it is on
           screen whatever height the setup column has grown to. -->
      <p class="skip">
        <button type="button" class="link quiet" data-focus="control" onclick={skipToLibrary}>
          Go to the library
        </button>
      </p>
    </section>

    <section class="setup-panel" aria-labelledby="setup-heading">
      <header class="setup-header">
        <h2 id="setup-heading" class="region-title">Before your first take</h2>
        <p class="setup-note">Optional. You can write and import scripts without any of it.</p>
      </header>

      <!--
        `role="list"` is not redundant here. WebKit drops list semantics from a
        `<ul>` whose markers are styled away, and WebKit is the only engine this
        app ships in — without it VoiceOver reads three loose rows with no count.

        Each row is the same shape: title and status on one line, the sentence
        under them at the full width of the row, then the control that changes
        it. The status and its link used to share a right-hand column that never
        shrank, so a long display name was squeezed into a narrow strip beside it.
      -->
      <ul class="readiness" role="list">
        <li class="readiness-item" class:setup={micState.emphasis === 'setup'}>
          <div class="readiness-head">
            <h3 class="readiness-title">Microphone</h3>
            <StatusPill tone={micState.tone} label={micState.pill} />
          </div>
          <!-- Polite, like the rows below: this answer changes when Settings
               records a grant, and a sighted reader would see it change. -->
          <p class="readiness-detail" role="status" aria-live="polite">{micState.detail}</p>
          <button type="button" class="link" data-focus="control" onclick={openMicrophoneSettings}>
            {micState.action}
          </button>
        </li>

        <!--
          This row's state ARRIVES: it starts at "Checking…" and changes when the
          display probe answers. A sighted reader sees that happen; without a
          polite live region a screen reader is under no obligation to revisit a
          span it already passed, so the only readiness state on this screen that
          moves would be the one state never announced. Polite, not assertive —
          it must wait for a pause rather than interrupt the heading and CTAs
          somebody is still hearing for the first time.
        -->
        <li class="readiness-item" class:attention={displayState.emphasis === 'attention'}>
          <div class="readiness-head">
            <h3 class="readiness-title">Teleprompter screen</h3>
            <StatusPill tone={displayState.tone} label={displayState.pill} />
          </div>
          <p class="readiness-detail" role="status" aria-live="polite">{displayState.detail}</p>
          <button type="button" class="link" data-focus="control" onclick={openDisplaySettings}>
            {displayState.action}
          </button>
        </li>

        <!--
          §153: the language choice belongs HERE, at first run, alongside the
          other setup a good take needs — not behind a link to Settings. The
          header reports state (and, like the display row, that state ARRIVES
          over IPC, so the detail stays a polite live region); the picker beneath
          it is where the choice is actually made.

          Still not a gate. Writing, importing and the stage all work with no
          recogniser at all, and nothing here blocks a CTA.
        -->
        <li class="readiness-item" class:setup={speechState.emphasis === 'setup'}>
          <div class="readiness-head">
            <h3 class="readiness-title">Speech language</h3>
            <StatusPill tone={speechState.tone} label={speechState.pill} />
          </div>
          <p class="readiness-detail" role="status" aria-live="polite">{speechState.detail}</p>
          {#if modelStatus?.installed}
            <button
              type="button"
              class="link disclosure"
              data-focus="control"
              aria-expanded={speechExpanded}
              aria-controls="welcome-speech-picker"
              onclick={() => (speechExpanded = !speechExpanded)}
            >
              Change language
              <span class="chevron" class:open={speechExpanded}>
                <Icon name="chevron-down" size={14} />
              </span>
            </button>
          {/if}
          <div class="readiness-picker" id="welcome-speech-picker" hidden={!pickerOpen}>
            <SpeechLanguagePicker
              compact
              revision={$settings.revision}
              onactivestatus={(status) => (modelStatus = status)}
              onlanguagechange={async () => {
                // Awaited: Rust has just superseded the revision this screen was
                // handed, and the settings store is shared with every other
                // screen. Leaving it stale would make the NEXT write anywhere in
                // the app fail its conflict check.
                await loadSettings(true);
              }}
            />
          </div>
        </li>
      </ul>

      <footer class="setup-footer">
        <button type="button" class="link quiet" data-focus="control" onclick={openPrivacy}>
          How CandidCue handles your voice
        </button>
      </footer>
    </section>
  </div>
</div>

<style>
  /*
   * The scroll container, and the query container the layout answers to.
   *
   * A container query rather than a media query because the width that matters
   * is this region's, not the window's — the same answer today, since Welcome
   * has no sidebar, but not a coincidence the layout should lean on.
   */
  .welcome {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
    padding: clamp(var(--space-6), 6vh, var(--space-10)) var(--page-x-wide);
  }

  /*
   * Anchored to the top, centred across.
   *
   * Not centred vertically, which it was for a round: the setup column
   * changes height while somebody is using it — "Change language" unfolds the
   * picker, a finished download folds a row — and a vertically centred page
   * moved the WHOLE screen by the difference, start actions included, every
   * time. A fixed top keeps everything above the change where it was.
   */
  .inner {
    margin: 0 auto;
    width: 100%;
    max-width: 1080px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: clamp(var(--space-9), 4.5vw, 64px);
    align-items: start;
  }

  /* ---- start ---- */

  /*
   * The top padding is the setup panel's hairline plus its header padding, and
   * the wordmark shares the panel title's line height, so the first line of
   * each column sits on one line across the gap.
   */
  .start {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    padding-top: calc(var(--space-4) + 1px);
  }

  .intro {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /*
   * The name as it is always written — title case, never small capitals — in
   * the brand face and in one colour. The mark beside it carries the colour;
   * the word is ink. Sized to sit with the 22px mark, while the line height
   * stays the panel title's: the two columns' first lines share a 23px line
   * box, though a 17px brand face and a 15px UI face cannot share a baseline.
   *
   * `font-synthesis: none` because a browser that cannot find the 600 weight
   * would otherwise smear a bolder one out of the regular, and a faked bold is
   * the one thing a wordmark cannot be.
   */
  .wordmark {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    line-height: var(--lh-body);
    font-family: var(--font-brand);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: var(--ls-brand);
    font-synthesis: none;
    color: var(--text-primary);
  }

  /*
   * The page-title size, from 32, in the brand face.
   *
   * This is the one screen where a little editorial storytelling is right, so
   * the heading is one of the desk's few branded display moments. What came
   * down is the SCALE (§16.1): this is a setup assistant with three actions
   * and a checklist beside it, and it should read as the top of a window, not
   * as the top of a marketing site. The page-title token is what every other
   * screen's title is set at. The tracking is a grotesque's at this size —
   * the editorial title tracking was set for a serif.
   */
  .heading {
    margin: 0;
    font-family: var(--font-brand);
    font-size: var(--text-page-title);
    line-height: var(--lh-page-title);
    font-weight: 600;
    letter-spacing: var(--ls-brand);
    font-synthesis: none;
    color: var(--text-primary);
    text-wrap: balance;
  }

  .body {
    margin: 0;
    font-size: var(--text-base);
    line-height: var(--lh-body);
    color: var(--text-secondary);
    max-width: 46ch;
  }

  /* The two regions are named alike, so they read as peers. */
  .region-title {
    margin: 0;
    font-size: var(--text-base);
    line-height: var(--lh-body);
    font-weight: 600;
    color: var(--text-primary);
  }

  .start .region-title {
    margin-top: var(--space-8);
  }

  .actions,
  .more-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .actions {
    margin-top: var(--space-3);
  }

  .skip {
    margin: var(--space-6) 0 0;
  }

  /* ---- setup ---- */

  /*
   * One white panel on the paper canvas, and the only frame here: rows are
   * divided by hairlines rather than boxed, so nothing is a bordered card
   * inside a bordered card.
   */
  .setup-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    /* No resting shadow: a contained panel on the page, not a floating one. */
    overflow: hidden;
  }

  .setup-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-4) var(--space-5) var(--space-3);
  }

  .setup-note {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    text-wrap: pretty;
  }

  .readiness {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--border-faint);
  }

  .readiness-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    padding: var(--space-4) var(--space-5);
  }
  .readiness-item + .readiness-item {
    border-top: 1px solid var(--border-faint);
  }
  /*
   * Only a degraded rig tints its row, and it tints the whole row, edge to
   * edge — never a one-sided border, which reads as a crescent wherever a
   * radius cuts it. Expected setup is carried by its accent pill alone: on a
   * first launch two of three rows are "set up", and washing them made the
   * checklist look like a list of things already wrong.
   */
  .readiness-item.attention {
    background: var(--warning-soft);
  }

  .readiness-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    align-self: stretch;
    min-width: 0;
  }

  .readiness-title {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }

  .readiness-detail {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }

  .readiness-picker {
    align-self: stretch;
    margin-top: var(--space-3);
    min-width: 0;
  }
  .readiness-picker[hidden] {
    display: none;
  }

  .setup-footer {
    margin-top: auto;
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border-faint);
  }

  /* ---- links ---- */

  /*
   * Text buttons, inset by their own padding so the label sits on the text
   * column above it while the focus ring still has room around it.
   */
  .link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    border: none;
    background: transparent;
    margin: 0 calc(-1 * var(--space-1));
    padding: 2px var(--space-1);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--accent-strong);
    border-radius: var(--radius-sm);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .readiness-item .link {
    margin-top: var(--space-1);
  }
  /* Small accent text never lightens to --accent on hover; it darkens to the
     primary text colour instead, which reads as the right direction for a
     hover. */
  .link:hover {
    color: var(--text-primary);
    text-decoration-thickness: 2px;
  }
  /* The ways out of the screen are links too, just not setup actions. */
  .link.quiet {
    font-weight: 500;
    color: var(--text-secondary);
  }
  .link.quiet:hover {
    color: var(--text-primary);
  }

  .chevron {
    display: inline-flex;
    transition: transform var(--dur-med) var(--ease-out);
  }
  .chevron.open {
    transform: rotate(180deg);
  }

  /* ---- one column ---- */

  /*
   * Below this the two columns would each be too narrow to read, so they
   * stack, start first, because it is the way in.
   */
  @container (max-width: 760px) {
    .inner {
      grid-template-columns: minmax(0, 1fr);
      row-gap: var(--space-8);
      max-width: 600px;
    }
  }
</style>
