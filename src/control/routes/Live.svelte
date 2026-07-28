<!--
  Live control screen (spec §15) in the dark studio theme: top status bar,
  outline / stage preview / diagnostics regions, always-visible bottom
  transport, §15.3 pause semantics, F.17 end-of-session summary.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../components/Button.svelte';
  import Dialog from '../components/Dialog.svelte';
  import FollowControls from '../components/FollowControls.svelte';
  import FollowDiagnostics from '../components/FollowDiagnostics.svelte';
  import FollowStatePanel from '../components/FollowStatePanel.svelte';
  import Icon from '../components/Icon.svelte';
  import IconButton from '../components/IconButton.svelte';
  import OverflowMenu from '../components/OverflowMenu.svelte';
  import StageAppearanceSheet from '../components/StageAppearanceSheet.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import Slider from '../components/Slider.svelte';
  import {
    readStageAppearance,
    stageAppearanceEquals,
    type StageAppearance,
  } from '../lib/stage-appearance';
  import { formatClock } from '../lib/format';
  import { onShortcut } from '../lib/shortcuts';
  import { startTake } from '../lib/start-take';
  import { setControlFullscreen } from '../services/control-window';
  import { describeError } from '../services/errors';
  import { getVoiceFacade } from '../services/voice-facade';
  import { requestConfirm } from '../stores/confirm';
  import { navigate } from '../stores/router';
  import {
    addTakeMarker,
    adjustStageFontSize,
    applyStageAppearance,
    canSwitchMicrophone,
    chooseAnotherListenerClip,
    clearSession,
    connectionPill,
    dismissStageWindowFault,
    goToToken,
    hardPause,
    identifyStageDisplays,
    liveStatusLabel,
    moveSentences,
    pauseListening,
    restartParagraph,
    resumeSession,
    retryListenerMedia,
    session,
    startPrompting,
    stopSession,
    switchMicrophone,
    toggleBlankStage,
    toggleListenerVisible,
    togglePlayPause,
    toggleStageMirror,
    toggleVoiceFollow,
    turnOffListenerForSession,
    useListenerPoster,
    type ListenerFault,
  } from '../stores/session';
  import { patchSettings, settings } from '../stores/settings';
  import { smoothFollow, type FollowNotice } from '../stores/smooth-follow';
  import { showToast } from '../stores/toasts';
  import type { AudioDeviceInfo, OutlineNode, StageIntent } from '../../shared/contracts';
  import StageApp from '../../stage/StageApp.svelte';

  interface Props {
    sessionId: string;
    scriptId: string;
  }
  let { sessionId, scriptId }: Props = $props();

  let costOpen = $state(false);
  /** Display-only until a fixed-speed transport exists (see the slider below). */
  let manualWpm = $state(150);

  const stageFontSize = $derived($session.stageFontSizePx);
  /** §62: the stage window is gone; its quick-controls have nothing to talk to. */
  const stageAlive = $derived($session.stageAlive);
  const connection = $derived(connectionPill($session.connection));

  const snapshot = $derived($session.snapshot);
  const modeLabel = $derived(
    $session.mode === 'voice' ? 'Voice' : $session.mode === 'manual' ? 'Manual' : 'Fixed',
  );

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
  const micRecoveryOffered = $derived(
    hasVoiceTransport && $session.inputDeviceLost && canSwitchMicrophone(),
  );

  $effect(() => {
    if (!micRecoveryOffered) return;
    void refreshMicInputs();
  });

  async function refreshMicInputs(): Promise<void> {
    try {
      const found = await getVoiceFacade().listMicrophones();
      micInputs = found.filter((device) => device.available !== false);
      if (!micInputs.some((device) => device.deviceId === micChoice)) {
        micChoice =
          micInputs.find((device) => device.isDefault)?.deviceId ?? micInputs[0]?.deviceId ?? '';
      }
    } catch (err) {
      micInputs = [];
      showToast(`Could not list microphones. ${describeError(err)}`, 'danger');
    }
  }

  async function useMicrophone(): Promise<void> {
    if (micChoice === '' || micSwitching) return;
    micSwitching = true;
    try {
      // The label travels with the id: it is what identifies this microphone
      // again next launch, when the id may have been re-salted.
      await switchMicrophone(micChoice, micInputs.find((d) => d.deviceId === micChoice)?.label);
    } finally {
      micSwitching = false;
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
  const currentSectionIndex = $derived(
    snapshot
      ? flatOutline.reduce(
          (acc, entry, index) => (entry.node.startTokenIndex <= snapshot.confirmedToken ? index : acc),
          -1,
        )
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

  /* --- §40.5 Listener media failure ------------------------------------- */

  function listenerFaultTitle(fault: ListenerFault): string {
    switch (fault.resolution) {
      case 'off':
        return 'Listener off for the rest of this session';
      case 'poster':
        return 'Listener is showing its still image';
      case 'retrying':
        return 'Reloading the Listener…';
      default:
        return 'The Listener video stopped';
    }
  }

  function listenerFaultCause(fault: ListenerFault): string {
    switch (fault.code) {
      case 'unsupported_codec':
        return 'This clip’s format is not supported on this machine.';
      case 'source_unavailable':
        return 'The clip file could not be read.';
      case 'decode_failure':
        return 'The video failed to decode.';
      default:
        return 'Playback was refused and did not recover.';
    }
  }

  function chooseAnotherListener(): void {
    if (!chooseAnotherListenerClip()) {
      showToast('No other clip in this pack to try.', 'info');
    }
  }

  const currentSectionTitle = $derived(
    currentSectionIndex >= 0 ? (flatOutline[currentSectionIndex]?.node.title ?? null) : null,
  );

  /** Degraded-state actions (Part XI) offered next to the notice itself. */
  function handleNoticeAction(action: NonNullable<FollowNotice['action']>): void {
    if (action.id === 'rebuild_layout') {
      smoothFollow.requestLayoutRebuild();
      return;
    }
    void navigate({ name: 'settings', section: 'following' });
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
   * Outline navigation. `moveSentences` is a relative move and needs a cursor,
   * so before the first snapshot (i.e. before Start) it can express nothing —
   * clicking a section used to do nothing at all. An absolute move to the
   * section's first token is the honest answer for "go here before I start".
   */
  function jumpToSection(node: OutlineNode): void {
    if (sentenceIndex >= 0) {
      const targetIndex = $session.sentences.findIndex(
        (s) => s.startTokenIndex >= node.startTokenIndex,
      );
      if (targetIndex >= 0) {
        moveSentences(targetIndex - sentenceIndex);
        showToast(node.title, 'info');
        return;
      }
    }
    goToToken(node.startTokenIndex);
    showToast(node.title, 'info');
  }

  async function requestStop(): Promise<void> {
    if ($settings.general.confirmEndSession) {
      /*
       * Chrome, for the same reason the menu and the sheet are.
       *
       * The stage answers Escape on its own window listener, and a confirm
       * sheet's Escape means "no, don't". Without standing the stage down for
       * the length of the question, backing out of "Stop the session?" ended
       * the session — the one answer the dialog exists to make avoidable.
       */
      confirmingStop = true;
      let accepted = false;
      try {
        accepted = await requestConfirm({
          title: 'Stop the session?',
          body: 'The realtime connection closes and presentation leaves full screen. Your script keeps its place.',
          confirmLabel: 'Stop session',
          danger: true,
        });
      } finally {
        confirmingStop = false;
      }
      if (!accepted) return;
    }
    await onEscape();
  }

  async function onEscape(): Promise<void> {
    stopSession();
    await setControlFullscreen(false).catch(() => {});
    clearSession();
    await navigate({ name: 'editor', scriptId });
  }

  function handleEmbeddedStageIntent(intent: StageIntent): void {
    if (intent.kind === 'toggle_pause') {
      togglePlayPause();
    } else if (intent.kind === 'manual_step') {
      moveSentences(intent.direction === 'forward' ? 1 : -1);
    }
  }

  function adjustFontSize(delta: number): void {
    /*
     * §17.2. A rig-resolved take sizes its type from a measured distance, so
     * this shortcut has nothing to move — and reporting the unchanged number
     * ("Text 96 px", again) reads as a key that did not register rather than a
     * size that is not this key's to set.
     */
    if ($session.stageRigResolved) {
      showToast('This display sizes its text from its calibration', 'info', {
        durationMs: 2200,
      });
      return;
    }
    const next = adjustStageFontSize(delta);
    showToast(`Text ${next} px`, 'info', { durationMs: 1600 });
  }

  function toggleMirror(): void {
    toggleStageMirror('x');
    showToast('Text mirrored', 'info', { durationMs: 1600 });
  }

  function toggleListener(): void {
    const visible = toggleListenerVisible();
    showToast(visible ? 'Listener on' : 'Listener off', 'info', { durationMs: 1600 });
  }

  $effect(() =>
    onShortcut((action) => {
      // These keys belong to the embedded production stage while it is
      // mounted. Handling them again in control would turn one Space into
      // pause-then-resume, or one Escape into two teardown attempts.
      if (
        $session.active &&
        $session.stageEnvelope &&
        (action === 'escape' ||
          action === 'play-pause' ||
          action === 'hard-pause' ||
          action === 'prev-chapter' ||
          action === 'next-chapter')
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
          void requestStop();
          break;
        case 'escape':
          void onEscape();
          break;
        case 'back-sentence':
          moveSentences(-1);
          break;
        case 'forward-sentence':
          moveSentences(1);
          break;
        case 'prev-chapter':
          if (currentSectionIndex > 0) jumpToSection(flatOutline[currentSectionIndex - 1]!.node);
          break;
        case 'next-chapter':
          if (currentSectionIndex < flatOutline.length - 1)
            jumpToSection(flatOutline[currentSectionIndex + 1]!.node);
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
        case 'toggle-listener':
          toggleListener();
          break;
        case 'take-marker':
          addTakeMarker();
          showToast('Take marker added', 'info', { durationMs: 1600 });
          break;
        default:
          break;
      }
    }),
  );

  /**
   * Go again. The finished session is cleared first so its stage, transport and
   * clock are gone before a new one opens — `startTake` builds a fresh take
   * from the same saved settings, so "again" really is again.
   */
  async function presentAgain(): Promise<void> {
    clearSession();
    await startTake(scriptId);
  }

  async function returnToEditor(): Promise<void> {
    clearSession();
    await navigate({ name: 'editor', scriptId });
  }

  async function finishAndReturnToLibrary(): Promise<void> {
    await setControlFullscreen(false).catch(() => {});
    clearSession();
    await navigate({ name: 'library', view: 'all' });
  }

  /* ------------------------------------------- the presentation corner (§14.2)
   *
   * Presentation fills this window with the production stage, which is exactly
   * where the prompter's appearance can be judged and — until now — the one
   * place it could not be changed. Four of these five controls answer a
   * question about a physical arrangement (can I read this from there? is the
   * band over the lens?), so setting them anywhere else is guesswork that costs
   * a take to check.
   */

  /** How long the corner stays up after the pointer last moved. */
  const CHROME_IDLE_MS = 4000;

  let stageMenuOpen = $state(false);
  let appearanceOpen = $state(false);
  let confirmingStop = $state(false);
  let chromeAwake = $state(true);
  let chromeTimer = 0;
  let chromeRoot: HTMLElement | null = $state(null);
  /**
   * The appearance the sheet was opened on, so Cancel is exact.
   *
   * Captured here rather than inside the sheet because it is the take's state,
   * not the panel's: the panel can be closed and reopened, and what "put it
   * back" means has to survive that.
   */
  let appearanceOnOpen: StageAppearance | null = null;

  /** Open chrome owns the keyboard — see `chromeOpen` on the stage bridge. */
  const stageChromeOpen = $derived(stageMenuOpen || appearanceOpen || confirmingStop);
  const stageChromeVisible = $derived(chromeAwake || stageChromeOpen);

  /*
   * Window-level, not on the stage root: the corner is a sibling of the stage,
   * so a pointer moving over the menu or the sheet never reaches the stage's
   * own idle handler — and chrome that fades while you are reaching for it is
   * worse than chrome that never hides.
   */
  $effect(() => {
    if (!$session.active) return undefined;
    const wake = (): void => {
      chromeAwake = true;
      clearTimeout(chromeTimer);
      chromeTimer = window.setTimeout(() => (chromeAwake = false), CHROME_IDLE_MS);
    };
    wake();
    window.addEventListener('pointermove', wake);
    return () => {
      window.removeEventListener('pointermove', wake);
      clearTimeout(chromeTimer);
    };
  });

  /**
   * Open once. A second open must not re-capture the baseline.
   *
   * The menu that reaches this is hidden while the sheet is up, so the ordinary
   * route cannot ask twice — but "the rollback snapshot is whatever the last
   * open saw" is a bad property to leave lying around for the next caller. Drag
   * the band from 38% to 50%, reopen, press Cancel, and the take would keep 50%
   * while the button promised 38%.
   */
  function openAppearanceSheet(): void {
    if (appearanceOpen) return;
    appearanceOnOpen = $session.stageAppearance;
    appearanceOpen = true;
  }

  function closeAppearanceSheet(): void {
    appearanceOpen = false;
    appearanceOnOpen = null;
  }

  /**
   * OK: what is on the glass becomes what the next take opens with.
   *
   * The take is already running these values — every drag applied them — so
   * this writes and closes and changes nothing visible.
   *
   * Nothing is written for a RIG-RESOLVED take. Its numbers came from the
   * profile, not from these controls (the sheet shows them read-only and offers
   * no OK), and persisting them would copy one rig's measurements into the
   * global defaults every uncalibrated take opens with.
   */
  async function keepAppearance(): Promise<void> {
    const live = $session.stageAppearance;
    closeAppearanceSheet();
    void focusSessionMenu();
    /*
     * Compared against the SAVED settings, not against what the sheet opened
     * on. Those are different questions, and only one of them is "is there
     * anything to write?": a presenter who bumps the type with Cmd+= and then
     * opens the sheet to press OK has changed nothing SINCE OPENING, and a
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

  /** Cancel: the take goes back exactly as it was found, and nothing is saved. */
  function revertAppearance(): void {
    if (appearanceOnOpen) applyStageAppearance(appearanceOnOpen);
    closeAppearanceSheet();
    void focusSessionMenu();
  }

  /**
   * Put the keyboard back on the menu button after the sheet closes.
   *
   * The sheet restores focus to its opener on teardown, which is the right
   * contract and is not enough here: this corner REPLACES the menu with the
   * sheet rather than layering over it, so the opener is gone by the time the
   * sheet unmounts and the trigger that comes back is a different element.
   * Without this, closing the panel drops focus on `<body>` — on a full-screen
   * stage, that is the keyboard landing somewhere nobody can see.
   */
  async function focusSessionMenu(): Promise<void> {
    await tick();
    chromeRoot?.querySelector('button')?.focus();
  }

  /**
   * Chrome belongs to the take that opened it.
   *
   * All three of these are component state and this component survives the end
   * of a session — Live stays mounted for the summary, and "Present again"
   * starts a fresh take inside it. A sheet left open across that boundary
   * remounts over the new take holding the OLD take's rollback snapshot, and a
   * `stageMenuOpen` left true suspends the new stage's keyboard until somebody
   * opens and closes the menu to clear it.
   */
  $effect(() => {
    if ($session.active) return;
    stageMenuOpen = false;
    closeAppearanceSheet();
  });
</script>

{#if $session.active}
  {#if $session.stageEnvelope}
    <StageApp
      embedded={{
        envelope: $session.stageEnvelope,
        alignment: $session.snapshot,
        transcript: $session.transcriptTail.at(-1) ?? '',
        voicePill: $session.voicePill,
        onexit: onEscape,
        onintent: handleEmbeddedStageIntent,
        chromeOpen: stageChromeOpen,
      }}
    />
    <!--
      The presentation corner (§16.9, §14.2).

      Outside `.stage-root` on purpose, so it sits OUTSIDE the mirror plane.
      Everything the presenter reads is flipped to survive a beamsplitter; this
      is the one surface aimed at whoever has the mouse, and a mirrored slider
      moves the wrong way under the hand dragging it. On an unmirrored rig the
      two planes are identical anyway, so nothing is lost by being outside.

      Faded out with the pointer, like the exit affordance it replaces: a chip
      in the corner of a prompter is in shot, and the presenter has no use for
      it while they are talking.
    -->
    <div
      class="stage-chrome"
      class:idle={!stageChromeVisible}
      data-stage-chrome
      bind:this={chromeRoot}
    >
      <!--
        Hidden while the sheet is up, because the sheet says it is modal.

        A trigger left live beside an `aria-modal` panel is a promise the panel
        does not keep: it opens a menu over the modal, and "Adjust settings…"
        from there re-enters the sheet and takes its rollback snapshot with it.
        Removing it is cheaper and more honest than a scrim, which is the one
        thing this panel cannot have — the stage behind it is the point.
      -->
      {#if !appearanceOpen}
        <OverflowMenu
          label="Session menu"
          items={[
            { label: 'Adjust settings…', onselect: openAppearanceSheet },
            { label: 'End session', danger: true, onselect: () => void requestStop() },
          ]}
          onopenchange={(open) => (stageMenuOpen = open)}
        />
      {:else}
        <StageAppearanceSheet
          appearance={$session.stageAppearance}
          rigResolved={$session.stageRigResolved}
          maxFontSizePx={$session.stageFontCeilingPx}
          onchange={(patch) => applyStageAppearance(patch)}
          onok={() => void keepAppearance()}
          oncancel={revertAppearance}
        />
      {/if}
    </div>
  {:else}
    <div class="stage-preparing">Preparing script…</div>
  {/if}
{:else}
<div class="live">
  <!-- Top status bar (§15.1) -->
  <header class="statusbar">
    <div class="status-left">
      <span class="live-dot" class:paused={$session.paused !== 'none' || !$session.prompting}></span>
      <span class="script-title">{$session.scriptTitle}</span>
      <span class="elapsed">{formatClock($session.elapsedSeconds)}</span>
      <!-- F.11 session status; the follow state itself lives in the Tracking panel. -->
      <span class="session-status" role="status" aria-live="polite">{$liveStatusLabel}</span>
    </div>
    <div class="status-right">
      <StatusPill tone="accent" label={modeLabel} dot={false} />
      <!--
        Only a voice take has a realtime connection and an open microphone to
        report. Anything else says so plainly instead of showing the
        `initial` optimism of "Connected · Mic live".
      -->
      {#if hasVoiceTransport}
        <StatusPill tone={connection.tone} label={connection.label} />
      {/if}
      {#if !stageAlive}
        <StatusPill tone="danger" label="Stage closed" />
      {/if}
      {#if hasVoiceTransport}
        <StatusPill
          tone={$session.micState === 'live' ? 'success' : $session.micState === 'muted' ? 'neutral' : 'danger'}
          label={$session.micState === 'live' ? 'Mic live' : $session.micState === 'muted' ? 'Mic off' : 'Mic lost'}
        />
        <!--
          §28.2. Losing a microphone mid-take used to be a dead end: the toast
          said "choose an input" and there was nowhere to choose one. The
          transport can replace its sender track without renegotiating, so the
          recovery is a picker right where the failure is reported.
        -->
        {#if micRecoveryOffered}
          <div class="mic-recovery">
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
            <Button
              size="sm"
              variant="primary"
              disabled={micSwitching || micChoice === ''}
              onclick={() => useMicrophone()}
            >
              {micSwitching ? 'Switching…' : 'Use this input'}
            </Button>
            <Button size="sm" variant="ghost" disabled={micSwitching} onclick={() => refreshMicInputs()}>
              Rescan
            </Button>
          </div>
        {/if}
      {:else}
        <StatusPill tone="neutral" label="No microphone" />
      {/if}
      <span class="display-name">{$session.displayLabel}</span>
    </div>
  </header>

  <!-- Main three-region area (§15.1) -->
  <div class="main">
    <aside class="outline" aria-label="Sections">
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
          <p class="ph-note">
            The scaled stage view appears here once the compiled script is available.
            {#if snapshot}Cursor at token {Math.round(snapshot.confirmedToken)}.{/if}
          </p>
        </div>
      {/if}
    </section>

    <aside class="diagnostics" aria-label="Tracking">
      <p class="region-label">Tracking</p>
      <FollowStatePanel
        follow={$smoothFollow}
        sectionTitle={currentSectionTitle}
        voiceInput={hasVoiceTransport}
        onnoticeaction={handleNoticeAction}
      />

      <p class="region-label">Following</p>
      <FollowControls follow={$smoothFollow} />

      <FollowDiagnostics
        follow={$smoothFollow}
        developerMode={$settings.following.developerDiagnostics}
      />

      <p class="region-label">Transcript</p>
      {#if $session.transcriptTail.length > 0}
        <div class="transcript-tail">
          {#each $session.transcriptTail as line, index (index)}
            <p class="tail-line" class:latest={index === $session.transcriptTail.length - 1}>{line}</p>
          {/each}
        </div>
      {:else}
        <p class="region-empty">Speak and the latest transcript appears here.</p>
      {/if}

      <p class="region-label">Stage</p>
      <!--
        §52.7. The window layer verified which monitor the stage actually opened
        on and it was not the one that was picked. Nothing is broken — the
        script is prompting correctly, at the wrong wall — so this is a notice
        with the one affordance that answers "which panel is which": numbered
        cards on every display (identify.html, §52.4). The picker itself lives
        in Preflight and labels its tiles with the same numbers.
      -->
      {#if $session.stageWindowFault}
        {@const fault = $session.stageWindowFault}
        <div class="stage-window-fault" role="alert">
          <p class="lf-title">
            {fault.code === 'STAGE_DISPLAY_MISMATCH'
              ? 'The stage is on the wrong display'
              : 'The stage window reported a problem'}
          </p>
          <p class="lf-note">{fault.message}</p>
          <div class="lf-actions">
            <Button size="sm" onclick={() => void identifyStageDisplays()}>Number the displays</Button>
            <Button size="sm" onclick={() => dismissStageWindowFault()}>Dismiss</Button>
          </div>
        </div>
      {/if}
      <!--
        §40.5 Listener failure containment. The stage reports a nonfatal media
        failure; this is where the operator gets the four recoveries. None of
        them touches the script, the scroll, or the tracking cursor — a video
        that stopped decoding is a cosmetic problem, and the take continues
        through all of it.
      -->
      {#if $session.listenerFault}
        {@const fault = $session.listenerFault}
        <div class="listener-fault" data-resolution={fault.resolution} role="status">
          <p class="lf-title">{listenerFaultTitle(fault)}</p>
          <p class="lf-note">
            {listenerFaultCause(fault)} Your script, position and scrolling are unaffected.
          </p>
          {#if fault.resolution !== 'off'}
            <div class="lf-actions">
              <Button size="sm" disabled={!stageAlive} onclick={() => retryListenerMedia()}>
                Retry
              </Button>
              {#if fault.resolution !== 'poster'}
                <Button size="sm" onclick={() => useListenerPoster()}>Use poster</Button>
              {/if}
              <Button
                size="sm"
                disabled={!stageAlive || fault.alternativeClips === 0}
                onclick={() => chooseAnotherListener()}
              >
                Choose another
              </Button>
              <Button size="sm" onclick={() => turnOffListenerForSession()}>Turn off</Button>
            </div>
          {/if}
        </div>
      {/if}
      <div class="quick-controls">
        <div class="font-row">
          <IconButton
            icon="chevron-down"
            label="Decrease stage text"
            disabled={!stageAlive}
            onclick={() => adjustFontSize(-2)}
          />
          <span class="font-value">{stageFontSize} px</span>
          <IconButton
            icon="chevron-up"
            label="Increase stage text"
            disabled={!stageAlive}
            onclick={() => adjustFontSize(2)}
          />
        </div>
        <Button size="sm" disabled={!stageAlive} onclick={() => toggleMirror()}>Mirror text</Button>
        <Button size="sm" disabled={!stageAlive} onclick={() => toggleListener()}>Listener</Button>
      </div>
      {#if !stageAlive}
        <p class="region-empty" role="status">
          The stage window closed. Stop and restart the session to reopen it — until then these
          controls have nothing to talk to.
        </p>
      {/if}

      {#if $session.mode !== 'voice' || !$session.voiceFollow}
        <!--
          Fixed-speed scrolling has no transport yet: neither the tracking
          driver nor `StageDirective` carries a speed, so this slider had
          nothing to set. It stays visible and disabled rather than looking
          live and doing nothing.
        -->
        <Slider
          label="Manual speed"
          bind:value={manualWpm}
          min={60}
          max={260}
          disabled
          format={(v) => `${v} wpm`}
        />
        <p class="region-empty">
          Fixed-speed scrolling is not available yet — use the transport or voice following to move
          the stage.
        </p>
      {/if}
    </aside>
  </div>

  <!-- Bottom transport (§15.1) — always visible -->
  <footer class="transport" bind:clientHeight={transportHeightPx}>
    <div class="transport-left">
      {#if !$session.prompting}
        <Button variant="primary" onclick={() => startPrompting()}>
          <Icon name="play" size={16} />
          Start
        </Button>
      {:else if $session.paused === 'none'}
        <div class="pause-split">
          <Button onclick={() => pauseListening()}>
            <Icon name="pause" size={16} />
            Pause
          </Button>
          <OverflowMenu
            label="Pause options"
            items={[
              {
                label: 'Hard pause — mic off, resume by click only',
                onselect: () => hardPause(),
              },
            ]}
          />
        </div>
      {:else}
        <Button variant="primary" onclick={() => resumeSession()}>
          <Icon name="play" size={16} />
          Resume
        </Button>
      {/if}
      <Button variant="danger" onclick={() => requestStop()}>
        <Icon name="stop" size={14} />
        Stop session
      </Button>
    </div>

    <div class="transport-center">
      <IconButton icon="chevron-left" label="Back one sentence" onclick={() => moveSentences(-1)} />
      <IconButton icon="chevron-right" label="Forward one sentence" onclick={() => moveSentences(1)} />
      <IconButton icon="restore" label="Restart paragraph" onclick={() => restartParagraph()} />
      <IconButton
        icon="flag"
        label="Add take marker"
        onclick={() => {
          addTakeMarker();
          showToast('Take marker added', 'info', { durationMs: 1600 });
        }}
      />
      <IconButton
        icon="eye-off"
        label={stageAlive
          ? $session.stageBlanked
            ? 'Unblank stage'
            : 'Blank stage'
          : 'Blank stage — the stage window is closed'}
        active={$session.stageBlanked}
        disabled={!stageAlive}
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

<!-- End-of-session summary (F.17) -->
<Dialog
  open={!$session.active && $session.summary !== null}
  title="Session complete"
  onclose={() => void returnToEditor()}
>
  {#if $session.summary}
    {@const summary = $session.summary}
    <dl class="summary-grid">
      <dt>Duration</dt>
      <dd>{formatClock(summary.durationSeconds)}</dd>
      <dt>Mode</dt>
      <dd>{summary.mode === 'voice' ? 'Voice follow' : summary.mode === 'manual' ? 'Manual' : 'Fixed speed'}</dd>
      <!-- The two rows that answer "did it actually work". Everything else
           here reads the same whether the microphone was live or the take was
           nine seconds of silence, which is why a take could look complete and
           have heard nothing at all. -->
      <dt>Words heard</dt>
      <dd>
        {summary.wordsHeard}
        {#if summary.wordsInFlight > 0}
          <!-- Finals only. A continuous read leaves the last utterance open,
               and the summary is taken before `endTurn` closes it — so this
               said "11" for a passage heard in full. -->
          + {summary.wordsInFlight} still being transcribed
        {/if}
        {#if summary.mode === 'voice' && summary.wordsHeard === 0 && summary.wordsInFlight === 0}
          <span class="summary-warn">— nothing was transcribed</span>
        {/if}
      </dd>
      <dt>Script followed</dt>
      <dd>
        {summary.wordsFollowed} of {summary.scriptWords} words
        {#if summary.scriptWords > 0}
          ({Math.round((summary.wordsFollowed / summary.scriptWords) * 100)}%)
        {/if}
      </dd>
      <!--
        The row that tells a lost aligner apart from a stage that ignored it.
        Both of the rows above are measured on the control side and agreed
        perfectly through a take where the script never moved.
      -->
      <dt>Stage updates</dt>
      <dd>
        {#if summary.stageApplied === null}
          {summary.updatesSent} sent — the stage did not report back
        {:else}
          {summary.stageApplied} of {summary.updatesSent} applied
          {#if summary.updatesSent - summary.stageApplied >= 4}
            <span class="summary-warn">— the stage was not following control</span>
          {/if}
        {/if}
      </dd>
      <!--
        The only row measured on the GLASS. Everything above it is control's own
        bookkeeping, which is how a take reported words heard, words followed
        and snapshots applied — all healthy — while the script never moved.
      -->
      <dt>Script moved</dt>
      <dd>
        {#if summary.documentTravelPx === null}
          the stage did not report a position
        {:else}
          {Math.round(summary.documentTravelPx)} px
          {#if summary.targetTravelPx !== null}
            (aimed at {Math.round(summary.targetTravelPx)} px)
          {/if}
          {#if summary.documentTravelPx < 20 && (summary.targetTravelPx ?? 0) >= 20}
            <span class="summary-warn">— the document never followed its target</span>
          {:else if summary.documentTravelPx < 20 && summary.wordsFollowed > 5}
            <span class="summary-warn">— the script did not move</span>
          {/if}
        {/if}
      </dd>
      <!--
        Whether the recogniser's own words reached the stage's transcript bar.
        The bar read "listening — no words yet" through a take that heard
        eleven, and nothing anywhere said which side dropped them.
      -->
      <dt>Transcript to stage</dt>
      <dd>
        {summary.transcriptTapsEmitted} of {summary.transcriptTapsSeen} sent
        {#if summary.transcriptTapFault !== null}
          <span class="summary-warn">— dropped: {summary.transcriptTapFault}</span>
        {:else if summary.transcriptTapsSeen === 0 && summary.wordsHeard > 0}
          <span class="summary-warn">— words were heard but never offered to the stage</span>
        {/if}
      </dd>
      <dt>Sections reached</dt>
      <dd>{summary.sectionsReached}</dd>
      <dt>Retakes</dt>
      <dd>{summary.retakes}</dd>
      <dt>Reconnects</dt>
      <dd>{summary.reconnects}</dd>
      <dt>Ending location</dt>
      <dd>{summary.endingLocation}</dd>
      <dt>Transcript</dt>
      <dd>Not saved</dd>
    </dl>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => void finishAndReturnToLibrary()}>Finish</Button>
    <Button onclick={() => void returnToEditor()}>Return to editor</Button>
    <Button variant="primary" onclick={() => void presentAgain()}>Present again</Button>
  {/snippet}
</Dialog>

<style>
  .stage-preparing {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: #000;
    color: #777;
  }

  /*
   * The presentation corner. Fixed rather than absolute: the stage root is
   * `position: absolute; inset: 0` with `overflow: hidden`, and a popover
   * anchored inside it would be clipped by the stage it is floating over.
   */
  .stage-chrome {
    position: fixed;
    top: var(--space-4);
    right: var(--space-4);
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
    transition: opacity var(--dur-med) var(--ease-out);
  }

  /*
   * Idle: faded, not removed.
   *
   * `visibility` and `display` both take the trigger out of the tab order and
   * out of the accessibility tree, which would make the only route to "End
   * session" and the appearance controls disappear for anyone driving by
   * keyboard — on the one screen where the mouse may well be across the room.
   * Opacity alone keeps it reachable, and any key or pointer wakes it.
   *
   * Hit-testing goes with the visibility, though: an invisible button that
   * still takes a click is a trap, and a pointer resting in that corner when
   * the timer expires is exactly where a stray click lands. Any pointer
   * movement wakes the corner before a click can follow it, so nothing that is
   * visible is ever unclickable.
   */
  .stage-chrome.idle {
    opacity: 0;
    pointer-events: none;
  }
  .stage-chrome.idle:focus-within {
    opacity: 1;
    pointer-events: auto;
  }

  /*
   * The corner is one pane of glass.
   *
   * The menu and the sheet drop from the same point over the same moving text,
   * so they get the same treatment — scoped HERE rather than changed in
   * OverflowMenu, because everywhere else that component sits on an opaque
   * panel where a blur has nothing to do and the studio surface is correct.
   *
   * The trigger carries a little of it too: a bare glyph is legible over the
   * stage's black field and disappears the moment a white line of script scrolls
   * under it, which is most of the time on a wide column.
   */
  .stage-chrome[data-stage-chrome] :global(.icon-button) {
    border-color: rgba(255, 255, 255, 0.14);
    background: rgba(9, 11, 15, 0.62);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    color: rgba(245, 246, 248, 0.92);
  }
  /*
   * Stated rather than inherited. The component's own hover rule and this one
   * land on the same specificity, and which of two tied rules wins is decided
   * by bundle order — so leaving it implicit means a hover state that depends
   * on how the app was built.
   */
  .stage-chrome[data-stage-chrome] :global(.icon-button:hover),
  .stage-chrome[data-stage-chrome] :global(.icon-button:focus-visible) {
    border-color: rgba(255, 255, 255, 0.3);
    background: rgba(24, 28, 35, 0.86);
    color: #fff;
  }
  .stage-chrome[data-stage-chrome] :global(.menu) {
    border-color: rgba(255, 255, 255, 0.14);
    background: rgba(9, 11, 15, 0.76);
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
  }
  /* `--bg-hover-surface` is an opaque studio grey, which on glass paints a
     solid tile over the script and undoes the transparency for that one row. */
  .stage-chrome[data-stage-chrome] :global(.menu .item:hover:not(:disabled)) {
    background: rgba(255, 255, 255, 0.1);
  }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .stage-chrome[data-stage-chrome] :global(.icon-button) {
      background: rgba(9, 11, 15, 0.92);
    }
    .stage-chrome[data-stage-chrome] :global(.menu) {
      background: rgba(9, 11, 15, 0.94);
    }
  }

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

  .cost {
    position: relative;
  }
  .cost-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 240px;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
  }
  .cost-line {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .cost-value {
    margin: var(--space-1) 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .cost-note {
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--text-muted);
    line-height: 1.4;
  }
  /* Two costs, visibly two things: a plain separator between the groups, not
     a border on either box. */
  .cost-group + .cost-group {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .cost-value.unpriced {
    font-size: var(--text-base);
    color: var(--text-muted);
    font-weight: 600;
  }
  .cost-budget {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin: var(--space-2) 0 var(--space-1);
    font-size: var(--text-2xs);
    color: var(--text-secondary);
  }
  .cost-budget input {
    width: 72px;
    padding: 3px var(--space-2);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    color: var(--text-primary);
    font: inherit;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  /* Quiet focus: a background/border shift, never an accent ring. */
  .cost-budget input:focus-visible {
    outline: none;
    background: var(--bg-elevated);
    border-color: var(--border-strong);
  }

  /* --- §28.2 mid-session input recovery --- */
  .mic-recovery {
    display: flex;
    align-items: center;
    gap: var(--space-2);
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
    border-color: var(--border-strong);
  }
  .mic-picker:disabled {
    opacity: 0.6;
  }

  /* --- §40.5 Listener failure --- */
  .listener-fault {
    position: relative;
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
  }
  /* Leading rule as an inset bar — never a one-sided border on a rounded box. */
  .listener-fault::before {
    content: '';
    position: absolute;
    left: 5px;
    top: var(--space-3);
    bottom: var(--space-3);
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }
  .listener-fault[data-resolution='off']::before,
  .listener-fault[data-resolution='poster']::before {
    background: var(--text-faint);
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
  .lf-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }

  /* --- §52.7 stage on the wrong display --- */
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
    background: var(--danger);
  }

  /* --- main regions --- */
  .main {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr) 304px;
  }
  @media (max-width: 1100px) {
    .main {
      grid-template-columns: minmax(0, 1fr) 288px;
    }
    .outline {
      display: none;
    }
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
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4);
    background: var(--bg-chrome);
    border-right: 1px solid var(--border);
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
    min-width: 0;
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
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-chrome);
    border-left: 1px solid var(--border);
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

  /* "Nothing was transcribed" is the one line here that is a problem rather
     than a statistic, so it reads as one. */
  .summary-warn {
    color: var(--text-danger, var(--accent-strong));
    font-weight: 550;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-1) var(--space-5);
    margin: 0;
  }
  .summary-grid dt {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .summary-grid dd {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
</style>
