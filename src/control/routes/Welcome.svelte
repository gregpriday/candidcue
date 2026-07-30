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
  import Button from '../components/Button.svelte';
  import Icon from '../components/Icon.svelte';
  import StatusPill, { type PillTone } from '../components/StatusPill.svelte';
  import { createAndOpenScript, importMarkdown } from '../lib/app-actions';
  import { chooseStageDisplay } from '../lib/start-take';
  import * as stageService from '../services/stage';
  import type { DisplayDescriptor } from '../services/stage-types';
  import { markWelcomed } from '../stores/app-status';
  import { navigate } from '../stores/router';
  import { settings } from '../stores/settings';

  /**
   * Connected displays are not part of the boot sequence, so unlike the
   * settings document this screen has to go and ask. `checking` is a real
   * state rather than an empty list: "no displays yet" and "no displays"
   * look identical in an array and mean opposite things.
   */
  type DisplayProbe =
    | { kind: 'checking' }
    | { kind: 'loaded'; displays: DisplayDescriptor[] }
    | { kind: 'failed' };

  let probe = $state<DisplayProbe>({ kind: 'checking' });

  $effect(() => {
    // The reply must not land on an unmounted screen: this runs on the first
    // paint of a first launch, which is exactly when somebody is most likely
    // to click straight through to the editor.
    let live = true;
    void (async () => {
      try {
        const displays = await stageService.listDisplays();
        if (live) probe = { kind: 'loaded', displays };
      } catch {
        // Deliberately not surfaced in detail. Stage settings already reports
        // the enumeration error properly and offers a retry; repeating it here
        // would put a stack-shaped message on the welcome screen.
        if (live) probe = { kind: 'failed' };
      }
    })();
    return () => {
      live = false;
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
  /** Where a take would actually land, from the function the take itself uses. */
  const effectiveDisplay = $derived(
    chooseStageDisplay(connectedDisplays, chosenFingerprint, $settings.stage.presentationMode),
  );
  /**
   * A pinned display that is not currently connected (§52 fingerprints), the
   * same predicate Stage settings shows its inline alert from. A fingerprint is
   * panel identity, so an unplugged display simply stops matching and the take
   * quietly opens somewhere else.
   */
  const pinnedMissing = $derived(
    probe.kind === 'loaded' &&
      connectedDisplays.length > 0 &&
      chosenFingerprint !== null &&
      !connectedDisplays.some((d) => d.fingerprint === chosenFingerprint),
  );

  interface RowState {
    tone: PillTone;
    pill: string;
    detail: string;
    /** Only 'attention' tints the row; expected setup is accent, faults warn. */
    emphasis: 'quiet' | 'setup' | 'attention';
    /** The fix control's label; the row always links somewhere useful. */
    action: string;
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
          detail: 'Access was allowed on this Mac. Test the level before a real take.',
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

  function resolveDisplayState(): RowState {
    if (readerMode) {
      // Reader mode presents in an ordinary window at desk distance, so there
      // is no second panel to choose and nothing here to be wrong. The action
      // must not say "Choose display" either: `chooseStageDisplay` ignores the
      // pin entirely in this mode, so it would offer a choice nothing reads.
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
        detail: `The display you chose is not connected. Takes will open on ${
          effectiveDisplay?.name ?? 'another display'
        } until it is back.`,
        emphasis: 'attention',
        action: 'Fix display',
      };
    }
    if (chosenFingerprint !== null) {
      return {
        tone: 'neutral',
        pill: 'Connected',
        detail: `Takes open on ${effectiveDisplay?.name ?? 'the display you chose'}.`,
        emphasis: 'quiet',
        action: 'Choose display',
      };
    }
    return {
      tone: 'neutral',
      pill: 'Automatic',
      detail: `Takes open on ${effectiveDisplay?.name ?? 'the best available display'}.`,
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
  function openMicrophoneSettings(): void {
    void navigate({ name: 'settings', section: 'audio' });
  }

  function openDisplaySettings(): void {
    void navigate({ name: 'settings', section: 'stage' });
  }

  function skipToLibrary(): void {
    markWelcomed();
    void navigate({ name: 'library', view: 'all' });
  }

  function openPrivacy(): void {
    void navigate({ name: 'settings', section: 'privacy' });
  }
</script>

<div class="welcome">
  <div class="inner">
    <p class="wordmark">CandidCue</p>
    <h1 class="heading">Speak naturally. Keep your place.</h1>
    <p class="body">
      CandidCue is a voice-following teleprompter for your second screen. Write or import a
      Markdown script, choose a microphone, and present while the text follows you.
    </p>

    <!--
      The sample script leads. It is the only one of these three that hands back
      something written to be read ALOUD — it exercises pauses, going off script
      and restarting — and reading aloud is the only way to see what this app
      actually does. A blank three-line stub cannot demonstrate following, so
      offering it first asked new users to supply the demo themselves.
    -->
    <div class="actions">
      <Button variant="primary" onclick={() => createAndOpenScript('sample')}>
        Open the sample script
      </Button>
      <Button onclick={() => createAndOpenScript('new')}>Create your first script</Button>
      <Button onclick={() => importMarkdown()}>Import Markdown</Button>
    </div>

    <ul class="readiness">
      <li class="readiness-item" class:setup={micState.emphasis === 'setup'}>
        <span class="readiness-icon"><Icon name="mic" size={16} /></span>
        <span class="readiness-text">
          <span class="readiness-title">Microphone</span>
          <span class="readiness-detail">{micState.detail}</span>
        </span>
        <span class="readiness-status">
          <StatusPill tone={micState.tone} label={micState.pill} />
          <button type="button" class="link" onclick={openMicrophoneSettings}>
            {micState.action}
          </button>
        </span>
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
        <span class="readiness-icon"><Icon name="monitor" size={16} /></span>
        <span class="readiness-text">
          <span class="readiness-title">Teleprompter screen</span>
          <span class="readiness-detail" role="status" aria-live="polite">
            {displayState.detail}
          </span>
        </span>
        <span class="readiness-status">
          <StatusPill tone={displayState.tone} label={displayState.pill} />
          <button type="button" class="link" onclick={openDisplaySettings}>
            {displayState.action}
          </button>
        </span>
      </li>
    </ul>

    <div class="footer-links">
      <button type="button" class="link" onclick={openPrivacy}>
        How CandidCue handles your voice
      </button>
      <button type="button" class="link quiet" onclick={skipToLibrary}>Go to the library</button>
    </div>
  </div>
</div>

<style>
  .welcome {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    place-items: center;
    padding: var(--space-10) var(--page-x);
  }

  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    max-width: 560px;
    gap: var(--space-4);
  }

  .wordmark {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--accent-strong);
  }

  .heading {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 40px;
    line-height: 1.18;
    font-weight: 600;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }

  .body {
    margin: 0;
    font-size: var(--text-lg);
    line-height: var(--lh-transcript);
    color: var(--text-secondary);
    max-width: 46ch;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  .readiness {
    list-style: none;
    margin: var(--space-5) 0 0;
    padding: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    text-align: left;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    width: 100%;
    max-width: 480px;
  }
  .readiness-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  /* A full-row wash, never a one-sided border: a leading rule on a rounded box
     reads as a crescent wherever the corner radius cuts it. */
  .readiness-item.setup {
    background: var(--accent-wash);
  }
  .readiness-item.attention {
    background: var(--warning-soft);
  }
  .readiness-icon {
    display: inline-flex;
    color: var(--accent);
    flex: 0 0 auto;
    margin-top: 2px;
  }
  .readiness-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .readiness-title {
    font-weight: 600;
    color: var(--text-primary);
  }
  .readiness-detail {
    color: var(--text-secondary);
    line-height: var(--lh-body, 1.45);
  }
  .readiness-status {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    flex: 0 0 auto;
  }

  .footer-links {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    margin-top: var(--space-3);
  }
  .link {
    border: none;
    background: transparent;
    padding: 2px 4px;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--accent-strong);
    border-radius: var(--radius-sm);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  /* Small terracotta text must never drop to --accent (it sits right on the
     AA line); hover darkens to the primary text colour instead, which also
     reads as the right direction for a hover. */
  .link:hover {
    color: var(--text-primary);
    text-decoration-thickness: 2px;
  }
  .link.quiet {
    color: var(--text-muted);
    text-decoration: none;
  }
  .link.quiet:hover {
    color: var(--text-primary);
  }
  .readiness-status .link {
    font-size: var(--text-xs);
    white-space: nowrap;
  }
</style>
