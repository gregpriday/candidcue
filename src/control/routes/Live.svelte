<!--
  Live control screen (spec §15) in the dark studio theme: top status bar,
  outline / stage preview / diagnostics regions, always-visible bottom
  transport, §15.3 pause semantics, F.17 end-of-session summary.
-->
<script lang="ts">
  import { openMicrophonePrivacySettings, openSettingsWindow } from '../lib/open-settings';
  import Button from '../components/Button.svelte';
  import Dialog from '../components/Dialog.svelte';
  import FollowControls from '../components/FollowControls.svelte';
  import FollowDiagnostics from '../components/FollowDiagnostics.svelte';
  import FollowStatePanel from '../components/FollowStatePanel.svelte';
  import { sessionModeLabel } from '../../shared/take-vocabulary';
  import { isAutomaticProfile } from '../../shared/optical-discovery';
  import Icon from '../components/Icon.svelte';
  import IconButton from '../components/IconButton.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
  import StageAppearanceSheet from '../components/StageAppearanceSheet.svelte';
  import Slider from '../components/Slider.svelte';
  import {
    readStageAppearance,
    stageAppearanceEquals,
    type StageAppearance,
  } from '../lib/stage-appearance';
  import type { PresentationMode } from '../../shared/contracts';
  import { AUTO_SCROLL_WPM_STEP } from '../../stage/renderer/autoscroll';
  import { VIEWPORT_REFLOW_SETTLE_MS } from '../../stage/renderer/geometry';
  import { sessionEndConfirmation } from '../lib/app-lifecycle';
  import { formatClock } from '../lib/format';
  import { rememberReaderFrame } from '../lib/reader-frame';
import { onShortcut } from '../lib/shortcuts';
  import { onRouteCommand } from '../stores/command-bus';
  import Disclosure from '../components/Disclosure.svelte';
  import { formatAccelerator } from '../lib/commands';
  import { detectPlatform } from '../lib/platform';
  import PaneDivider from '../components/PaneDivider.svelte';
  import { PANE_LIMITS, setPaneWidth, workspace } from '../stores/workspace';
  import { resolveLandedDisplay, startTake, takeStarting } from '../lib/start-take';
  import {
    awaitViewportSettled,
    exitPresentation,
    painted,
    switchPresentationMode,
  } from '../services/control-window';
  import { describeError } from '../services/errors';
  import { getVoiceFacade } from '../services/voice-facade';
  import { pendingConfirm, requestConfirm } from '../stores/confirm';
  import { coverIsUp, presentingPhase, setPresentingPhase } from '../stores/presenting';
  import { navigate } from '../stores/router';
  import {
    adjustStageFontSize,
    adoptPresentationMode,
    anchorManualScroll,
    applyReaderAppearance,
    applyReaderTheme,
    noteStageRenderedFontSize,
    applyStageAppearance,
    suspendReaderPaper,
    autoScrollLive,
    awaitPendingPersistence,
    autoScrollReachedEnd,
    nudgeAutoScrollWpm,
    toggleAutoScroll,
    canSwitchMicrophone,
    clearSession,
    connectionPill,
    goToToken,
    acceptSuggestedPlace,
    hardPause,
    liveStatusLabel,
    moveSentences,
    pauseListening,
    restartParagraph,
    resumeSession,
    session,
    startPrompting,
    stopSession,
    switchMicrophone,
    retryMicrophone,
    takeReaderPreferenceSettings,
    takeReaderThemeSetting,
    toggleBlankStage,
    togglePlayPause,
    toggleStageMirror,
    acknowledgeOnStage,
    toggleVoiceFollow,
  } from '../stores/session';
  import { patchSettings, settings } from '../stores/settings';
  import {
    readerPreferenceEquals,
    readerPreferenceFrom,
    readerPreferenceReplacement,
    readerThemeFor,
    withReaderPreference,
    type ReaderPreference,
    type ReaderTheme,
  } from '../services/settings-types';
  import { READER_PAPER_THEME_ID, readerThemeOfStage } from '../services/stage-envelope';
  import { smoothFollow, type FollowNotice } from '../stores/smooth-follow';
  import { showToast } from '../stores/toasts';
  import type { AudioDeviceInfo, OutlineNode, StageIntent } from '../../shared/contracts';
  import StageApp from '../../stage/StageApp.svelte';

  interface Props {
    sessionId: string;
    scriptId: string;
  }
  let { sessionId, scriptId }: Props = $props();

  const stageFontSize = $derived($session.stageFontSizePx);
  const connection = $derived(connectionPill($session.connection));

  const snapshot = $derived($session.snapshot);
  // From the glossary, so the pill names the take what the controls that drive
  // it are called. "Fixed" and "Roll at pace" were the same mode.
  const modeLabel = $derived(sessionModeLabel($session.mode));

  /**
   * Is there a realtime transport and an open microphone to report on at all?
   *
   * `connection` and `micState` are optimistic defaults ('connected' / 'live')
   * that only a running voice pipeline ever corrects. In a manual or
   * fixed-speed take nothing ever constructs that pipeline, so the pills sat on
   * their defaults and the status bar cheerfully read "Connected · Mic live"
   * over a take with no connection and no microphone — and kept reading it
   * after the session ended. The operator uses those two pills to decide
   * whether a problem is their microphone or their script, so a comforting
   * default is worse than no pill at all.
   */
  const hasVoiceTransport = $derived($session.active && $session.mode === 'voice');

  /* ------------------------------------------------- §28.2 input recovery */

  /**
   * A microphone that dies mid-take is recoverable: the WebRTC sender's track
   * can be replaced without renegotiating the session, so the take keeps its
   * position, its transcript and its connection.
   *
   * The picker only appears when the INPUT is what failed (`inputDeviceLost`,
   * not the broader `micState === 'disconnected'`, which a dead transport also
   * produces) and there is a transport to switch on. Offering a microphone
   * swap as the cure for a rejected API key, or in a manual take with no
   * pipeline at all, would be the same promise-the-UI-cannot-keep defect this
   * replaced.
   */
  let micInputs = $state<AudioDeviceInfo[]>([]);
  let micChoice = $state('');
  let micSwitching = $state(false);
  /**
   * Unchanged, and it was never the part that was wrong.
   *
   * This condition is exactly right: offer a swap when there is a voice
   * transport to swap on and the INPUT is what failed. What was wrong was where
   * it rendered — inside the "no take is running" arm, which made the whole
   * expression `active && !active`. It is the take-controls drawer that reads it
   * now. See the §115 block further down.
   */
  const micRecoveryOffered = $derived(
    hasVoiceTransport &&
      // Two conditions, one control. A LOST input is a fault; a FALLBACK input
      // is merely the wrong one. Both are answered by choosing a device, and
      // the second used to be told to do exactly that with no picker rendered.
      ($session.inputDeviceLost || $session.usingFallbackInput) &&
      canSwitchMicrophone(),
  );

  /**
   * #303 — the OS refused the microphone. The input picker above is not offered
   * for this (`inputDeviceLost` stays false): another input cannot answer a
   * refusal. The privacy pane can, and then a retry.
   */
  const micAccessRecoveryOffered = $derived(hasVoiceTransport && $session.microphoneRefused);
  let micRetrying = $state(false);

  async function retryMicrophoneAccess(): Promise<void> {
    if (micRetrying) return;
    micRetrying = true;
    try {
      await retryMicrophone();
    } finally {
      micRetrying = false;
    }
  }

  /**
   * The take-controls drawer (§115). Declared here, beside the microphone state
   * it exists to make reachable; its reasoning and lifecycle are at the bottom
   * of this script, and `stageChromeOpen` reads `takeControlsOpen` above.
   */
  let takeControlsOpen = $state(false);
  let takeControlsTab = $state<HTMLButtonElement | null>(null);
  let takeControlsPanel = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!micRecoveryOffered) return;
    void refreshMicInputs();
  });

  /**
   * The enumeration this component is currently willing to believe.
   *
   * Listing devices is a round trip, and two of them can be in flight at once —
   * Rescan is a button, and the `$effect` above fires on its own. Worse, one can
   * outlive its take entirely: end a take with a listing pending, press "Present
   * again", and the old result would land in the new take's picker offering the
   * previous take's device ids, or raise a permanent danger toast about a
   * listing nobody asked for. Only the latest request, belonging to the take
   * that is still running, is allowed to write.
   */
  let micRequest = 0;

  /**
   * Where the latest listing got to, so the picker can say it. An empty,
   * disabled `<select>` used to stand for all three of "still looking", "found
   * nothing" and "could not look", and only one of those is fixed by plugging
   * something in.
   */
  let micListing = $state<'idle' | 'scanning' | 'done' | 'failed'>('idle');

  async function refreshMicInputs(): Promise<void> {
    const request = (micRequest += 1);
    const forSession = $session.sessionId;
    const stale = (): boolean => micRequest !== request || $session.sessionId !== forSession;
    micListing = 'scanning';
    try {
      const found = await getVoiceFacade().listMicrophones();
      if (stale()) return;
      micInputs = found.filter((device) => device.available !== false);
      if (!micInputs.some((device) => device.deviceId === micChoice)) {
        micChoice =
          micInputs.find((device) => device.isDefault)?.deviceId ?? micInputs[0]?.deviceId ?? '';
      }
      micListing = 'done';
    } catch (err) {
      if (stale()) return;
      micInputs = [];
      // The choice goes with the list: left standing, "Use this input" stayed
      // live beside an empty picker, offering a device nobody can see.
      micChoice = '';
      micListing = 'failed';
      showToast(`Could not list microphones. ${describeError(err)}`, 'danger');
    }
  }

  /** The choice is one the latest listing still offers. */
  const micChoiceListed = $derived(micInputs.some((device) => device.deviceId === micChoice));

  async function useMicrophone(): Promise<void> {
    if (!micChoiceListed || micSwitching) return;
    /*
     * Tokened for the same reason the listing is. `micSwitching` disables both
     * recovery buttons, and an unconditional `finally` meant a switch left over
     * from a previous take could re-enable them in the middle of THIS take's
     * switch — two concurrent recoveries, and a spinner that stops on the wrong
     * one. Only the operation that is still current may clear the flag.
     */
    const request = (micRequest += 1);
    const forSession = $session.sessionId;
    micSwitching = true;
    try {
      // The label travels with the id: it is what identifies this microphone
      // again next launch, when the id may have been re-salted.
      await switchMicrophone(micChoice, micInputs.find((d) => d.deviceId === micChoice)?.label);
    } finally {
      if (micRequest === request && $session.sessionId === forSession) micSwitching = false;
    }
  }

  /**
   * Toast placement (see ToastRegion). The transport is a fixed-height bar the
   * toasts must never cover, and its height depends on its own controls, so it
   * is measured rather than guessed. Published on the document element because
   * the toast region is mounted at the app root, outside this route.
   */
  let transportHeightPx = $state(0);
  $effect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      '--toast-safe-bottom',
      `calc(${transportHeightPx}px + var(--space-6))`,
    );
    return () => root.style.removeProperty('--toast-safe-bottom');
  });

  const flatOutline = $derived(flatten($session.outline));

  /** The last section starting at or before `token`; -1 ahead of the first. */
  function sectionIndexAt(token: number): number {
    return flatOutline.reduce(
      (acc, entry, index) => (entry.node.startTokenIndex <= token ? index : acc),
      -1,
    );
  }

  const currentSectionIndex = $derived(snapshot ? sectionIndexAt(snapshot.confirmedToken) : -1);

  /*
   * The section a section jump is measured from (#284).
   *
   * Not `currentSectionIndex`, which is what the tracking panel reports and so
   * stays "none" until the take has a position. A take from the top publishes
   * nothing until the voice locks or a key moves it, and measured from "none"
   * the first ⌥↓ asked for the FIRST section — the one already on the glass —
   * and went nowhere. Before any snapshot the take is where it opened, and the
   * envelope says where that was.
   */
  const navigationSectionIndex = $derived(
    snapshot
      ? currentSectionIndex
      : $session.stageEnvelope
        ? sectionIndexAt($session.stageEnvelope.initialTokenIndex)
        : -1,
  );

  const sentenceIndex = $derived(
    snapshot
      ? Math.max(0, $session.sentences.findIndex(
          (s) =>
            snapshot.confirmedToken >= s.startTokenIndex &&
            snapshot.confirmedToken <= s.endTokenIndex,
        ))
      : $session.sentences.length > 0
        ? 0
        : -1,
  );

  const previewWindow = $derived.by(() => {
    if ($session.sentences.length === 0 || sentenceIndex < 0) return [];
    const start = Math.max(0, sentenceIndex - 2);
    return $session.sentences.slice(start, sentenceIndex + 4).map((sentence, i) => ({
      sentence,
      offset: start + i - sentenceIndex,
    }));
  });

  const currentSectionTitle = $derived(
    currentSectionIndex >= 0 ? (flatOutline[currentSectionIndex]?.node.title ?? null) : null,
  );

  /** Degraded-state actions (Part XI) offered next to the notice itself. */
  function handleNoticeAction(action: NonNullable<FollowNotice['action']>): void {
    if (action.id === 'rebuild_layout') {
      smoothFollow.requestLayoutRebuild();
      return;
    }
    /*
     * The Settings WINDOW, not a route. This used to navigate, and since
     * Settings moved out of the control window (§14.1) that quietly landed the
     * operator in the Library — mid-take, having asked for the follower
     * settings.
     */
    void openSettingsWindow('following');
  }

  function flatten(nodes: OutlineNode[], depth = 0): Array<{ node: OutlineNode; depth: number }> {
    const out: Array<{ node: OutlineNode; depth: number }> = [];
    for (const node of nodes) {
      out.push({ node, depth });
      out.push(...flatten(node.children, depth + 1));
    }
    return out;
  }

  /**
   * Outline navigation: an absolute move to the section's first sentence.
   *
   * It used to be a relative `moveSentences` whenever a cursor existed, with
   * the distance counted from this screen's `sentenceIndex` — the sentence
   * CONTAINING the cursor, or 0 when none does. The driver applies a relative
   * move from its own index, the last sentence STARTING at or before the
   * cursor. A cursor between two sentences reads differently to each, and the
   * jump landed that many sentences away from the section. A section is a
   * place, so it is asked for as one (#284).
   */
  function jumpToSection(node: OutlineNode): void {
    const first = $session.sentences.find((s) => s.startTokenIndex >= node.startTokenIndex);
    goToToken(first?.startTokenIndex ?? node.startTokenIndex);
    acknowledgeOnStage(node.title);
  }

  /**
   * ⌥↑ / ⌥↓ one section along, or say why not.
   *
   * At either end these used to do nothing at all, and a key that does nothing
   * looks exactly like a key that was missed — so the presenter presses it
   * again, harder, mid-sentence.
   */
  function stepSection(delta: -1 | 1): void {
    if (flatOutline.length === 0) {
      acknowledgeOnStage('No sections in this script');
      return;
    }
    const target = flatOutline[navigationSectionIndex + delta];
    if (target) jumpToSection(target.node);
    else acknowledgeOnStage(delta < 0 ? 'Already at the first section' : 'Already at the last section');
  }

  /**
   * End the session, having asked first if the setting says to.
   *
   * ONE VOCABULARY. There used to be three ways to finish a take on this
   * screen wearing three different words — "Stop the session?" in this dialog,
   * "Stop session" on the transport, "End session" on the stage's dock — and
   * two different confirmation policies, because the dock's exit ran straight
   * to teardown while this one asked. Three names for one action reads as three
   * actions, and the one the presenter reaches for at the end of a take is
   * whichever they happen to see.
   *
   * It is "end" everywhere now, and every path lands in `endTake` below.
   */
  async function requestEndSession(): Promise<void> {
    if ($settings.general.confirmEndSession) {
      /*
       * Chrome, for the same reason the menu and the sheet are.
       *
       * The stage answers Escape on its own window listener, and a confirm
       * sheet's Escape means "no, don't". Without standing the stage down for
       * the length of the question, backing out of "End this take?" ended
       * the session — the one answer the dialog exists to make avoidable.
       */
      confirmingStop = true;
      let accepted = false;
      try {
        /*
         * The SHARED question, not one written out here.
         *
         * Every dialog-shaped way out of a running take asks it — this one,
         * App's navigation guard and File › Close Window — and it lives in
         * `app-lifecycle.ts` precisely so they cannot drift apart again, which
         * they had. Over a practice it is the dock's words (§practice): a
         * dialog reached from the drawer or ⌘. that still offered to end a take
         * would be the fourth name for one action that §115 removed three of.
         *
         * Its body stops short of promising the summary even though this path
         * does show one, because the other two do not — see the constant.
         */
        accepted = await requestConfirm(sessionEndConfirmation($session.practice));
      } finally {
        confirmingStop = false;
      }
      if (!accepted) return;
    }
    await endTake();
  }

  /**
   * Give the window back its titlebar and its old bounds, covered.
   *
   * The mirror of `startTake`'s opening, and it needs the cover for the same
   * reason: leaving presentation is another window-geometry change, and the
   * webview repaints it asynchronously. Un-presenting bare showed the workspace
   * theme's light editor arriving in pieces around a shrinking window — the
   * same artifact as the opening, running backwards.
   *
   * The cover is raised and PAINTED before anything moves, held across both the
   * window change and the navigation that follows it, and dropped only once the
   * destination screen has painted. The caller does the navigating, because
   * where it goes is the only part of this that differs between the three exits.
   *
   * `finally`, and it is not ceremony. The cover is opaque, full-window and
   * above everything, so a phase left at `closing` is not a cosmetic loose end —
   * it is an app the operator can no longer see or use, with no way back but
   * quitting. Everything inside is I/O that can throw. The cover must come down
   * whether or not it does.
   *
   * ---------------------------------------------------------------------------
   * IT TAKES A DESTINATION AGAIN — WITHOUT THE PART THAT WAS THE BUG
   * ---------------------------------------------------------------------------
   * This is worth reading before anybody "restores" the previous shape.
   *
   * It originally ran a `destination` callback between the un-present and the
   * cover coming down, and every caller passed the same two statements:
   * `clearSession()` then navigate away. `clearSession()` resets the store, and
   * the store's `summary` is what the F.17 dialog opens on — so the summary the
   * take had just produced was destroyed UNDER THE COVER, one step before the
   * screen it would have appeared on was replaced. The dialog's condition was
   * true for a handful of frames, every one of them behind an opaque black
   * plate. Nobody had ever seen an end-of-session summary.
   *
   * The fix at the time was to drop the destination entirely and let the take
   * end where it started, on Live, with the summary simply visible there. That
   * fixed the summary and left the presenter looking at the thing behind it: an
   * operator console built for a two-window rig, its centre pane mirroring a
   * prompter that had been in this very window, its transport offering to Start
   * and End a session that was over.
   *
   * So the destination is back and the `clearSession()` is not. Navigating
   * under the cover was never the defect — clearing under it was. The summary
   * now lives in an app-level host (`SessionSummary.svelte`) which outlives this
   * route, so the report survives the navigation it used to be destroyed by,
   * and the only thing that clears the session is somebody dismissing it.
   *
   * The cover still cannot be rendered under — App's `.present-cover` sits at
   * z-index 9999, deliberately above the dialog host — which is why the
   * destination runs INSIDE the cover and the summary appears only once it
   * falls.
   */
  async function leavePresentation(destination?: () => Promise<unknown>): Promise<void> {
    setPresentingPhase('closing');
    try {
      await painted();
      const restored = await exitPresentation().catch(() => null);
      /*
       * Before the settle wait, because this is the last call that knew where a
       * reading window was — and AWAITED, which is the part that is easy to get
       * wrong.
       *
       * Firing it and walking away races the next take: `startTake` opens with
       * `loadSettings(true)`, a forced re-read, and a read that overtakes this
       * write returns the previous frame and then patches from its revision.
       * The cover is already up and the write is one IPC round trip, so waiting
       * costs nothing anybody can see. It never rejects.
       */
      await rememberReaderFrame(restored);
      if (restored) await awaitViewportSettled(restored);
      /*
       * The route swap, still behind the plate.
       *
       * This unmounts the component this function is declared in, which is fine
       * and worth stating plainly: `painted` and `setPresentingPhase` are module
       * imports, not component state, so the last wait and the `finally` below
       * run exactly as they would have. What must NOT move above this line is
       * the un-present — the editor arriving at monitor size and then being
       * resized is the reverse-transition artifact the cover exists for.
       */
      await destination?.();
      await painted();
    } finally {
      setPresentingPhase('off');
    }
  }

  /**
   * A teardown is already running.
   *
   * `endTake` is reachable from four places at once — the dock's End button,
   * the stage's double-Escape, Cmd+. and the drawer — and two of them are keys
   * that repeat. Without this, a second call would `stopSession()` a session
   * that has already stopped (harmless) and then run a SECOND concurrent
   * un-present whose `finally` drops the cover while the first is still using
   * it, which is the black-plate-vanishing-mid-transition artifact the cover
   * exists to prevent.
   */
  let endingTake = false;

  /**
   * End the take and show the presenter what happened.
   *
   * Already confirmed by the time it is called: the dock asks on its own, the
   * stage's Escape asks by requiring a second press, and `requestEndSession`
   * asks with a dialog. This is the one teardown they all share.
   *
   * IT ENDS ON THE EDITOR, not here. A finished take has exactly three things
   * anybody wants — the report, the script they just read, and another go — and
   * this route's inactive state is none of them: it falls back to an operator
   * console laid out for a rig where the stage has its own window, offering to
   * Start and End a session that has just ended. The summary itself is hosted
   * by App now, so it survives the navigation and opens over the editor. See
   * `leavePresentation` for why the route swap happens under the cover.
   */
  async function endTake(): Promise<void> {
    /*
     * NOT WHILE A TAKE IS OPENING, and this is reachable.
     *
     * "Present again" awaits `startTake`, which is a long sequence that raises
     * the cover for its OPENING before `startLiveSession` marks the session
     * active. Escape is not delegated to the stage during that window (there is
     * no stage yet), so it reaches this handler — and `endingTake` does not
     * help, because no teardown is running: a brand new one would start. That
     * puts `leavePresentation`'s un-present concurrently with `startTake`'s
     * present, and both end in a `finally` that sets the cover phase, so
     * whichever loses leaves the app either permanently covered or presenting
     * with no cover at all.
     *
     * `takeStarting` is the store `startTake` already keeps for exactly this
     * class of double-entry; the Present buttons read it for the same reason.
     */
    if (endingTake || $takeStarting) return;
    /*
     * ...and not while somebody else's cover is up, which `takeStarting` does
     * not cover.
     *
     * The App navigation guard is the other owner: leaving a live session by a
     * shortcut or a sidebar click raises ITS cover, then awaits a paint before
     * stopping the session — and its confirmation dialog closes before that. An
     * end pressed in that gap would run this teardown concurrently with the
     * guard's, and both finish by writing `presentingPhase` from a `finally`.
     * `startTake` refuses on the same condition, from the other direction.
     */
    if (coverIsUp($presentingPhase)) return;
    endingTake = true;
    try {
      stopSession();
      // The drawer belongs to a running take, and this route is about to be
      // replaced anyway — but closing it keeps the state honest for the one
      // path that lands back here, a navigation a guard refuses.
      takeControlsOpen = false;
      /*
       * `stopSession()` first, so the guard App registers for leaving a live
       * session sees an inactive one and waves this through without raising its
       * own "End this take?" confirmation over a take that has already ended.
       */
      /*
       * A PRACTICE CLEARS ITS OWN SESSION, BECAUSE NOTHING ELSE WILL (§practice).
       *
       * `leavePresentation` deliberately does NOT clear — see the long note on
       * it — because the store's `summary` is what the F.17 report opens on, and
       * clearing under the cover was the bug that meant nobody had ever seen
       * one. `SessionSummary` clears when it is dismissed, and that is what puts
       * the store back to rest after every take.
       *
       * A practice withholds the summary, so that card never opens and that
       * dismissal never comes: without this, the store would hold a finished
       * rehearsal — its script, its snapshot, its transcript tail — until the
       * next take happened to replace it. Safe here for exactly the reason it
       * was unsafe there: there is no report to destroy, and the stage unmounted
       * on `active` the moment `stopSession()` ran, so this is behind the cover
       * and behind an already-empty screen.
       */
      const practice = $session.practice;
      await leavePresentation(async () => {
        /*
         * THE ENDING HAS TO BE IN THE DATABASE BEFORE THE EDITOR READS IT.
         *
         * `stopSession` fire-and-forgets the session row's ending index, and the
         * Editor's history effect is written around that: it depends on
         * `$session.summary` so that the report's ARRIVAL is a second, later
         * trigger, after a mount that may well have read the row before its
         * ending was written. A practice publishes no summary, so it has no
         * second trigger — and "From last ending" picking a rehearsal up exactly
         * as it picks a take up is the reason a practice writes an ordinary
         * session row at all (§practice). Without this it could offer an older
         * ending, or none, for the whole mount.
         *
         * Awaiting is free here and nowhere else: this is inside the cover, with
         * the window already changing shape around it. It is the same primitive
         * the quit handshake awaits, for the same reason — a fire-and-forget
         * write is right during a take and wrong at the moment something is
         * about to read it.
         */
        if (practice) await awaitPendingPersistence();
        const moved = await navigate({ name: 'editor', scriptId });
        if (practice) clearSession();
        return moved;
      });
    } finally {
      endingTake = false;
    }
  }

  /**
   * Pop the take out to the whole display, or back into a window.
   *
   * ---------------------------------------------------------------------------
   * NOT `leavePresentation`, AND NOT COVERED
   * ---------------------------------------------------------------------------
   * The two exits above raise the black cover because they are going somewhere
   * else: the window changes shape AND the screen behind it changes to the
   * editor, and the cover spans both. This goes nowhere. The same take keeps
   * running, the same script stays on the glass, and the only thing that moves is
   * the window around it — so a cover would be a deliberate half-second of black
   * inserted into a live read, which is the one thing a prompter must not do.
   *
   * `set_control_presenting` sets the window's backing to black before it moves
   * for exactly this case (see `apply_reader`), so the strip the layout has not
   * reached yet is the stage's own colour rather than a flash of paper.
   *
   * ---------------------------------------------------------------------------
   * WINDOW FIRST, THEN GEOMETRY
   * ---------------------------------------------------------------------------
   * `adoptPresentationMode` recomposes the stage settings, and in reader mode the
   * geometry resolves against the window's own viewport. Recomposing before the
   * window has finished changing size would measure the whole document at the old
   * size and have it invalidated a frame later — the two-measurement waste
   * `startTake` is ordered to avoid, in the middle of a take. So: switch, wait
   * for the viewport, then recompose.
   *
   * "Wait for the viewport" is TWO waits, and the second is easy to miss.
   * `awaitViewportSettled` watches the raw `window.innerWidth/innerHeight`, which
   * at 60 Hz agrees within about 33 ms. But the stage resolves reader geometry
   * from a viewport deliberately trailed by `VIEWPORT_REFLOW_SETTLE_MS`, so
   * recomposing on the raw settle alone lands the new mode against the old size
   * and produces exactly the double relayout this ordering exists to prevent.
   * Hence the second wait — and hence the constant being shared with the renderer
   * rather than written out twice.
   */
  /**
   * A switch is in flight.
   *
   * The same guard `startTake` keeps in its `takeStarting` store, for the same
   * reason: the sequence below spans two awaits and is reachable from a key that
   * repeats. Without it, holding ⌃⌘F interleaves several switches — each one
   * moving the window while another is waiting for the viewport to settle, so the
   * settle waits resolve against sizes their own switch did not ask for and the
   * last recompose to land wins arbitrarily.
   *
   * Rust is unharmed either way (`plan` is idempotent and the latch is behind a
   * mutex); it is control's view of the mode that would end up disagreeing with
   * the window.
   */
  let switchingPresentation = false;

  async function togglePresentationMode(): Promise<void> {
    if (!$session.active || switchingPresentation) return;
    /*
     * An open appearance panel is put back first. Its snapshot belongs to the
     * mode it opened in, and the two modes have different controls — left open
     * across a switch, it would show the other mode's controls with a Cancel
     * that could undo only the first.
     */
    if (appearanceOpen) revertAppearance();
    const next: PresentationMode =
      $session.stagePresentationMode === 'reader' ? 'prompter' : 'reader';
    switchingPresentation = true;
    /*
     * The take this switch belongs to.
     *
     * The sequence below spans two waits, and both of them can outlive the take
     * that started it: end the session while a settle is pending and start
     * another, and the continuation would recompose the NEW take's geometry for a
     * window operation the old one requested. `adoptPresentationMode` guards on
     * `active`, which a fresh take satisfies — so the id is what actually
     * distinguishes them.
     */
    const forSession = $session.sessionId;
    try {
      /*
       * A reading window goes dark BEFORE the window moves to the prompter.
       *
       * The geometry waits for the new shape (below), so without this a paper
       * reading window would fill the prompter's panel — glass — for the length
       * of the settle. Theme only, in place: nothing re-wraps. One painted
       * frame when it is on paper now, so the black is on screen before the
       * window moves. Held for a DARK reading window too, so Paper saved in
       * Settings while the switch is in flight cannot light the glass either.
       *
       * `adoptPresentationMode` lifts it when the switch lands. A switch that
       * fails does NOT: the window may have reached the glass before the part
       * that failed, and nothing here can tell, so the reading window stays dark
       * until the next switch lands or somebody picks Paper again in Reading
       * appearance — while looking at the window it would be drawn on.
       */
      if (next === 'prompter') {
        const wasPaper = paperTake;
        suspendReaderPaper(true);
        if (wasPaper) await painted();
      }
      const switched = await switchPresentationMode(next, $settings.stage.displayFingerprint);
      /*
       * Switching AWAY from reader mode reports the bounds the reading window
       * had a moment ago, and this is the only time they are reported outside a
       * teardown. Without it, popping out to the full display and then ending
       * the take from there would forget a window the reader had deliberately
       * placed — the mid-take toggle would quietly destroy a saved frame.
       */
      await rememberReaderFrame(switched);
      await awaitViewportSettled(switched);
      // The stage's own trailed viewport, not just the raw one — see above.
      await new Promise((resolve) => setTimeout(resolve, VIEWPORT_REFLOW_SETTLE_MS));
      /*
       * The PANEL the new shape landed on, resolved before the guard below so the
       * guard stays the last thing that happens before the store is touched.
       *
       * A switch can change monitors, and Rust answers for both directions: to
       * the prompter it is whichever monitor the reading window had been dragged
       * onto, and back to a reader it is wherever the restored frame lives. Only
       * the mode used to be read out of this reply, so the geometry was rebuilt
       * against the panel the take OPENED on — which for the reader who dragged
       * their window to an external prompter is the laptop's millimetres on the
       * prompter's glass. Null when nobody could name it; the take then keeps the
       * panel it already had.
       */
      const landed = await resolveLandedDisplay(switched.displayFingerprint);
      if (!$session.active || $session.sessionId !== forSession) return;
      /*
       * The mode the WINDOW reports, not the one that was asked for.
       *
       * Rust answers from its own latch, and it commits that latch only once the
       * window operation has actually succeeded — so a switch that failed halfway
       * propagates as an error rather than reporting a mode the window is not in.
       * Adopting the answer is what keeps the document from being composed for a
       * shape the window does not have: a reader's measure on a full display, or
       * worse, a prompter's mirror on a bare monitor.
       */
      adoptPresentationMode(switched.mode ?? next, landed);
    } catch (err) {
      // Recoverable and worth saying: the take is unharmed, the window simply did
      // not change. Silence would read as a dead key.
      showToast(`Could not change how this take is presented. ${describeError(err)}`, 'danger');
    } finally {
      // `finally`, so a failed switch does not latch the key dead for the rest of
      // the take — the same reasoning `abandonTake` gives for dropping the cover
      // in a `finally`.
      switchingPresentation = false;
    }
  }

  /*
   * The embedded stage's intents, handled here rather than on the event bus.
   *
   * This is the only handler a take has: the stage renders in this window, so
   * an intent it raises that is not answered here does nothing at all.
   */
  function handleEmbeddedStageIntent(intent: StageIntent): void {
    if (intent.kind === 'toggle_pause') {
      togglePlayPause();
    } else if (intent.kind === 'manual_scroll') {
      if (intent.anchorToken !== null) anchorManualScroll(intent.anchorToken, intent.atMs);
    } else if (intent.kind === 'toggle_follow') {
      toggleVoiceFollow();
    } else if (intent.kind === 'auto_scroll_end') {
      autoScrollReachedEnd(intent.reason);
    } else if (intent.kind === 'auto_scroll_toggle') {
      toggleAutoScroll();
    } else if (intent.kind === 'auto_scroll_pace') {
      nudgeAutoScrollWpm(
        intent.direction === 'faster' ? AUTO_SCROLL_WPM_STEP : -AUTO_SCROLL_WPM_STEP,
      );
    } else if (intent.kind === 'read_from') {
      // The session refuses a suggestion from another take, one the follower
      // has made moot by finding the reader again, or one a deliberate
      // reposition has overtaken.
      acceptSuggestedPlace(intent.token, intent.sessionGeneration, intent.atMs);
    }
  }

  function adjustFontSize(delta: number): void {
    /*
     * §17.2. A rig-resolved take sizes its type from a measured distance, so
     * this shortcut has nothing to move — and reporting the unchanged number
     * ("Text 96 px", again) reads as a key that did not register rather than a
     * size that is not this key's to set.
     *
     * A reading window is never rig-resolved, so it never reaches the toast:
     * `adjustStageFontSize` steps its reader preference instead.
     */
    if ($session.stageRigResolved) {
      // The answer, not the lesson: how to trade size for line width belongs to
      // Settings, where the slider is, not to the glass mid-sentence.
      acknowledgeOnStage(
        stageSizedAutomatically ? 'Size is set automatically' : 'Size is set by calibration',
      );
      return;
    }
    const next = adjustStageFontSize(delta);
    acknowledgeOnStage(`Text ${next}\u00a0px`);
  }

  function toggleMirror(): void {
    // Says what the glass now shows, rather than "mirrored" for both directions
    // — and names why nothing happened in a reading window, which has no glass
    // to read it off.
    //
    // On the glass, where it is read through the same flip it reports: the
    // toast this used to be sat outside the mirror, so the confirmation that
    // the text was now mirrored was the one thing on the panel reading
    // backwards.
    const mirrored = toggleStageMirror('x');
    acknowledgeOnStage(
      mirrored === null
        ? 'A reading window is never mirrored'
        : mirrored
          ? 'Mirrored for this take'
          : 'Unmirrored for this take',
    );
  }

  $effect(() =>
    onShortcut((action, source) => {
      /*
       * These keys belong to the embedded production stage while it is
       * mounted. Handling them again in control would turn one Space into
       * pause-then-resume, or one Escape into two teardown attempts.
       *
       * Only the keys the stage ACTUALLY answers belong on this list, and only
       * when they arrive as keys (#284). Hard pause and the section jumps used
       * to be here too, and the stage has never had either: ⌥↓ reached its
       * plain ArrowDown and stepped a line, ⌘⇧Space its plain Space. A menu
       * command never reaches the stage at all, so Session › Pause stood down
       * here for a handler that does not exist.
       */
      if (
        source === 'key' &&
        $session.active &&
        $session.stageEnvelope &&
        (action === 'escape' ||
          action === 'play-pause' ||
          // The transport keys are answered by the mounted stage too, so that
          // the hold chip's advice works on a separate-stage rig where that
          // window holds the keyboard. Handling them in both places would turn
          // one press into an on-and-off again.
          action === 'toggle-auto-scroll' ||
          action === 'auto-scroll-faster' ||
          action === 'auto-scroll-slower')
      ) {
        return;
      }
      switch (action) {
        case 'play-pause':
          togglePlayPause();
          break;
        case 'hard-pause':
          hardPause();
          break;
        case 'stop-session':
          void requestEndSession();
          break;
        case 'escape':
          void endTake();
          break;
        case 'back-sentence':
          moveSentences(-1);
          break;
        case 'forward-sentence':
          moveSentences(1);
          break;
        case 'prev-chapter':
          stepSection(-1);
          break;
        case 'next-chapter':
          stepSection(1);
          break;
        case 'stage-text-up':
          adjustFontSize(2);
          break;
        case 'stage-text-down':
          adjustFontSize(-2);
          break;
        case 'toggle-mirror':
          toggleMirror();
          break;
        case 'blank-stage':
          toggleBlankStage();
          break;
        case 'toggle-presentation-mode':
          void togglePresentationMode();
          break;
        /*
         * Reached when the stage is not the one answering: off a take, or from
         * a menu. The stage renders auto-scroll but does not own it either way:
         * its keys raise intents that land back in this window, because the
         * running flag, the pace and the mutual exclusion with voice following
         * are all session state, and this is the window that holds it.
         */
        case 'toggle-auto-scroll':
          toggleAutoScroll();
          break;
        case 'auto-scroll-faster':
          nudgeAutoScrollWpm(AUTO_SCROLL_WPM_STEP);
          break;
        case 'auto-scroll-slower':
          nudgeAutoScrollWpm(-AUTO_SCROLL_WPM_STEP);
          break;
        default:
          break;
      }
    }),
  );

  /* ------------------------------------------------ the appearance panel (§14.2)
   *
   * Presentation fills this window with the production stage, which is exactly
   * where the prompter's appearance can be judged and — before this existed —
   * the one place it could not be changed. Four of these five controls answer a
   * question about a physical arrangement (can I read this from there? is the
   * band over the lens?), so setting them anywhere else is guesswork that costs
   * a take to check.
   *
   * ---------------------------------------------------------------------------
   * THERE IS NO PRESENTATION CORNER ANY MORE
   * ---------------------------------------------------------------------------
   * This used to be a floating chip in the top-right of the window holding an
   * overflow menu with two items — "Adjust settings…" and "End session" — plus
   * its own idle timer, its own glass treatment, and its own focus-return
   * dance. All of it is now the stage's own session dock, bottom left, and what
   * is left here is the half that genuinely belongs to control: the panel's
   * contents and the transaction they run in. The stage raises it; this owns it.
   *
   * The duplicate "End session" went with the menu. There were three ways to end
   * a take on one screen (the menu item, the stage's exit affordance, Escape)
   * and two of them ran different code — one through `requestEndSession`'s
   * confirm dialog, one straight to teardown. Now there is one control, one
   * anchored confirmation, and one teardown path (`endTake`).
   */

  const mac = detectPlatform() === 'macos';

  /**
   * A transport key, spelled for this platform (§12.4).
   *
   * Through `formatAccelerator` — the same function the native menu and the
   * Shortcuts dialog use — so a key advertised on a tooltip cannot be one the
   * app does not answer. Plain keys (`Space`, `B`) have no modifiers to
   * translate and pass through unchanged, which is what makes one helper serve
   * both kinds.
   */
  function transportKey(spec: string): string {
    return formatAccelerator(spec, mac);
  }

  let appearanceOpen = $state(false);

  /*
   * View › Stage Appearance, from the native menu.
   *
   * The sheet belongs to this component, so the shell cannot open it — it
   * publishes the command and this route answers. Without this the menu item was
   * enabled on Live and did nothing at all.
   */
  $effect(() =>
    onRouteCommand((command) => {
      // Through the same door as the dock, so Cancel has a snapshot to go back
      // to — opened by flipping the flag, it had none and restored nothing.
      if (command === 'view.stage-appearance') openAppearanceSheet();
    }),
  );
  /** `requestEndSession`'s confirm dialog is up over the take. */
  let confirmingStop = $state(false);
  /**
   * The appearance the panel was opened on, so Cancel is exact.
   *
   * Captured here rather than inside the panel because it is the take's state,
   * not the panel's: the panel can be closed and reopened, and what "put it
   * back" means has to survive that.
   */
  let appearanceOnOpen: StageAppearance | null = null;
  /**
   * The reading window's half of the same snapshot: the reader preference the
   * take was running when the panel opened, absent fields and all, so Cancel
   * puts back "automatic" rather than pinning the size it happened to be.
   */
  let readerOnOpen: ReaderPreference | null = null;
  /**
   * The reading window's Dark or Paper when the panel opened. Its own snapshot
   * because the theme is not part of the reader preference — see
   * `takeReaderTheme` in the session store.
   */
  let readerThemeOnOpen: ReaderTheme | null = null;
  /**
   * Which controls the panel opened with. Cancel undoes what THOSE controls
   * could have changed — and nothing else, so a prompter's Cancel stays the
   * single `applyStageAppearance` it has always been.
   */
  let surfaceOnOpen: 'reader' | 'prompter' | null = null;
  /**
   * The reading window's controls, rather than the prompter's: this take's text
   * runs through the reader preference (`stageReaderAppearance`), so that is
   * what the panel shows, what it changes, and what Done saves.
   */
  const readerSurface = $derived($session.stageReaderAppearance !== null);
  /**
   * The reading window's Dark or Paper as the glass is drawing it now — off the
   * RENDERED settings, so the sheet's control and the canvas below say what is
   * on screen. Always dark for a prompter.
   */
  const stageReaderTheme = $derived(readerThemeOfStage($session.stageEnvelope?.stageSettings));
  /**
   * This take is a reading window on paper — or, before its envelope exists,
   * is about to open as one, which is what the "Preparing script…" plate needs
   * to know to avoid flashing black over a paper read.
   */
  const paperTake = $derived(
    $session.active &&
      ($session.stageEnvelope
        ? stageReaderTheme === 'paper'
        : $session.stagePresentationMode === 'reader' &&
          readerThemeFor($settings.teleprompter) === 'paper'),
  );
  /*
   * The page canvas follows the take's field (see `tokens.css`).
   *
   * `data-presenting` turns the canvas black for the whole take, so that a
   * window growing faster than its layout shows the stage's colour in the gap.
   * On a paper read that colour is paper, and a black strip down the edge of
   * every resize would be the loudest thing on the screen. Keyed on the
   * rendered settings, so a mid-take switch to the prompter puts the black
   * back, and removed with the take.
   */
  $effect(() => {
    if (!paperTake) return undefined;
    const root = document.documentElement;
    root.dataset['presentingTheme'] = READER_PAPER_THEME_ID;
    return () => {
      delete root.dataset['presentingTheme'];
    };
  });
  /**
   * What the stage measured off the face it is drawing — see `onmeasurement`.
   *
   * `charactersPerLine` is the number that actually governs eye travel, and the
   * width slider is a percentage. Only the stage can produce it.
   */
  let stageCharactersPerLine = $state<number | null>(null);
  /**
   * Whether the rig that resolved this take is the automatic one — built from
   * the panel at Present rather than calibrated by anybody. The sheet and the
   * size shortcut both say so, because calling a table lookup "calibrated"
   * would send someone hunting for measurements they never took.
   */
  const stageSizedAutomatically = $derived(
    isAutomaticProfile($session.stageEnvelope?.stageSettings.opticalProfile),
  );

  /**
   * Open chrome owns the keyboard — see `chromeOpen` on the stage bridge.
   *
   * `confirmingStop` is still in here even though the dock's End button no
   * longer goes through it: Cmd+. is not one of the shortcuts Live delegates to
   * the embedded stage, so it still reaches `requestEndSession` and can still
   * raise the confirm dialog over a running take.
   *
   * `takeControlsOpen` is in here for the same reason both of the others are:
   * the drawer contains a `<select>` and several buttons, and a stage still
   * answering Space and Escape underneath a focused control is a prompter that
   * pauses itself when somebody types.
   *
   * `confirmOpen` is any confirmation on screen, including the ones Live did
   * not raise and so cannot flag itself: App's navigation guard and File ›
   * Close Window put "End this take?" over a running take too, through the same
   * global host. Without it, Escape on that dialog also armed the stage's exit
   * underneath, and Space on its Cancel toggled pause instead of pressing it.
   */
  const confirmOpen = $derived($pendingConfirm !== null);
  const stageChromeOpen = $derived(
    appearanceOpen || confirmingStop || confirmOpen || takeControlsOpen,
  );

  /**
   * Open once. A second open must not re-capture the baseline.
   *
   * The dock's settings button toggles rather than re-opens, so the ordinary
   * route cannot ask twice — but "the rollback snapshot is whatever the last
   * open saw" is a bad property to leave lying around for the next caller. Drag
   * the band from 38% to 50%, reopen, press Cancel, and the take would keep 50%
   * while the button promised 38%.
   */
  function openAppearanceSheet(): void {
    /*
     * Not while the window is changing shape. The switch puts any open panel
     * back before it starts, and a panel opened in the middle of it would
     * snapshot one mode and apply into the other — Paper picked there could
     * land on the glass before the prompter's composition does.
     */
    if (appearanceOpen || switchingPresentation) return;
    appearanceOnOpen = $session.stageAppearance;
    readerOnOpen = takeReaderPreferenceSettings();
    readerThemeOnOpen = takeReaderThemeSetting();
    surfaceOnOpen = readerSurface ? 'reader' : 'prompter';
    appearanceOpen = true;
  }

  function closeAppearanceSheet(): void {
    appearanceOpen = false;
    appearanceOnOpen = null;
    readerOnOpen = null;
    readerThemeOnOpen = null;
    surfaceOnOpen = null;
  }

  /**
   * Done: what is on the glass becomes what the next take opens with.
   *
   * The take is already running these values — every drag applied them — so
   * this writes and closes and changes nothing visible.
   *
   * Nothing is written for a RIG-RESOLVED take. Its numbers came from the
   * profile, not from these controls (the panel shows them read-only and offers
   * no Done), and persisting them would copy one rig's measurements into the
   * global defaults every uncalibrated take opens with.
   */
  async function keepAppearance(): Promise<void> {
    if (readerSurface) return keepReaderAppearance();
    const live = $session.stageAppearance;
    closeAppearanceSheet();
    /*
     * Compared against the SAVED settings, not against what the panel opened
     * on. Those are different questions, and only one of them is "is there
     * anything to write?": a presenter who bumps the type with Cmd+= and then
     * opens the panel to press Done has changed nothing SINCE OPENING, and a
     * comparison against the opening state would quietly decline to save the
     * very thing they opened the panel to keep.
     */
    if (stageAppearanceEquals(readStageAppearance($settings.teleprompter), live)) return;
    try {
      await patchSettings('teleprompter', {
        textIntensity: live.textIntensity,
        fontSizePx: live.fontSizePx,
        lineHeight: live.lineHeight,
        columnWidthPercent: live.columnWidthPercent,
        readingBandCenterPercent: live.readingBandCenterPercent,
      });
      showToast('Prompter settings saved', 'info', { durationMs: 1600 });
    } catch {
      // `patchSettings` has already rolled the saved document back and toasted.
      // The TAKE keeps the appearance either way — it is the half the presenter
      // can see, and the half they asked for right now — so this says which of
      // the two survived rather than leaving the generic "nothing was changed"
      // standing over a stage that plainly did change.
      showToast('Saved defaults were not changed. This take keeps its look.', 'danger');
    }
  }

  /**
   * Done, for a reading window: the take's reader preference becomes the one
   * every reading window opens with.
   *
   * Into `optical`, through `withReaderPreference`, and never into
   * `teleprompter`. That section is the prompter's fallback; a reading window's
   * 34 px written there would open the next uncalibrated prompter take at 34 px
   * and change nothing in any reading window. And never as a rig: the
   * preference is not a calibration of this panel, and storing it as one would
   * make it this panel's prompter rig.
   *
   * Compared against the saved preference for the reason `keepAppearance`
   * gives — a ⌘= before the panel opened is still something to keep.
   *
   * The one thing that does go into `teleprompter` is Dark/Paper, as
   * `readerTheme`: it is not optics, so the preference's carrier cannot hold
   * it, and no prompter composition ever reads it. Written only when it moved,
   * so a Done that changed the size alone writes nothing there — and an absent
   * theme stays absent rather than being frozen in as a default.
   */
  async function keepReaderAppearance(): Promise<void> {
    const live = takeReaderPreferenceSettings();
    const theme = takeReaderThemeSetting();
    closeAppearanceSheet();
    const preferenceChanged = !readerPreferenceEquals(readerPreferenceFrom($settings.optical), live);
    const themeChanged = readerThemeFor($settings.teleprompter) !== theme;
    if (!preferenceChanged && !themeChanged) return;
    /*
     * Two sections, so two saves — the store queues them one behind the other
     * and either can be refused while the other lands. Settled rather than
     * raced, so the toast says which happened instead of claiming nothing was
     * saved over a preference that was.
     */
    const saves: Array<Promise<void>> = [];
    if (preferenceChanged) {
      saves.push(
        patchSettings(
          'optical',
          withReaderPreference($settings.optical, readerPreferenceReplacement(live)),
        ),
      );
    }
    if (themeChanged) saves.push(patchSettings('teleprompter', { readerTheme: theme }));
    const results = await Promise.allSettled(saves);
    const refused = results.filter((result) => result.status === 'rejected').length;
    if (refused === 0) {
      showToast('Reading appearance saved', 'info', { durationMs: 1600 });
    } else if (refused < results.length) {
      showToast('Only part of the reading appearance was saved. This read keeps its look.', 'danger');
    } else {
      // The same split `keepAppearance` reports: the save was refused, the
      // read keeps what is on the screen.
      showToast('Saved reading appearance was not changed. This read keeps its look.', 'danger');
    }
  }

  /** Cancel: the take goes back exactly as it was found, and nothing is saved. */
  function revertAppearance(): void {
    if (surfaceOnOpen === 'reader') {
      if (readerOnOpen) applyReaderAppearance(readerPreferenceReplacement(readerOnOpen));
      // Only when it moved: a Cancel that touched nothing must not leave the
      // take holding a choice of its own over the saved one.
      if (readerThemeOnOpen && readerThemeOnOpen !== takeReaderThemeSetting()) {
        applyReaderTheme(readerThemeOnOpen, { restoring: true });
      }
    } else if (appearanceOnOpen) {
      applyStageAppearance(appearanceOnOpen);
    }
    closeAppearanceSheet();
  }

  /*
   * FOCUS RETURN IS THE PANEL'S JOB NOW, AND IT ALWAYS SHOULD HAVE BEEN.
   *
   * There used to be a `focusSessionMenu` here that hunted the first button in
   * the chrome corner after the panel closed. It existed because that corner
   * REPLACED its trigger with the panel rather than layering over it, so the
   * opener the panel restores focus to was gone by the time it unmounted.
   *
   * The dock does not do that: the settings button stays mounted and stays put
   * while the panel is up, so `StageAppearanceSheet`'s own opener-restore lands
   * on the control somebody actually pressed. One mechanism, in the place that
   * owns the contract.
   */

  /**
   * The panel belongs to the take that opened it.
   *
   * This is component state and this component survives the end of a session —
   * Live stays mounted for the summary, and "Present again" starts a fresh take
   * inside it. A panel left open across that boundary remounts over the new
   * take holding the OLD take's rollback snapshot, and an `appearanceOpen` left
   * true suspends the new stage's keyboard until somebody opens and closes it.
   */
  $effect(() => {
    if ($session.active) return;
    closeAppearanceSheet();
  });

  /* ------------------------------------------------- §115 the take controls
   *
   * THE SCREEN'S CONTROLS FOR A TAKE ONLY EXISTED WHEN THERE WAS NO TAKE.
   *
   * Everything below `{#if $session.active}` — the status bar, the tracking
   * panel and its recovery actions, the microphone picker — sat in the `{:else}`
   * arm, because single-window presentation gives the whole window to the
   * stage. So the surface built to be watched DURING a read rendered only
   * before and after one. The microphone picker was the sharpest case: its
   * condition required an active voice take AND it rendered only when no take
   * was active, so it was not merely hidden, it was unsatisfiable — and
   * `onInputDeviceLost` had been written to stay silent precisely BECAUSE this
   * picker was supposed to be the remedy.
   *
   * ---------------------------------------------------------------------------
   * A SIBLING LAYER, NOT A RESTRUCTURED `{#if}`
   * ---------------------------------------------------------------------------
   * The obvious fix — move these controls inside the active arm alongside
   * `StageApp` — is the one that must not be taken. Svelte 5 has no reparenting:
   * changing the template path a component sits on destroys and recreates it.
   * `StageApp` holds the jerk-limited motion controller's state, the measured
   * line map and the opening plate's progress, so remounting it mid-take
   * restarts the read from its opening animation with the follower's history
   * gone. `StageApp`'s conditional is therefore left exactly as it was and this
   * layer is a SIBLING of it, mounted once for the life of the route.
   *
   * ---------------------------------------------------------------------------
   * PERIPHERAL BY DEFAULT
   * ---------------------------------------------------------------------------
   * The glass is what the presenter is reading and this must not cover it
   * uninvited, so it is a tab in the corner that opens a drawer, and nothing
   * opens it automatically — not even a dead microphone. A panel that appears
   * over the script by itself is a worse failure than the one it reports. The
   * tab carries the attention instead, and the drawer puts the remedy first.
   *
   * What is in here is what the issue named and what has nowhere else to go:
   * the status readout, microphone recovery, and the following panel with its
   * degraded-state actions. The transport is deliberately NOT duplicated — every
   * one of its actions already has both a keyboard shortcut that fires during a
   * take and a control on the stage's own dock, so a second copy would be a
   * surface to keep in sync for no new capability.
   *
   * (`takeControlsOpen`, `takeControlsTab` and `takeControlsPanel` are declared
   * at the top of this script, next to the microphone state.)
   */

  /**
   * The speech model was refused (#286): not the device, not the permission.
   * Its remedy is the Speech pane, for the next take — nothing in this one.
   */
  const voiceModelRefused = $derived(
    hasVoiceTransport &&
      !$session.voiceFollowingAvailable &&
      !$session.inputDeviceLost &&
      !$session.microphoneRefused,
  );

  /** Whether the status block has a remedy to carry; see `takeRemedy`. */
  const takeRemedyOffered = $derived(
    micAccessRecoveryOffered ||
      micRecoveryOffered ||
      voiceModelRefused ||
      $smoothFollow.candidates.length > 0,
  );

  /**
   * Something needs the operator, and the drawer is the only place it shows.
   *
   * A refused speech model is in here too: it is the one fault whose whole
   * explanation and remedy live only in the drawer — the status line, and the
   * way to the Speech pane — so a tab that stayed quiet about it pointed nowhere.
   */
  const takeControlsAttention = $derived(
    micRecoveryOffered ||
      micAccessRecoveryOffered ||
      voiceModelRefused ||
      $smoothFollow.notices.some((notice) => notice.action),
  );

  /**
   * The fault, said once, OUTSIDE the drawer.
   *
   * A closed drawer is inert, so nothing inside it can be heard; the tab's
   * accessible name changes, but a name is read only when somebody lands on it.
   * This is the one announcement a fault makes while the drawer is shut, and it
   * falls silent once the drawer is open, where the status block says it.
   */
  const takeControlsAnnouncement = $derived.by((): string => {
    if (takeControlsOpen) return '';
    if (micAccessRecoveryOffered) return 'Microphone not allowed. Open Take controls to fix it.';
    if (micRecoveryOffered) {
      return $session.inputDeviceLost
        ? 'Microphone disconnected. Open Take controls to choose another input.'
        : 'CandidCue is using a fallback input. Open Take controls to choose another.';
    }
    if (voiceModelRefused) return 'Voice unavailable for this take. Take controls has the details.';
    const actionable = $smoothFollow.notices.find((notice) => notice.action);
    return actionable ? `${actionable.title}. Open Take controls to fix it.` : '';
  });

  /** A Rescan's result, heard: the visible note under the picker is not a live region. */
  const micListingAnnouncement = $derived(
    !micRecoveryOffered
      ? ''
      : micListing === 'failed'
        ? 'Could not list microphones.'
        : micListing === 'done'
          ? micInputs.length === 0
            ? 'No microphones found.'
            : micInputs.length === 1
              ? '1 microphone found.'
              : `${micInputs.length} microphones found.`
          : '',
  );

  let takeControlsBody = $state<HTMLElement | null>(null);

  /**
   * Open on the fault, not on wherever the body was left.
   *
   * The drawer keeps its scroll position on purpose (see `.take-controls`), and
   * that is exactly what hid a remedy: read the diagnostics, close, then open
   * again for a dead microphone, and the body came back scrolled past the block
   * that explains it. Opened with attention up, it starts at the top, where the
   * status block and its remedy are. Focus is not moved.
   */
  function openTakeControls(): void {
    takeControlsOpen = true;
    if (takeControlsAttention) takeControlsBody?.scrollTo({ top: 0 });
  }

  /** And a fault that arrives while it is open is brought into view the same way. */
  let attentionWas = false;
  $effect(() => {
    const attention = takeControlsAttention;
    if (attention && !attentionWas && takeControlsOpen) takeControlsBody?.scrollTo({ top: 0 });
    attentionWas = attention;
  });

  function closeTakeControls(restoreFocus = true): void {
    if (!takeControlsOpen) return;
    takeControlsOpen = false;
    // Only back to a trigger that is still there. Closing because the take
    // ended takes the whole layer with it, and focusing a hidden button strands
    // the keyboard on an element the user cannot see.
    if (restoreFocus && $session.active) takeControlsTab?.focus();
  }

  /**
   * Escape closes the drawer, and must not reach the stage.
   *
   * CAPTURE PHASE, and that is the whole point. `StageApp` listens for Escape
   * on `<svelte:window onkeydown>` — bubble phase — and counts presses towards
   * the double-press that ends the take. A drawer that closed on Escape while
   * letting the event through would arm the teardown every time somebody
   * dismissed a panel, and dismissing twice would end the take outright.
   * Capturing on `window` runs before any bubble listener, so stopping
   * propagation here is what keeps "close this panel" and "end this take" from
   * being the same key.
   */
  /**
   * A dialog raised FROM the drawer is on top of it, and owns dismissal.
   *
   * The End-session confirmation is opened by a button inside this panel. Both
   * layers capture Escape on `window`, and `stopPropagation` does not stop
   * another listener on the SAME node — so Escape closed the confirmation AND
   * the drawer underneath it. Cancel-by-click was worse: the dialog's own
   * surface is "outside" the drawer, so clicking Cancel dismissed the drawer on
   * the way past. Either way, backing out of a question left the panel that
   * asked it gone. A question raised from outside Live (`confirmOpen`) sits on
   * top of the drawer the same way.
   */
  const dismissalSuspended = $derived(confirmingStop || confirmOpen || appearanceOpen);

  $effect(() => {
    if (!takeControlsOpen || dismissalSuspended) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeTakeControls();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  /** A click on the script behind it means "get out of the way". */
  $effect(() => {
    if (!takeControlsOpen || dismissalSuspended) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (takeControlsPanel?.contains(target) || takeControlsTab?.contains(target))) {
        return;
      }
      // No focus restore: the operator is pointing at something else.
      closeTakeControls(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  /**
   * The drawer belongs to the take, exactly as the appearance panel does.
   *
   * Live survives the end of a session — it stays mounted for the summary, and
   * "Present again" builds a fresh take inside it — so anything left open here
   * would reappear over the next take, and a stale device list would offer the
   * previous take's microphones as the cure for this one's.
   */
  $effect(() => {
    if ($session.active) return;
    takeControlsOpen = false;
    micInputs = [];
    micChoice = '';
    /*
     * `micSwitching` too, and it is the one that would actually strand somebody:
     * it disables both recovery buttons, so a switch still in flight when the
     * take ended would leave the NEXT take's picker permanently greyed out. The
     * bump retires any listing that is still coming.
     */
    micSwitching = false;
    micListing = 'idle';
    micRequest += 1;
  });
</script>

<!--
  The appearance panel, rendered by the stage's dock.

  A snippet handed across the bridge rather than a sibling element, because the
  panel has to be positioned against the settings button that raised it — 8px
  clear of it, left-aligned with the dock — and that button lives inside the
  stage's own operator plane. The contents and the transaction stay here, where
  the session state they read and write actually is.
-->
{#snippet appearancePanel()}
  <StageAppearanceSheet
    surface={readerSurface ? 'reader' : 'prompter'}
    appearance={$session.stageAppearance}
    reader={$session.stageReaderAppearance}
    readerTheme={stageReaderTheme}
    rigResolved={$session.stageRigResolved}
    automatic={stageSizedAutomatically}
    maxFontSizePx={$session.stageFontCeilingPx}
    charactersPerLine={stageCharactersPerLine}
    onchange={(patch) => applyStageAppearance(patch)}
    onreaderchange={(patch) => applyReaderAppearance(patch)}
    onreaderthemechange={(theme) => applyReaderTheme(theme)}
    onok={() => void keepAppearance()}
    oncancel={revertAppearance}
  />
{/snippet}

<!--
  §115. The three blocks below are rendered in TWO places — the `.live` screen
  that shows before and after a take, and the take-controls drawer that shows
  during one — so they are snippets rather than copies. The duplication they
  replace is the kind that rots: a pill added to one status bar and not the
  other reads as a pill that works sometimes.
-->
<!--
  The console's continuous health, as STATUS LIGHTS (§12.3, §9.4).

  ---------------------------------------------------------------------------
  WHY THESE STOPPED BEING PILLS
  ---------------------------------------------------------------------------
  This was a row of four `StatusPill`s of equal visual weight: the mode, the
  connection, the stage, the microphone. §9.4's test is whether the capsule
  SHAPE helps scanning, and for four adjacent always-present states it does the
  opposite — every one of them shouts equally, so a genuine fault reads exactly
  like "Mic live". §12.3 asks for a small coloured light plus text for
  continuous states, with pills reserved for the exceptional and the actionable.

  So: a dot and a word for each.

  Colour is never the whole signal. Each light is accompanied by its own words
  ("Mic live", "Mic lost"), so the state survives a monochrome display and a
  colour-blind reader.
-->
{#snippet partStatus(stacked = false)}
  <!--
    §parts. Which piece of the script this take is recording, and whether the
    presenter has read to the end of it.

    RENDERED IN TWO PLACES, and it had to be. Everything under
    `{#if $session.active}` is the embedded stage — during a single-window take
    this route IS the prompter — so the console status bar below it is only on
    screen when no take is running. Put there alone, this said nothing during
    the one period it describes. The take-controls drawer is the surface that
    survives into a live take, and it is where the rest of the operator's
    readouts already live: the clock, the session status, the pills.

    The completed state is a QUIET one. It is not an alarm and it is not an
    instruction: nothing stops, and reading on past the boundary is a legitimate
    thing to do. It says the part is covered and leaves the decision alone —
    which is also why it does not raise the drawer's attention marker, a signal
    reserved for faults.
  -->
  {#if $session.part}
    <!--
      `stacked` is the drawer's form: the ordinal and the name on their own
      lines, the name wrapping. The drawer is a third of a prompter panel wide,
      and on one line "Quarterly results f…" left the part unreadable and the
      status beside it running into the close button.
    -->
    {#if stacked}
      <span
        class="take-part stacked"
        class:complete={$session.partComplete}
        role="status"
        aria-live="polite"
      >
        <span class="part-ordinal">
          Part {$session.part.ordinal} of {$session.part.totalParts}
          {#if $session.partComplete}<span class="part-done">· end reached</span>{/if}
        </span>
        <span class="part-label">{$session.part.label}</span>
      </span>
    {:else}
      <span class="take-part" class:complete={$session.partComplete} role="status" aria-live="polite">
        Part {$session.part.ordinal} of {$session.part.totalParts} · {$session.part.label}
        {#if $session.partComplete}<span class="part-done">— end reached</span>{/if}
      </span>
    {/if}
  {/if}
{/snippet}

{#snippet statusPills(withMode = true)}
  <!--
    The drawer leaves the mode out. In a voice take it read "Follow voice" — the
    same words as the button that resumes following — beside a status saying
    "Text held", so a light describing what the take was OPENED as read as a
    claim about what the text was doing. The drawer's status line says that.
  -->
  {#if withMode}
    <span class="live-status">
      <span class="status-dot accent" aria-hidden="true"></span>
      {modeLabel}
    </span>
  {/if}
  <!--
    Only a voice take has a realtime connection and an open microphone to
    report. Anything else says so plainly instead of showing the
    `initial` optimism of "Connected · Mic live".
  -->
  {#if hasVoiceTransport}
    <span class="live-status">
      <span class="status-dot {connection.tone}" aria-hidden="true"></span>
      {connection.label}
    </span>
    <!--
      A refused speech model leaves no capture running, so `micState` is
      'disconnected' — but the microphone opened normally and nothing about it
      is at fault. "Mic lost" there sent the presenter to debug working
      hardware (#286), so the refusal is named instead, and in a neutral light:
      the toast already said what to do about it.

      A device that really was lost still says so first. The two can coexist —
      a refused resume, then the input unplugged — and the input is the one
      the presenter can fix from this drawer.
    -->
    <span class="live-status">
      <span
        class="status-dot {$session.inputDeviceLost || $session.microphoneRefused
          ? 'danger'
          : !$session.voiceFollowingAvailable
            ? 'neutral'
            : $session.micState === 'live'
              ? 'success'
              : $session.micState === 'muted'
                ? 'neutral'
                : 'danger'}"
        aria-hidden="true"
      ></span>
      {$session.inputDeviceLost
        ? 'Mic lost'
        : $session.microphoneRefused
          ? 'Mic not allowed'
          : !$session.voiceFollowingAvailable
          ? 'Voice unavailable'
          : $session.micState === 'live'
            ? 'Mic live'
            : $session.micState === 'muted'
              ? 'Mic off'
              : 'Mic lost'}
    </span>
  {:else}
    <span class="live-status">
      <span class="status-dot neutral" aria-hidden="true"></span>
      No microphone
    </span>
  {/if}
{/snippet}

<!--
  §28.2. Losing a microphone mid-take used to be a dead end: the toast
  said "choose an input" and there was nowhere to choose one. The
  transport can replace its sender track without renegotiating, so the
  recovery is a picker right where the failure is reported.
-->
{#snippet micRecovery(stacked = false)}
  {#if micRecoveryOffered}
    <!--
      `stacked` in the drawer: the picker on its own full-width line and the
      two actions under it. Squeezed into one row at a third of a 1024px panel,
      "Use this input" overflowed its own button and ran into Rescan.
    -->
    <div class="mic-recovery" class:stacked>
      {#if stacked && !$session.inputDeviceLost}
        <p class="lf-note">
          CandidCue is using a fallback input. Choose the microphone you meant to use.
        </p>
      {/if}
      {#if stacked && micListing === 'failed'}
        <p class="lf-note listing">Could not list microphones. Choose Rescan to try again.</p>
      {:else if stacked && micListing === 'done' && micInputs.length === 0}
        <p class="lf-note listing">No microphones found. Connect one, then choose Rescan.</p>
      {:else if stacked && micListing === 'scanning' && micInputs.length === 0}
        <p class="lf-note listing">Looking for microphones…</p>
      {/if}
      <select
        class="mic-picker"
        aria-label="Input device"
        disabled={micSwitching || micInputs.length === 0}
        bind:value={micChoice}
      >
        {#each micInputs as input (input.deviceId)}
          <option value={input.deviceId}>{input.label}</option>
        {/each}
      </select>
      <span class="mic-recovery-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={micSwitching || !micChoiceListed}
          onclick={() => useMicrophone()}
        >
          {micSwitching ? 'Switching…' : 'Use this input'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={micSwitching || micListing === 'scanning'}
          onclick={() => refreshMicInputs()}
        >
          {micListing === 'scanning' ? 'Scanning…' : 'Rescan'}
        </Button>
      </span>
    </div>
  {/if}
{/snippet}

{#snippet micAccessRecovery()}
  <!--
    #303. Both halves of the way back: the pane where it is allowed, and the
    retry once it has been. Not the input picker — that is the remedy for a
    device, and this is not one.

    No title and no status role of its own. It renders inside the status block
    that already says "Microphone not allowed", and its own heading said the
    same thing a second time, a few pixels above a third.
  -->
  {#if micAccessRecoveryOffered}
    <div class="mic-access">
      <p class="lf-note">
        The switch is in Privacy &amp; Security → Microphone. If CandidCue is already on there,
        quit and reopen CandidCue.
      </p>
      <div class="mic-access-actions">
        <Button size="sm" variant="primary" onclick={() => void openMicrophonePrivacySettings()}>
          Open System Settings
        </Button>
        <Button size="sm" disabled={micRetrying} onclick={() => void retryMicrophoneAccess()}>
          {micRetrying ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    </div>
  {/if}
{/snippet}

<!--
  What the operator can do about the drawer's status, rendered INSIDE the
  status block rather than above it. Each arm is exclusive with the others by
  the session's own flags: a refusal is not a lost device (#303), and a refused
  speech model is neither (#286).
-->
{#snippet takeRemedy()}
  {@render micAccessRecovery()}
  {@render micRecovery(true)}
  {#if voiceModelRefused}
    <div class="mic-access-actions">
      <Button size="sm" onclick={() => void openSettingsWindow('speech')}>
        Open Speech settings
      </Button>
    </div>
  {/if}
  {#if $smoothFollow.candidates.length > 0}
    <FollowControls follow={$smoothFollow} part="candidates" />
  {/if}
{/snippet}

{#snippet stageFaultNotice()}
  <!--
    THE TAKE MOVED PANELS AFTER IT OPENED (CCUX-010).

    Three sentences in the order the guide asks a fault to answer them: what
    happened, what CandidCue did to keep the take safe, and what the user can do
    now. It is `status` rather than `alert` and carries no danger tone, because
    nothing has failed — the text is perfectly readable, it is simply sized for
    the panel this take was measured against. Alarming a presenter mid-take over
    typography would cost more than the typography does.

    There is no in-take repair offered, and that is honest: the optics were
    resolved once from the opening panel, and re-resolving them means rebuilding
    the stage document under a presenter who is reading from it.
  -->
  {#if $session.displayChangedTo}
    <div class="stage-window-fault" role="status">
      <p class="lf-title">This window moved to {$session.displayChangedTo}</p>
      <p class="lf-note">
        Text sizing still matches the display this take started on, so it may look larger or smaller
        than usual. The take is otherwise unaffected — end and present again to size it for this
        display.
      </p>
    </div>
  {/if}
{/snippet}

{#if $session.active}
  {#if $session.stageEnvelope}
    <StageApp
      embedded={{
        envelope: $session.stageEnvelope,
        alignment: $session.snapshot,
        transcript: $session.transcriptTail.at(-1) ?? '',
        voicePill: $session.voicePill,
        ack: $session.stageAck,
        // The switch, not the symptom: an automatic hold stops following too,
        // and the stage words that one as the fault it is (§48).
        followPaused: $session.followPausedByUser,
        autoScroll: $autoScrollLive,
        blanked: $session.stageBlanked,
        presentationMode: $session.stagePresentationMode,
        // A paused take holds a reading window's text; the stage decides it
        // only applies there (see `takePaused` on the bridge).
        takePaused: $session.paused !== 'none',
        scriptTitle: $session.scriptTitle,
        onpresentationtoggle: () => void togglePresentationMode(),
        /*
         * §practice. Kept on the session rather than derived from the window,
         * because a practice that pops out to the display with ⌃⌘F is still a
         * practice — the window is how it opens, not what it is.
         */
        practice: $session.practice,
        /*
         * Already confirmed, so it does not go through `requestEndSession`.
         * The stage raises this from two gestures and both have asked: the
         * dock's End button puts its own confirmation up first, and Escape
         * requires a second press within the double-press window. Routing them
         * through the settings-gated dialog would ask twice for one decision.
         */
        onexit: endTake,
        onintent: handleEmbeddedStageIntent,
        chromeOpen: stageChromeOpen,
        appearancePanel,
        appearanceOpen,
        onappearanceopen: openAppearanceSheet,
        /*
         * A click away, or Escape, means CANCEL — not "leave it as it is".
         * The panel applies every drag to the running take on the way past, so
         * a dismissal that merely closed would silently keep changes the
         * operator never confirmed, with the button that would have undone
         * them gone.
         */
        onappearanceclose: revertAppearance,
        onmeasurement: (measurement) => {
          stageCharactersPerLine = measurement.charactersPerLine ?? null;
          // What the window is actually drawn at, for the reader's size controls.
          noteStageRenderedFontSize(measurement.bodyFontSizePx);
        },
      }}
    />
  {:else}
    <div class="stage-preparing" class:paper={paperTake}>Preparing script…</div>
  {/if}
{:else}
<div class="live">
  <!-- Top status bar (§15.1) -->
  <header class="statusbar">
    <div class="status-left">
      <span class="live-dot" class:paused={$session.paused !== 'none' || !$session.prompting}></span>
      <span class="script-title">{$session.scriptTitle}</span>
      {@render partStatus()}
      <span class="elapsed">{formatClock($session.elapsedSeconds)}</span>
      <!-- F.11 session status; the follow state itself lives in the Tracking panel. -->
      <span class="session-status" role="status" aria-live="polite">{$liveStatusLabel}</span>
    </div>
    <div class="status-right">
      {@render statusPills()}
      {@render micRecovery()}
      <span class="display-name">{$session.displayLabel}</span>
    </div>
  </header>

  <!-- Main three-region area (§15.1) -->
  <div class="main">
    <aside class="outline" aria-label="Sections" style="width: {$workspace.liveOutlineWidth}px">
      <p class="region-label">Sections</p>
      {#if flatOutline.length > 0}
        <ul class="outline-list">
          {#each flatOutline as entry, index (entry.node.id)}
            <li>
              <button
                type="button"
                class="outline-item"
                class:current={index === currentSectionIndex}
                style="padding-left: {10 + entry.depth * 12}px"
                onclick={() => jumpToSection(entry.node)}
              >
                {entry.node.title}
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="region-empty">No headings in this script.</p>
      {/if}
    </aside>
    <PaneDivider
      orientation="vertical"
      side="leading"
      label="Sections width"
      value={$workspace.liveOutlineWidth}
      min={PANE_LIMITS.liveOutline.min}
      max={PANE_LIMITS.liveOutline.max}
      defaultValue={PANE_LIMITS.liveOutline.default}
      onresize={(w) => setPaneWidth('liveOutline', w)}
    />

    <section class="preview" aria-label="Stage preview">
      {#if $session.stageBlanked}
        <div class="blanked">
          <Icon name="eye-off" size={22} />
          <p>Stage blanked</p>
        </div>
      {:else if previewWindow.length > 0}
        <div class="preview-text">
          {#each previewWindow as entry (entry.sentence.id)}
            <p
              class="preview-sentence"
              class:past={entry.offset < 0}
              class:current={entry.offset === 0}
            >
              {entry.sentence.normalizedText}
            </p>
          {/each}
        </div>
      {:else}
        <div class="preview-placeholder">
          <p class="ph-title">Stage preview</p>
          <!--
            "Cursor at token 417" is gone. A token is the engine's own unit — a
            measured span on the glass — and it is not a word index, not a
            character offset and not convertible into either by anybody reading
            this. It leaked an implementation detail into the one line here
            addressed to the presenter, and said nothing they could use.
          -->
          <!--
            "Where you are", not "the stage".

            This said "the scaled stage view appears here", which is a claim
            this panel does not honour: what it renders is a handful of
            normalised sentences in workspace type, with none of the stage's
            optics, geometry, mirroring or line breaking. §12.5 asks for it to
            be EXPLICIT whether a preview is optically exact or only
            representative, and the honest answer here is that it is neither —
            it is a position readout.
          -->
          <p class="ph-note">
            The lines around your place appear here once the script has compiled. This is a
            position readout, not an optical preview of the glass.
          </p>
        </div>
      {/if}
    </section>

    <!--
      A real divider on both rails (§12.2).

      These were `grid-template-columns: 200px minmax(0,1fr) 304px` with a media
      query that HID the outline below 1100px — a laid-out console rather than an
      operated one. An operator working a rig wants the diagnostics wide while
      hunting a fault and narrow while reading; the widths are theirs now, and
      they are remembered.
    -->
    <PaneDivider
      orientation="vertical"
      side="trailing"
      label="Diagnostics width"
      value={$workspace.diagnosticsWidth}
      min={PANE_LIMITS.liveDiagnostics.min}
      max={PANE_LIMITS.liveDiagnostics.max}
      defaultValue={PANE_LIMITS.liveDiagnostics.default}
      onresize={(w) => setPaneWidth('liveDiagnostics', w)}
    />
    <aside class="diagnostics" aria-label="Tracking" style="width: {$workspace.diagnosticsWidth}px">
      <p class="region-label">Tracking</p>
      <FollowStatePanel
        follow={$smoothFollow}
        sectionTitle={currentSectionTitle}
        voiceInput={hasVoiceTransport}
        micState={$session.micState}

        inputDeviceLost={$session.inputDeviceLost}
        microphoneRefused={$session.microphoneRefused}

        heardAnything={$session.heardAnything}

        heldByUser={$session.followPausedByUser}

        rollingAtPace={$autoScrollLive.running}
        onnoticeaction={handleNoticeAction}
      />

      <!--
        The follow CONTROLS stay visible — they are things an operator reaches
        for mid-take, not readings. The numbers behind them do not: §12.6's
        "raw alignment and performance details behind disclosure".
      -->
      <p class="region-label">Following</p>
      <FollowControls follow={$smoothFollow} />

      <Disclosure label="Follow diagnostics">
        <FollowDiagnostics
          follow={$smoothFollow}
          developerMode={$settings.following.developerDiagnostics}
        />
      </Disclosure>

      <!--
        THE RAW TRANSCRIPT IS BEHIND A DISCLOSURE (§12.6).

        §12.6: default to a concise status summary, and put raw alignment,
        transcript and performance detail behind disclosure. This is the raw
        recogniser output — the most engineering-looking thing on the console —
        and it was open by default, competing with the fault states above it for
        the operator's attention while a take runs.

        It stays one click away rather than moving to a Diagnostic mode,
        because it is the first thing anybody looks at when following goes
        wrong: "is it hearing me at all" is answered here and nowhere else on
        this pane.
      -->
      <Disclosure label="Raw transcript">
        {#if $session.transcriptTail.length > 0}
          <div class="transcript-tail">
            {#each $session.transcriptTail as line, index (index)}
              <p class="tail-line" class:latest={index === $session.transcriptTail.length - 1}>
                {line}
              </p>
            {/each}
          </div>
        {:else}
          <p class="region-empty">Speak and the latest transcript appears here.</p>
        {/if}
      </Disclosure>

      <p class="region-label">Stage</p>
      {@render stageFaultNotice()}
      <div class="quick-controls">
        <div class="font-row">
          <IconButton
            icon="chevron-down"
            label="Decrease stage text"
            onclick={() => adjustFontSize(-2)}
          />
          <span class="font-value">{stageFontSize} px</span>
          <IconButton
            icon="chevron-up"
            label="Increase stage text"
            onclick={() => adjustFontSize(2)}
          />
        </div>
        <Button size="sm" onclick={() => toggleMirror()}>Mirror text</Button>
      </div>

      <!--
        THE FIXED-SPEED SLIDER IS GONE FROM HERE, AND NOT BECAUSE IT STOPPED
        MATTERING.

        It was a disabled range input beside the words "not available yet". The
        transport exists now — but this panel does not render during a take
        (single-window presentation replaces the whole screen with the stage),
        so a live control here would set a pace for a session that is over.
        Its two real homes are Settings, where the saved default lives, and the
        `[` / `]` keys, which are the only interface that exists at the moment
        somebody actually needs to change it.
      -->
      <p class="region-empty">
        Auto-scroll rolls the script at a set pace when your voice is not getting through.
        Press <kbd>A</kbd> during a take to start it, <kbd>[</kbd> and <kbd>]</kbd> to change
        the pace. Its starting speed is under Settings → Teleprompter.
      </p>
    </aside>
  </div>

  <!-- Bottom transport (§15.1) — always visible -->
  <footer class="transport" bind:clientHeight={transportHeightPx}>
    <div class="transport-left">
      <!--
        Every transport control names its key (§12.4: "Show keyboard shortcuts
        in tooltips and the Session menu"). During a take the operator's hands
        are on the keyboard and the transport is across the desk, so the tooltip
        is where somebody learns the key they will actually use.

        `transportKey` spells them for this platform through the same
        `formatAccelerator` the menu and the Shortcuts dialog use, so a key
        cannot be advertised here in a form the app does not answer.
      -->
      {#if !$session.prompting}
        <Button
          variant="primary"
          title={`Start (${transportKey('Space')})`}
          onclick={() => startPrompting()}
        >
          <Icon name="play" size={16} />
          Start
        </Button>
      {:else if $session.paused === 'none'}
        <div class="pause-split">
          <Button title={`Pause (${transportKey('Space')})`} onclick={() => pauseListening()}>
            <Icon name="pause" size={16} />
            Pause
          </Button>
          <!--
            Left-aligned, because this trigger lives at the LEFT end of the
            transport. The default right alignment pins the popover's right edge
            to the trigger, and this menu's one item is a long `nowrap` label — so
            it extended roughly 320px leftwards from a trigger sitting about 145px
            in, putting its opening words at a negative coordinate. That truncated
            the only route to "Hard pause — mic off" in the app.
          -->
          <OverflowMenu
            label="Pause options"
            align="left"
            items={[
              {
                label: 'Hard pause — mic off, resume by click only',
                onselect: () => hardPause(),
              },
            ]}
          />
        </div>
      {:else}
        <Button
          variant="primary"
          title={`Resume (${transportKey('Space')})`}
          onclick={() => resumeSession()}
        >
          <Icon name="play" size={16} />
          Resume
        </Button>
      {/if}
      <!--
        End keeps its own place at the end of the left group, never moving with
        the primary control beside it (§12.4: "Place End Take separately and
        consistently; do not let it move with secondary actions").
      -->
      <Button
        variant="danger"
        title={`End take (${transportKey('Mod+.')})`}
        onclick={() => requestEndSession()}
      >
        <Icon name="stop" size={14} />
        End take
      </Button>
    </div>

    <div class="transport-center">
      <IconButton
        icon="chevron-left"
        label={`Back one sentence (${transportKey('Alt+Left')})`}
        onclick={() => moveSentences(-1)}
      />
      <IconButton
        icon="chevron-right"
        label={`Forward one sentence (${transportKey('Alt+Right')})`}
        onclick={() => moveSentences(1)}
      />
      <IconButton icon="restore" label="Restart paragraph" onclick={() => restartParagraph()} />
      <IconButton
        icon="eye-off"
        label={$session.stageBlanked ? 'Unblank stage' : 'Blank stage'}
        active={$session.stageBlanked}
        onclick={() => toggleBlankStage()}
      />
    </div>

    <div class="transport-right">
      <label class="voice-follow">
        <input
          type="checkbox"
          checked={$session.voiceFollow}
          onchange={() => toggleVoiceFollow()}
        />
        <span>Voice follow</span>
      </label>
    </div>
  </footer>
</div>
{/if}

<!--
  §115 take controls — a SIBLING of the block above, never inside it.

  Placed here so `StageApp`'s template path never changes: Svelte 5 does not
  reparent, and moving that component would remount it, throwing away the motion
  controller's state and restarting the read from the opening plate. This layer
  mounts once for the life of the route and shows or hides itself with CSS.

  `pointer-events: none` on the layer with `auto` only on the tab and the panel,
  so the ~90% of the screen this covers stays click-through to the stage
  underneath. `inert` when closed (and whenever no take is running) keeps a
  hidden drawer out of the tab order and away from screen readers — the reason
  it is `inert` rather than `display: none` is that the drawer holds a `<select>`
  and its scroll position, and destroying that markup on every close would reset
  the operator's device choice mid-recovery.

  NOT `aria-modal`. The page behind it is deliberately still live and still
  clickable; claiming a modal would tell assistive technology the opposite of
  what the layer actually does.
-->
<!--
  On a paper read the drawer and its tab take the light workspace palette, so
  the one control surface over the page is not a dark slab on it. Unset — the
  studio palette, exactly as before — for every other take.
-->
<div
  class="take-controls"
  class:presenting={$session.active}
  inert={!$session.active}
  data-theme={paperTake ? 'workspace' : undefined}
>
  <button
    type="button"
    class="tc-tab"
    class:attention={takeControlsAttention}
    class:open={takeControlsOpen}
    aria-expanded={takeControlsOpen}
    aria-controls="take-controls-panel"
    aria-label={takeControlsAttention ? 'Take controls — needs attention' : 'Take controls'}
    bind:this={takeControlsTab}
    onclick={() => (takeControlsOpen ? closeTakeControls() : openTakeControls())}
  >
    <Icon name={takeControlsOpen ? 'chevron-right' : 'chevron-left'} size={14} />
    <span class="tc-tab-label">Take controls</span>
    <!--
      The attention marker is on the TAB, and nothing auto-opens the drawer.
      A panel that appears over the script by itself is a worse interruption
      than the fault it reports, so this points at the remedy instead of
      performing it.

      Decorative: the same fact is already in the button's accessible name, and
      a bare dot announced separately would say nothing a screen reader could
      use.
    -->
    {#if takeControlsAttention}
      <span class="tc-dot" aria-hidden="true"></span>
    {/if}
  </button>

  <!-- Always mounted, outside the inert panel, so a change in them is heard. -->
  <span class="sr-only" role="status" aria-live="polite">{takeControlsAnnouncement}</span>
  <span class="sr-only" role="status" aria-live="polite">{micListingAnnouncement}</span>

  <section
    class="tc-panel"
    class:open={takeControlsOpen}
    id="take-controls-panel"
    aria-label="Take controls"
    aria-hidden={!takeControlsOpen}
    inert={!takeControlsOpen}
    bind:this={takeControlsPanel}
  >
    <!--
      THREE BANDS: a header that never scrolls away, a body that scrolls, and a
      footer that holds End take on its own.

      The panel used to be one scroller with End take pushed down by
      `margin-top: auto`, so expanding the diagnostics carried the clock, the
      close button and the only way to end the take out of view together.
    -->
    <header class="tc-head">
      <div class="tc-head-row">
        <span class="tc-elapsed">{formatClock($session.elapsedSeconds)}</span>
        <span class="tc-close">
          <IconButton icon="x" label="Close take controls" onclick={() => closeTakeControls()} />
        </span>
      </div>
      {@render partStatus(true)}
      <div class="tc-lights">{@render statusPills(false)}</div>
    </header>

    <div class="tc-body" bind:this={takeControlsBody}>
      <!--
        The answer FIRST, with its remedy inside it. When this drawer is opened
        during a take it is usually because the tab was showing attention, and
        a dead microphone is the fault with the shortest fuse — so the picker or
        the privacy-pane buttons sit under the sentence that explains them, not
        in a block of their own above it.
      -->
      <FollowStatePanel
        follow={$smoothFollow}
        sectionTitle={currentSectionTitle}
        voiceInput={hasVoiceTransport}
        micState={$session.micState}
        inputDeviceLost={$session.inputDeviceLost}
        microphoneRefused={$session.microphoneRefused}
        voiceAvailable={$session.voiceFollowingAvailable}
        connection={$session.connection}
        heardAnything={$session.heardAnything}
        heldByUser={$session.followPausedByUser}
        rollingAtPace={$autoScrollLive.running}
        takePaused={$session.paused}
        remedy={takeRemedyOffered ? takeRemedy : undefined}
        onnoticeaction={handleNoticeAction}
      />

      <FollowControls follow={$smoothFollow} part="routine" heldByUser={$session.followPausedByUser} />

      {@render stageFaultNotice()}

      <!--
        "Why did it move?" and Copy diagnostics, HERE because this is the only
        place a take can reach them. They used to live only in the console's
        Tracking rail, which a take replaces with the stage — so the explanation
        of an odd movement, and the export written for a bug report, were on a
        panel nobody could open while the movement was happening. Collapsed by
        its own disclosure; nothing about it is in the presenter's way.
      -->
      <FollowDiagnostics
        follow={$smoothFollow}
        developerMode={$settings.following.developerDiagnostics}
      />
    </div>

    <footer class="tc-foot">
      <Button
        variant="danger"
        title={`End take (${transportKey('Mod+.')})`}
        onclick={() => void requestEndSession()}
      >
        End take
      </Button>
      <kbd class="tc-key">{transportKey('Mod+.')}</kbd>
    </footer>
  </section>
</div>

<style>
  .stage-preparing {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: #000;
    color: #777;
  }
  /* A paper read opens on paper: the stage's field and its secondary ink
     (4.9:1, a shade above the dark plate's 4.7:1). */
  .stage-preparing.paper {
    background: #f6f2ea;
    color: #6d6961;
  }

  /*
   * THE PRESENTATION CORNER'S STYLES ARE GONE WITH THE CORNER.
   *
   * They dressed an OverflowMenu and its dropdown in glass so they could float
   * over a running prompter, plus an idle-fade and a `@supports` fallback. All
   * of that now lives in the stage's own dock, where the geometry tokens it
   * shares with the hold chip and the transcript are. The appearance panel is
   * handed across as a snippet and positions itself against the button that
   * raised it.
   */

  .live {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-app);
    color: var(--text-primary);
  }

  /* --- status bar --- */
  .statusbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    background: var(--bg-chrome);
    border-bottom: 1px solid var(--border);
  }
  /*
   * A status light: a 7px dot and a word (§12.3).
   *
   * Deliberately quieter than the pill it replaces. Four of these sit together
   * and none of them is news — they are the console's resting vital signs, and
   * a fault has to be able to shout over them. `--live-status-*` colours come
   * from the shared status tokens so a warning here is the same warning
   * everywhere else.
   */
  .live-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .status-dot {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .status-dot.accent {
    background: var(--accent);
  }
  .status-dot.success {
    background: var(--success);
  }
  .status-dot.warning {
    background: var(--warning);
  }
  .status-dot.danger {
    background: var(--danger);
  }
  .status-dot.neutral {
    background: var(--text-faint);
  }

  .status-left {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .live-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--live);
    flex: 0 0 auto;
  }
  .live-dot.paused {
    background: var(--text-faint);
  }
  .script-title {
    font-size: var(--text-base);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .take-part {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* Shrinks before the title and the clock do: of the three, this is the one
       that can be read from a truncated form. */
    min-width: 0;
  }
  .take-part.complete {
    color: var(--text-primary);
  }
  .part-done {
    color: var(--accent-strong);
    font-weight: 600;
  }
  .elapsed {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .status-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 0 0 auto;
  }
  .display-name {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* --- §28.2 mid-session input recovery --- */
  .mic-recovery {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .mic-recovery-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .mic-recovery.stacked {
    flex-direction: column;
    align-items: stretch;
  }
  .mic-recovery.stacked .mic-picker {
    max-width: none;
    min-height: var(--toolbar-control-h);
  }
  .mic-picker {
    max-width: 180px;
    padding: 3px var(--space-2);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
  }
  /* Quiet focus: a background/border shift, never an accent ring. */
  .mic-picker:focus-visible {
    outline: none;
    background: var(--bg-elevated);
    border-color: var(--focus-quiet);
  }
  .mic-picker:disabled {
    opacity: 0.6;
  }

  /* --- #303 the microphone was refused --- */
  /* Inside the status block, which draws the frame and the bar. */
  .mic-access {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .mic-access-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .lf-title {
    margin: 0 0 2px;
    font-size: var(--text-xs);
    font-weight: 650;
    color: var(--text-primary);
  }
  .lf-note {
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--text-muted);
    line-height: 1.45;
  }
  /* --- CCUX-010 the take moved panels --- */
  .stage-window-fault {
    position: relative;
    margin-bottom: var(--space-3);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
  }
  .stage-window-fault::before {
    content: '';
    position: absolute;
    left: 5px;
    top: var(--space-3);
    bottom: var(--space-3);
    width: 3px;
    border-radius: var(--radius-pill);
    /*
     * A statement, not an alarm: nothing has failed, and colouring it as though
     * something had would teach people to ignore the bars that matter.
     */
    background: var(--accent);
  }

  /* ------------------------------------------------- §115 the take controls
   *
   * Layered at 40: above the stage it floats over, and deliberately BELOW the
   * dialog host (100) and the toast region (120), so the end-of-session summary
   * and any notice still land on top of it rather than behind it. The present
   * cover at 9999 clears all of them, which is why the summary is shown after
   * the cover falls rather than under it.
   */
  .take-controls {
    position: fixed;
    inset: 0;
    z-index: 40;
    /*
     * The layer spans the window but must not intercept it: the stage
     * underneath owns wheel, drag and click, and a full-window sheet of
     * invisible `pointer-events` over a running prompter would swallow every
     * one of them. Only the tab and the panel take input back.
     */
    pointer-events: none;
    /*
     * Hidden outside a take rather than unmounted, so the panel's `<select>`
     * keeps its value and scroll position across an open/close cycle. The
     * `inert` attribute in the markup is what removes it from the tab order
     * and the accessibility tree; this is only the paint.
     */
    visibility: hidden;
  }
  .take-controls.presenting {
    visibility: visible;
  }

  /*
   * The way in. Full opacity, a readable label and an edge that holds against
   * black glass.
   *
   * It was 12px at 55% opacity — about 2.9:1 for its label — on the reasoning
   * that it should not compete with the script. It is the only route to the
   * microphone picker mid-take, and a recovery surface nobody can find is worse
   * than a quiet tab. It stays small and grey; it just stays readable.
   */
  .tc-tab {
    position: absolute;
    top: var(--space-4);
    right: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--button-h);
    padding: 0 var(--space-3) 0 10px;
    border: 1px solid var(--focus-quiet);
    /* No crescent: the tab is flush to the right edge, so it is genuinely
       three-sided rather than a rounded box missing a border. */
    border-right: none;
    border-radius: var(--radius-md) 0 0 var(--radius-md);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    pointer-events: auto;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .tc-tab:hover {
    background: var(--bg-hover-surface);
    color: var(--text-primary);
  }
  /* Quiet focus: a background/border shift, never an accent ring. */
  .tc-tab:focus-visible {
    outline: none;
    background: var(--bg-hover-surface);
    color: var(--text-primary);
    border-color: var(--text-secondary);
  }
  /*
   * Needs attention: the edge and the marker turn, and the words brighten.
   * Colour is not the whole signal — the marker is a shape that is otherwise
   * absent, and the accessible name says it in words.
   */
  .tc-tab.attention {
    border-color: var(--danger);
    color: var(--text-primary);
  }
  .tc-tab-label {
    white-space: nowrap;
  }
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
  .tc-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-pill);
    background: var(--danger);
  }

  .tc-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(clamp(340px, 28vw, 400px), 92vw);
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-pop);
    pointer-events: auto;
    /* Off-canvas rather than removed — see `.take-controls`. */
    transform: translateX(100%);
    transition: transform var(--dur-med) var(--ease-out);
  }
  .tc-panel.open {
    transform: translateX(0);
  }
  /*
   * A closed drawer sits just off the right edge, and its drop shadow does
   * not: on black it falls on black, on paper it is a grey bar down the side
   * of the read. So on paper the shadow is only there while it is open.
   */
  .take-controls[data-theme='workspace'] .tc-panel:not(.open) {
    box-shadow: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .tc-panel,
    .tc-tab {
      transition: none;
    }
  }

  /* --- header: the take, and the way out of the drawer ------------------ */
  .tc-head {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--divider);
  }
  .tc-head-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 32px;
  }
  .tc-elapsed {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    font-size: var(--text-2xl);
    line-height: 1;
    font-weight: 600;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }
  /* The close button never shrinks and never shares its space with words. */
  .tc-close {
    flex: 0 0 auto;
    margin-left: auto;
    display: inline-flex;
  }
  .take-part.stacked {
    display: flex;
    flex-direction: column;
    gap: 1px;
    white-space: normal;
    overflow: visible;
  }
  .part-ordinal {
    font-size: var(--text-meta);
    color: var(--text-muted);
  }
  .part-label {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }
  .tc-lights {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-4);
  }

  /* --- body: the answer, the routine, the record ------------------------ */
  .tc-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-4) var(--space-4) var(--space-2);
  }
  /* The disclosure draws its own rule; the body's gap is the space above it. */
  .tc-body > :global(.disclosure) {
    margin-top: calc(-1 * var(--space-2));
  }
  .tc-body .stage-window-fault {
    margin-bottom: 0;
    background: var(--bg-panel);
  }
  .tc-body .lf-title {
    font-size: var(--text-sm);
  }
  .tc-body .lf-note {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    text-wrap: pretty;
  }

  /* --- footer: ending the take, on its own ------------------------------ */
  .tc-foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--divider);
  }
  /* The ghost button's own inset, cancelled so its words sit on the column. */
  .tc-foot :global(.button) {
    margin-left: calc(-1 * var(--space-2));
  }
  .tc-key {
    font-family: inherit;
    font-size: var(--text-meta);
    color: var(--text-muted);
  }

  /* --- main regions --- */
  /*
   * OPERATED PANES, not a fixed grid (§12.2).
   *
   * This was `grid-template-columns: 200px minmax(0,1fr) 304px` with a media
   * query that HID the outline below 1100px. Two things were wrong with that:
   * the widths were the designer's rather than the operator's, and the
   * disappearance was silent — a rail that vanishes when the window narrows
   * looks like a bug the first time it happens, and there was no way to ask for
   * it back.
   *
   * Both rails are now dragged and remembered. They are not toggled from View:
   * a take replaces this console with the stage, so a menu item for them would
   * describe a pane nobody can see (#236). The stage preview keeps
   * `flex: 1 1 auto` with `min-width: 0`, so it takes what is left and shrinks
   * last — §12.2's rule that the least critical pane collapses before the
   * preview stops being useful.
   */
  .main {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    min-width: 0;
  }

  .region-label {
    margin: 0 0 var(--space-2);
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-muted);
  }
  .region-empty {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
    line-height: 1.5;
  }

  .outline {
    /*
     * The width is an inline style from the persisted pane size; the divider
     * beside it is what changes it. No border — the divider draws the line.
     *
     * `flex-shrink: 1` with a `min-width`, NOT `0 0 auto`.
     *
     * The first version was `flex: 0 0 auto` on both rails, which made the
     * PREVIEW the only shrinkable item — so a narrow window crushed the stage
     * preview to nothing while the rails kept their full width. The comment
     * beside it claimed the opposite. §12.2's rule is to collapse the least
     * critical pane before shrinking the preview below usefulness, so the rails
     * give way first and stop at a width where their content is still readable.
     */
    flex: 0 1 auto;
    /*
     * 140px, and NOT `min-width: 0` after it.
     *
     * Both were declared, in that order, so the second won and this rail
     * collapsed to nothing rather than stopping where its section titles are
     * still readable. The floor is the point: §12.2 asks the least critical
     * pane to give way FIRST, not to vanish — a rail that shrinks to zero
     * without being toggled reads as the bug the media query that used to hide
     * it read as, which is the thing this layout replaced.
     */
    min-width: 140px;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-3);
    background: var(--bg-chrome);
  }
  .outline-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .outline-item {
    position: relative;
    display: block;
    width: 100%;
    min-height: 30px;
    padding: var(--space-1) 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .outline-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  /* Current section: inset accent bar (never a one-sided border on the box). */
  .outline-item.current {
    background: var(--bg-selected);
    color: var(--text-primary);
    font-weight: 600;
  }
  .outline-item.current::before {
    content: '';
    position: absolute;
    left: 3px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }

  /* --- stage preview --- */
  .preview {
    /*
     * Takes what is left and shrinks LAST (§12.2).
     *
     * True because of three declarations together, not because of this one:
     * the rails are `flex: 0 1 auto`, so they are shrinkable while this is
     * `flex: 1 1 auto`; they carry floors (140px and 200px) so they stop where
     * their content is still readable; and this carries a floor of its own so
     * the preview is never reduced to a sliver once both rails have reached
     * theirs. Below that the window itself scrolls rather than any pane
     * disappearing.
     */
    flex: 1 1 auto;
    min-width: 260px;
    min-height: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
    background: var(--bg-sunken);
  }
  .preview-text {
    max-width: var(--prose-measure-narrow);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .preview-sentence {
    margin: 0;
    font-size: var(--text-live-question);
    line-height: var(--text-live-question-leading);
    font-weight: 500;
    color: var(--text-secondary);
    transition: color var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out);
  }
  .preview-sentence.past {
    opacity: 0.4;
  }
  .preview-sentence.current {
    color: var(--text-primary);
  }

  .preview-placeholder {
    text-align: center;
    max-width: 340px;
  }
  .ph-title {
    margin: 0 0 var(--space-2);
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .ph-note {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: var(--lh-label);
  }

  .blanked {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-faint);
  }
  .blanked p {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  /* --- diagnostics --- */
  .diagnostics {
    /* Shrinks before the preview does — see the note on `.outline`. */
    flex: 0 1 auto;
    min-width: 200px;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--bg-chrome);
  }
  .session-status {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .transcript-tail {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .tail-line {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
  }
  .tail-line.latest {
    color: var(--prose-text-warm);
  }

  .quick-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .font-row {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
  .font-value {
    min-width: 46px;
    text-align: center;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* --- transport --- */
  .transport {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    background: var(--bg-chrome);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow-transport);
  }
  .transport-left,
  .transport-center,
  .transport-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .pause-split {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .voice-follow {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
  }

</style>
