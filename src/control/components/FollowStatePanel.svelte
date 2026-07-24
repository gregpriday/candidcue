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
    FOLLOW_BEHAVIOR_LABELS,
    FOLLOW_STATE_DETAIL,
    FOLLOW_STATE_LABELS,
    confidenceBandIndex,
    followStateTone,
    formatPace,
  } from '../lib/follow-language';
  import type { FollowNotice, SmoothFollowState } from '../stores/smooth-follow';

  interface Props {
    follow: SmoothFollowState;
    /** Resolved heading for the current position, when the outline knows one. */
    sectionTitle?: string | null;
    onnoticeaction?: (action: NonNullable<FollowNotice['action']>) => void;
  }

  let { follow, sectionTitle = null, onnoticeaction }: Props = $props();

  const statusLine = $derived(
    follow.followingPaused
      ? 'Following paused'
      : follow.receivingFrames
        ? FOLLOW_STATE_LABELS[follow.state]
        : 'Ready to follow',
  );

  const statusDetail = $derived(
    follow.followingPaused
      ? 'The text stays where it is. Transcription and voice commands keep running.'
      : follow.receivingFrames
        ? FOLLOW_STATE_DETAIL[follow.state]
        : 'Start speaking and the stage picks up your place.',
  );

  const bandIndex = $derived(confidenceBandIndex(follow.band));

  const assist = $derived.by((): { tone: PillTone; label: string } => {
    const mode = follow.assist.effectiveMode;
    switch (follow.assist.state) {
      case 'off':
        return { tone: 'neutral', label: 'Assist off' };
      case 'waiting':
        return { tone: 'accent', label: 'Assist working' };
      case 'backing_off':
        return { tone: 'warning', label: 'Assist backing off' };
      case 'unavailable':
        return { tone: 'warning', label: 'Assist unavailable' };
      case 'limit_reached':
        return { tone: 'warning', label: 'Assist limit reached' };
      default:
        return { tone: 'accent', label: mode === 'enhanced' ? 'Assist enhanced' : 'Assist balanced' };
    }
  });

  const stateTone = $derived(followStateTone(follow.state));
</script>

<div class="follow-state">
  <div class="head">
    <p class="status {follow.followingPaused ? 'neutral' : stateTone}" role="status" aria-live="polite">
      {statusLine}
    </p>
    <StatusPill tone={assist.tone} label={assist.label} />
  </div>

  {#if statusDetail}
    <p class="detail">{statusDetail}</p>
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

  <dl class="facts">
    <div class="fact">
      <dt>Doing</dt>
      <dd>{FOLLOW_BEHAVIOR_LABELS[follow.behavior]}</dd>
    </div>
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
