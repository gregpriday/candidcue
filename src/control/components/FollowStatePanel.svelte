<!--
  Following state (companion §48, §49; primary §15.2).

  A calm, honest indicator: one plain-language status line, a banded
  confidence meter (never a percentage — §48 "without implying false
  precision"), the current behavior, and the Part XI degraded states with real
  copy. There is no persistent animated widget (primary §11.1) and no
  diagnostic score.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import StatusPill, { type PillTone } from './StatusPill.svelte';
  import {
    CONFIDENCE_BANDS,
    CONFIDENCE_BAND_LABELS,
    confidenceBandIndex,
    followStatus,
    formatPace,
  } from '../lib/follow-language';
  import type { FollowNotice, SmoothFollowState } from '../stores/smooth-follow';

  interface Props {
    follow: SmoothFollowState;
    /** Resolved heading for the current position, when the outline knows one. */
    sectionTitle?: string | null;
    /**
     * Whether this take actually has a microphone and a transcription feed.
     *
     * False in a manual or fixed-speed take, where nothing is listening. The
     * shared copy is written for voice — "still listening for CandidCue,
     * resume", "Transcription is still connected", "Start speaking and the
     * stage picks up your place" — and every one of those sentences is a lie
     * without a microphone. The operator reads this panel to decide whether a
     * problem is their microphone or their script, so it says what is true.
     */
    voiceInput?: boolean;
    /**
     * The input as the session knows it. Defaults to 'live' so a caller that
     * has not wired it up cannot make the panel invent a fault.
     */
    micState?: 'live' | 'muted' | 'disconnected';
    /**
     * Whether anything has been transcribed this take.
     *
     * Defaults TRUE, and that direction is deliberate: the failure mode of this
     * flag is a standing "nothing heard" line over a take that is going fine,
     * so an unwired caller must fall silent rather than accuse.
     */
    heardAnything?: boolean;
    onnoticeaction?: (action: NonNullable<FollowNotice['action']>) => void;
  }

  let {
    follow,
    sectionTitle = null,
    voiceInput = true,
    micState = 'live',
    heardAnything = true,
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
  const status = $derived(
    followStatus({
      state: follow.state,
      decision: follow.decision,
      followingPaused: follow.followingPaused,
      receivingFrames: follow.receivingFrames,
      voiceInput,
      micState,
      heardAnything,
    }),
  );

  const bandIndex = $derived(confidenceBandIndex(follow.band));
</script>

<div class="follow-state">
  <div class="head">
    <p class="status {status.tone}" role="status" aria-live="polite">
      {status.line}
    </p>
  </div>

  {#if status.detail}
    <p class="detail">{status.detail}</p>
  {/if}

  <!-- Banded confidence: four steps, labelled in words (§48). -->
  <div class="confidence">
    <div
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
    </div>
    <span class="confidence-label">{CONFIDENCE_BAND_LABELS[follow.band]}</span>
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
  <dl class="facts">
    <div class="fact">
      <dt>Pace</dt>
      <dd>{formatPace(follow.paceWordsPerMinute)}</dd>
    </div>
    {#if sectionTitle}
      <div class="fact">
        <dt>Section</dt>
        <dd>{sectionTitle}</dd>
      </div>
    {/if}
  </dl>

  <!-- Part XI degraded states — each one names what is actually happening. -->
  {#if follow.notices.length > 0}
    <ul class="notices" aria-label="Following status notices">
      {#each follow.notices as notice (notice.id)}
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

<style>
  .follow-state {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .status {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text-primary);
    min-width: 0;
  }
  .status.warning {
    color: var(--warning);
  }
  .status.success,
  .status.accent,
  .status.neutral {
    color: var(--text-primary);
  }

  .detail {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
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
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .facts {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px var(--space-3);
    margin: 0;
  }
  .fact {
    display: contents;
  }
  .facts dt {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-faint);
    align-self: center;
  }
  .facts dd {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .notices {
    list-style: none;
    margin: var(--space-1) 0 0;
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
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }
  .notice::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 8px;
    bottom: 8px;
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
    font-size: var(--text-xs);
    font-weight: 650;
    color: var(--text-primary);
  }
  .notice-detail {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: 1.45;
    color: var(--text-muted);
  }

  @media (prefers-reduced-motion: reduce) {
    .step {
      transition: none;
    }
  }
</style>
