<!--
  Following state (companion §48, §49; primary §15.2).

  A calm, honest indicator: one plain-language status line, a banded
  confidence meter (never a percentage — §48 "without implying false
  precision"), the current behavior, and the Part XI degraded states with real
  copy. There is no persistent animated widget (primary §11.1) and no
  diagnostic score.

  ONE ANSWER, AND THE REMEDY BESIDE IT.

  This panel is the single place the take-controls drawer says what the text is
  doing. It used to be one of three: the drawer header said "Following" over a
  body saying "Text held", and a startup take read "Voice starting", "Ready to
  follow" and "Voice following unavailable" at once. The operator opens the
  drawer because something feels wrong, and three answers is the one thing
  they cannot act on. So the status line leads, a fault carries its remedy
  inside the same block (the `remedy` snippet the drawer supplies), and the
  readings below it are shown only while they are live — a "Strong" meter and
  a pace under "Microphone disconnected" described a take that had stopped.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';
  import {
    CONFIDENCE_BANDS,
    CONFIDENCE_BAND_LABELS,
    confidenceBandIndex,
    followStatus,
    formatPace,
    type FollowStatus,
  } from '../lib/follow-language';
  import { MOVEMENT_DETAIL } from '../../shared/take-vocabulary';
  import type { FollowNotice, SmoothFollowState } from '../stores/smooth-follow';

  interface Props {
    follow: SmoothFollowState;
    /** Resolved heading for the current position, when the outline knows one. */
    sectionTitle?: string | null;
    /**
     * Whether this take actually has a microphone and a transcription feed.
     *
     * False in a manual or fixed-speed take, where nothing is listening. The
     * shared copy is written for voice — "still listening for Speaking Glass,
     * resume", "Start speaking and the stage picks up your place" — and each
     * of those sentences is a lie without a microphone. The operator reads this panel to decide whether a
     * problem is their microphone or their script, so it says what is true.
     */
    voiceInput?: boolean;
    /**
     * The input as the session knows it. Defaults to 'live' so a caller that
     * has not wired it up cannot make the panel invent a fault.
     */
    micState?: 'live' | 'muted' | 'disconnected';
    /** Only a lost DEVICE may be answered with "choose another input". */
    inputDeviceLost?: boolean;
    /** The OS refused the microphone (#303) — not the device, not the recogniser. */
    microphoneRefused?: boolean;
    /**
     * The speech model was refused for this take (#286) — not the microphone.
     * Defaults TRUE for the same reason `micState` defaults to 'live'.
     */
    voiceAvailable?: boolean;
    /**
     * The recogniser's transport. 'reconnecting' is also every take's first
     * second, while the model warms; defaults to 'connected' so an unwired
     * caller never reports a start that is not happening.
     */
    connection?: 'connected' | 'reconnecting' | 'offline';
    /**
     * Whether anything has been transcribed this take.
     *
     * Defaults TRUE, and that direction is deliberate: the failure mode of this
     * flag is a standing "nothing heard" line over a take that is going fine,
     * so an unwired caller must fall silent rather than accuse.
     */
    heardAnything?: boolean;
    /**
     * Following was switched off BY SOMEBODY, as opposed to automatically.
     *
     * The store's own `follow.followingPaused` is not usable here: it is also
     * raised by device loss and by an untrustworthy transcript, so reading it
     * as a decision reports a fault as a choice.
     */
    heldByUser?: boolean;
    /** Fixed-pace scrolling is running, so the text is visibly moving. */
    rollingAtPace?: boolean;
    /**
     * The TAKE is paused (the transport's pause, not a text hold). The tracker
     * keeps its last state through one, so without this the panel went on
     * saying "Following", with a live-looking pace, over a take that had
     * stopped.
     */
    takePaused?: 'none' | 'listening' | 'hard';
    /**
     * What the operator can do about the state above, rendered INSIDE its
     * block: an input picker, the privacy-pane buttons, the candidate lines.
     * Pass it only while there is something to render.
     */
    remedy?: Snippet;
    onnoticeaction?: (action: NonNullable<FollowNotice['action']>) => void;
  }

  let {
    follow,
    sectionTitle = null,
    voiceInput = true,
    micState = 'live',
    inputDeviceLost = false,
    microphoneRefused = false,
    voiceAvailable = true,
    connection = 'connected',
    heardAnything = true,
    heldByUser = false,
    rollingAtPace = false,
    takePaused = 'none',
    remedy,
    onnoticeaction,
  }: Props = $props();

  /*
   * One resolver, and the panel reads nothing else about the tracker.
   *
   * The nest of ternaries this replaced had to be read three times to work out
   * what a manual take says while paused, and it is also how the decision-code
   * row below it survived: with the copy scattered across the component there
   * was no single place that said what this panel is allowed to show.
   * `followStatus` takes a narrow input, so reaching for a decision code now
   * means widening a declared contract rather than adding one more line here.
   */
  const resolved = $derived(
    followStatus({
      state: follow.state,
      decision: follow.decision,
      heldByUser,
      rollingAtPace,
      receivingFrames: follow.receivingFrames,
      voiceInput,
      micState,
      inputDeviceLost,
      microphoneRefused,
      heardAnything,
    }),
  );

  /**
   * The two take-level conditions `followStatus` cannot see, because they are
   * about the recogniser rather than the tracker.
   *
   * A refused speech model reached the resolver as a dead input and came out as
   * "Speech recognition stopped", beside a notice saying "not ready" and a toast
   * saying "could not be loaded" — three causes for one event. It is named once,
   * in a neutral light (#286): nothing about the microphone is wrong.
   *
   * The first second of every voice take is the model warming, and the resolver
   * called that "Ready to follow" while the notice below called it
   * "unavailable". It is a start, and it says so.
   */
  const startingVoice = $derived(
    voiceInput &&
      voiceAvailable &&
      micState === 'live' &&
      connection === 'reconnecting' &&
      !heardAnything &&
      !heldByUser &&
      !rollingAtPace,
  );
  const modelRefused = $derived(
    voiceInput && !voiceAvailable && !inputDeviceLost && !microphoneRefused,
  );

  const status = $derived.by((): FollowStatus => {
    if (modelRefused) {
      return {
        line: 'Voice unavailable',
        detail: `The speech model is not available, so this take cannot follow your voice. ${
          rollingAtPace
            ? 'The text is rolling at your set pace.'
            : 'The text is holding where you left it — move it yourself, or roll it at a set pace.'
        }`,
        tone: 'neutral',
      };
    }
    /*
     * A paused take outranks everything but a fault: an input that died during
     * the pause still needs its remedy first. The panel is open while this is
     * read, and an open drawer stands the stage's keys down — hence "close this
     * panel" before Space.
     *
     * A soft pause keeps the microphone open, and says so, because that is the
     * difference between it and a hard one. It used to add "Say “Speaking Glass,
     * resume”" — a voice command nothing in the app listens for. The one way
     * back that works is the key, so that is the only one offered.
     */
    if (takePaused !== 'none' && resolved.tone !== 'warning') {
      return {
        line: 'Take paused',
        detail:
          voiceInput && takePaused === 'listening'
            ? 'The text stays where it is and the microphone stays on. Close this panel and press Space to carry on.'
            : voiceInput
              ? 'The microphone is off and the text stays where it is. Close this panel and press Space to carry on.'
              : 'The text stays where it is. Close this panel and press Space to carry on.',
        tone: 'neutral',
      };
    }
    if (startingVoice) {
      return {
        line: 'Starting voice following',
        detail: 'Speech recognition is getting ready. The stage picks up your place once it hears you.',
        tone: 'accent',
      };
    }
    /*
     * Steady following has no detail of its own, and the drawer used to put
     * the movement promise under its buttons instead — where a held take
     * repeated "the text stays where it is" twice, one paragraph apart.
     */
    if (voiceInput && resolved.detail === null && follow.state === 'following') {
      return { ...resolved, detail: MOVEMENT_DETAIL.follow };
    }
    return resolved;
  });

  /** Candidates turn "looking for your place" into a question with answers. */
  const offeringCandidates = $derived(
    follow.candidates.length > 0 && status.tone !== 'warning' && !modelRefused,
  );
  const detail = $derived(
    offeringCandidates ? 'Pick the line you are on, or keep reading.' : status.detail,
  );

  /**
   * The readings describe a tracker that is hearing you. Under a fault, a
   * hold or a roll they are the last values from before it — accurate once,
   * misleading now — so they step aside rather than stand there looking live.
   */
  const readingsLive = $derived(
    !offeringCandidates &&
      takePaused === 'none' &&
      voiceInput &&
      voiceAvailable &&
      micState === 'live' &&
      connection === 'connected' &&
      !heldByUser &&
      !rollingAtPace &&
      follow.receivingFrames &&
      follow.state !== 'paused',
  );

  /**
   * "Speech recognition is not ready" restated what the status line above it
   * already says whenever the line is about the recogniser or the input — and
   * said it with a different cause. It stays for the one case only it reports:
   * the recogniser dropping out under a live microphone mid-take.
   */
  const voiceExplainedAbove = $derived(
    startingVoice || modelRefused || (voiceInput && micState === 'disconnected'),
  );
  const notices = $derived(
    voiceExplainedAbove
      ? follow.notices.filter((notice) => notice.id !== 'transcription_interrupted')
      : follow.notices,
  );

  /*
   * The section is the tracker's place, and while it is asking which line you
   * are on it does not have one: each candidate names its own section instead.
   * Leaving it out is also what keeps the routine controls on a 600px panel.
   */
  const showSection = $derived(sectionTitle !== null && !offeringCandidates);

  const bandIndex = $derived(confidenceBandIndex(follow.band));
</script>

<div class="follow-state">
  <div class="state {status.tone}" class:fault={status.tone === 'warning'}>
    <!--
      The line AND its detail are one announcement: a hold that changes only
      its reason ("these words are not in the script") is news too. The remedy
      is outside it — controls do not belong in a live region.
    -->
    <div class="announce" role="status" aria-live="polite" aria-atomic="true">
      <p class="status">
        <span class="light" aria-hidden="true"></span>
        <span class="line">{status.line}</span>
      </p>
      {#if detail}
        <p class="detail">{detail}</p>
      {/if}
    </div>
    {#if remedy}
      <div class="remedy">{@render remedy()}</div>
    {/if}
  </div>

  <!--
    Part XI degraded states — each one names what is actually happening.

    In a live region that is always mounted, because a notice usually arrives
    under an unchanged status line ("Following", and then the stage starts
    dropping frames), and a region created with its content is not announced.
  -->
  <div class="notices-live" aria-live="polite">
  {#if notices.length > 0}
    <ul class="notices" aria-label="Following status notices">
      {#each notices as notice (notice.id)}
        <li class="notice {notice.tone}">
          <p class="notice-title">{notice.title}</p>
          <p class="notice-detail">{notice.detail}</p>
          {#if notice.action}
            {@const action = notice.action}
            <Button size="sm" onclick={() => onnoticeaction?.(action)}>{action.label}</Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  </div>

  <!--
    NO DECISION-CODE ROW HERE (CCUX-001).

    This used to carry a "Doing" row rendering `FOLLOW_DECISION_LABELS`, which
    put "Local match confirmed", "Relocated" and "Possible jump — gathering
    evidence" in front of a presenter mid-take. `follow-language.ts` states
    plainly that those codes are diagnostics vocabulary and must not become
    user-facing copy — they describe the engine's internal reasoning, which is
    re-tuned freely, whereas the four states above are a promise about
    behaviour. The row was a live contradiction of its own module's contract.

    The codes are not lost: `FollowDiagnostics` shows them, per-movement and
    with the scores that make them mean anything, one disclosure away.
  -->
  {#if readingsLive || showSection}
    <dl class="readings">
      {#if readingsLive}
        <!-- Banded confidence: four steps, labelled in words (§48). -->
        <div class="reading">
          <dt>Confidence</dt>
          <dd class="confidence">
            <span
              class="meter"
              role="meter"
              aria-label="Tracking confidence"
              aria-valuemin={0}
              aria-valuemax={CONFIDENCE_BANDS.length}
              aria-valuenow={bandIndex + 1}
              aria-valuetext={CONFIDENCE_BAND_LABELS[follow.band]}
            >
              {#each CONFIDENCE_BANDS as band, index (band)}
                <span
                  class="step"
                  class:filled={index <= bandIndex}
                  class:weak={follow.band === 'low' || follow.band === 'unsure'}
                  aria-hidden="true"
                ></span>
              {/each}
            </span>
            <span class="confidence-label">{CONFIDENCE_BAND_LABELS[follow.band]}</span>
          </dd>
        </div>
        <div class="reading">
          <dt>Pace</dt>
          <dd>{formatPace(follow.paceWordsPerMinute)}</dd>
        </div>
      {/if}
      {#if showSection}
        <div class="reading">
          <dt>Section</dt>
          <dd class="section">{sectionTitle}</dd>
        </div>
      {/if}
    </dl>
  {/if}
</div>

<style>
  /* Margins, not a gap: the notices' live region is always mounted and must
     cost nothing while it is empty. */
  .follow-state {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .notices,
  .readings {
    margin-top: var(--space-4);
  }
  .announce {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  /* --- the one answer --------------------------------------------------- */
  .state {
    --state-light: var(--text-faint);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .state.success {
    --state-light: var(--success);
  }
  .state.accent {
    --state-light: var(--accent);
  }
  .state.warning {
    --state-light: var(--warning);
  }
  /*
   * A fault, and only a fault, is a block: the line, what Speaking Glass did, and
   * the remedy read as one thing. Leading rule is an inset ::before bar —
   * never a one-sided border on a rounded box.
   */
  .state.fault {
    position: relative;
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .state.fault::before {
    content: '';
    position: absolute;
    left: 7px;
    top: var(--space-3);
    bottom: var(--space-3);
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--warning);
  }

  .status {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-xl);
    line-height: var(--lh-section);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
    min-width: 0;
  }
  /* The light is the state's colour; the words are the state. */
  .light {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--state-light);
    transform: translateY(-2px);
  }
  .state.fault .light {
    display: none;
  }
  .line {
    min-width: 0;
    text-wrap: balance;
  }

  .detail {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    text-wrap: pretty;
  }

  .remedy {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-1);
    min-width: 0;
  }

  /* --- readings ---------------------------------------------------------- */
  .readings {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr);
    gap: var(--space-2) var(--space-3);
    margin-bottom: 0;
    margin-inline: 0;
  }
  .reading {
    display: contents;
  }
  .readings dt {
    font-size: var(--text-meta);
    color: var(--text-muted);
    align-self: center;
  }
  .readings dd {
    margin: 0;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .readings .section {
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }

  .confidence {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .meter {
    display: flex;
    gap: 3px;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 160px;
  }
  .step {
    flex: 1 1 0;
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--bg-sunken);
    transition: background var(--dur-med) var(--ease-out);
  }
  .step.filled {
    background: var(--success);
  }
  .step.filled.weak {
    background: var(--warning);
  }
  .confidence-label {
    flex: 0 0 auto;
    font-size: var(--text-sm);
    color: var(--text-primary);
  }

  /* --- degraded-state notices -------------------------------------------- */
  .notices {
    list-style: none;
    margin-bottom: 0;
    margin-inline: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  /* Leading rule is an inset ::before bar — never a one-sided border. */
  .notice {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-start;
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .notice::before {
    content: '';
    position: absolute;
    left: 7px;
    top: var(--space-3);
    bottom: var(--space-3);
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--text-faint);
  }
  .notice.info::before {
    background: var(--accent);
  }
  .notice.warning::before {
    background: var(--warning);
  }
  .notice.danger::before {
    background: var(--danger);
  }
  .notice-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .notice-detail {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    text-wrap: pretty;
  }

  @media (prefers-reduced-motion: reduce) {
    .step {
      transition: none;
    }
  }
</style>
