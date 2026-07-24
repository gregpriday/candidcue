<!--
  Post-take review (spec §31).

  The component renders one prop and computes no measurement. Every figure it
  shows was formatted in `shared/coaching/review` from recorded evidence
  (§31.5), and the only arithmetic here is layout — turning an audio-clock
  millisecond into a percentage across the timeline. That split is deliberate:
  a component that cannot compute a number cannot show a wrong one, and it also
  means the whole screen is testable in this repo's node environment.

  Mounting: `<Review {model} />` where `model = buildReviewModel({ record,
  script, priorSummaries })`. Everything else is optional.
-->
<script lang="ts">
  import {
    selectPassage,
    type ReviewModel,
    type ScriptAnnotation,
    type TimelineEvent,
    type TimelineStep,
    type TimelineTrackId,
  } from '../../shared/coaching/review';

  interface Props {
    /** Everything the screen shows. Built by `buildReviewModel`. */
    model: ReviewModel;
    /** Called with an audio-clock offset when the user scrubs to an event. */
    onplayfrom?: (audioTimeMs: number) => void;
    /** Called when an event resolves to a script passage. */
    onselectpassage?: (spanId: string) => void;
    /** Back control, wired by the shell. */
    onback?: () => void;
  }

  let { model, onplayfrom, onselectpassage, onback }: Props = $props();

  let selectedEventId: string | null = $state(null);

  const timeline = $derived(model.timeline);
  const spanMs = $derived(Math.max(1, timeline.durationMs));

  /** Layout only: audio-clock ms → percentage across the track. */
  function offsetPercent(atMs: number): number {
    return ((atMs - timeline.startMs) / spanMs) * 100;
  }

  function widthPercent(startMs: number, endMs: number): number {
    return (Math.max(0, endMs - startMs) / spanMs) * 100;
  }

  /** Layout only: a step's height inside its own measured range. */
  function stepDomain(steps: readonly TimelineStep[]): { low: number; high: number } {
    const values = steps
      .map((step) => step.value)
      .filter((value): value is number => value !== null);
    if (values.length === 0) return { low: 0, high: 1 };
    const low = Math.min(...values);
    const high = Math.max(...values);
    return high === low ? { low: low - 1, high: high + 1 } : { low, high };
  }

  const wpmDomain = $derived(stepDomain(timeline.wpm));
  const varietyDomain = $derived(stepDomain(timeline.variety));

  function heightPercent(value: number, domain: { low: number; high: number }): number {
    return ((value - domain.low) / (domain.high - domain.low)) * 100;
  }

  const EVENT_TRACKS: ReadonlyArray<{ id: TimelineTrackId; label: string }> = [
    { id: 'fillers', label: 'Fillers' },
    { id: 'pauses', label: 'Pauses' },
    { id: 'discrepancies', label: 'Script discrepancies' },
    { id: 'tips', label: 'Tips shown' },
    { id: 'retakes', label: 'Retakes' },
  ];

  const eventsByTrack = $derived(
    EVENT_TRACKS.map((track) => ({
      ...track,
      events: timeline.events.filter((event) => event.track === track.id),
    })),
  );

  const selectedPassageSpanId = $derived.by(() => {
    if (selectedEventId === null) return null;
    const result = selectPassage(model, selectedEventId);
    return result.resolved ? result.selection.passage.spanId : null;
  });

  const selectionNotice = $derived.by(() => {
    if (selectedEventId === null) return null;
    const result = selectPassage(model, selectedEventId);
    if (result.resolved) return null;
    return result.reason === 'no_script_anchor'
      ? 'This event was counted but could not be placed in the script.'
      : 'This event points at a part of the script that has since changed.';
  });

  function chooseEvent(event: TimelineEvent): void {
    selectedEventId = event.eventId;
    const result = selectPassage(model, event.eventId);
    if (result.resolved) onselectpassage?.(result.selection.passage.spanId);
    if (timeline.audio.available) onplayfrom?.(event.startMs);
  }

  function annotationTitle(annotation: ScriptAnnotation): string {
    return annotation.authoredFragment === null
      ? annotation.label
      : `${annotation.label}: “${annotation.authoredFragment}”`;
  }

  const passLabel = (ordinal: number): string => `Take ${ordinal}`;
</script>

<div class="page" data-testid="review">
  <header class="header">
    {#if onback}
      <button type="button" class="back" onclick={onback}>Back</button>
    {/if}
    <h1 class="title">Take review</h1>
    <p class="meta">
      {model.summary.takePassCount === 1
        ? 'One take pass'
        : `${model.summary.takePassCount} take passes`}
    </p>
  </header>

  <!-- §32.2: the UI must state exactly what is retained. -->
  <section class="retention" aria-label="What is saved">
    {#each model.retention.lines as line (line)}
      <p class="retention-line">{line}</p>
    {/each}
  </section>

  <!-- §31.2 -->
  <section class="cards" aria-label="Summary">
    {#each model.cards as card (card.id)}
      <article class="card" class:attention={card.tone === 'attention'} data-card={card.id}>
        <h2 class="card-label">{card.label}</h2>
        {#if card.value === null}
          <p class="card-absent">{card.absentLabel}</p>
        {:else}
          <p class="card-value">{card.value}</p>
          {#if card.detail}<p class="card-detail">{card.detail}</p>{/if}
        {/if}
      </article>
    {/each}
  </section>

  <!-- §31.5 -->
  <section class="block" aria-label="Recommendations">
    <h2 class="block-title">What to try next</h2>
    {#if model.recommendations.length === 0}
      <p class="quiet">Nothing in this take stood out as a repeated pattern.</p>
    {:else}
      <ol class="recommendations">
        {#each model.recommendations as recommendation (recommendation.patternId)}
          <li class="recommendation">{recommendation.text}</li>
        {/each}
      </ol>
    {/if}
    {#each model.followThrough.filter((entry) => entry.text !== null) as entry (entry.tipId)}
      <p class="follow-through">{entry.text}</p>
    {/each}
  </section>

  <!-- §31.3 -->
  <section class="block" aria-label="Timeline">
    <div class="block-head">
      <h2 class="block-title">Timeline</h2>
      {#if timeline.audio.available}
        <button
          type="button"
          class="play"
          onclick={() => onplayfrom?.(timeline.startMs)}
        >
          Play the take
        </button>
      {:else}
        <p class="quiet" data-testid="playback-absent">
          {timeline.audio.reason === 'recording_not_enabled'
            ? 'Audio playback is unavailable: this take was not recorded.'
            : timeline.audio.reason === 'consent_withdrawn'
              ? 'Audio playback is unavailable: the recording was not kept.'
              : 'Audio playback is unavailable: the recording could not be found.'}
        </p>
      {/if}
    </div>

    <div class="tracks">
      <div class="track">
        <span class="track-label">Speech</span>
        <div class="lane">
          {#each timeline.speech as segment, i (`${segment.kind}-${segment.startMs}-${i}`)}
            <span
              class="segment {segment.kind}"
              style="left: {offsetPercent(segment.startMs)}%; width: {widthPercent(
                segment.startMs,
                segment.endMs,
              )}%"
            ></span>
          {/each}
        </div>
      </div>

      <div class="track">
        <span class="track-label">Pace</span>
        <div class="lane">
          {#each timeline.wpm as step, i (`wpm-${step.startMs}-${i}`)}
            {#if step.value !== null}
              <span
                class="bar"
                style="left: {offsetPercent(step.startMs)}%; width: {widthPercent(
                  step.startMs,
                  step.endMs,
                )}%; height: {heightPercent(step.value, wpmDomain)}%"
              ></span>
            {/if}
          {/each}
        </div>
      </div>

      <div class="track">
        <span class="track-label">Variety</span>
        <div class="lane">
          {#each timeline.variety as step, i (`var-${step.startMs}-${i}`)}
            {#if step.value !== null}
              <span
                class="bar variety"
                style="left: {offsetPercent(step.startMs)}%; width: {widthPercent(
                  step.startMs,
                  step.endMs,
                )}%; height: {heightPercent(step.value, varietyDomain)}%"
              ></span>
            {/if}
          {/each}
        </div>
      </div>

      {#each eventsByTrack as track (track.id)}
        <div class="track">
          <span class="track-label">{track.label}</span>
          <div class="lane">
            {#each track.events as event (event.eventId)}
              <button
                type="button"
                class="tick {event.track}"
                class:selected={selectedEventId === event.eventId}
                style="left: {offsetPercent(event.startMs)}%"
                aria-label="{event.label} — {passLabel(event.passOrdinal)}"
                onclick={() => chooseEvent(event)}
              >
                <span class="tick-text">{event.label}</span>
              </button>
            {/each}
          </div>
        </div>
      {/each}

      <div class="track">
        <span class="track-label">Script position</span>
        <div class="lane">
          {#each timeline.scriptPosition as point, i (`pos-${point.atMs}-${i}`)}
            {#if point.progress !== null}
              <span
                class="dot"
                style="left: {offsetPercent(point.atMs)}%; bottom: {point.progress * 100}%"
              ></span>
            {/if}
          {/each}
        </div>
      </div>
    </div>

    {#if selectionNotice}
      <p class="quiet" data-testid="selection-notice">{selectionNotice}</p>
    {/if}
  </section>

  <!-- §31.4 -->
  <section class="block" aria-label="Script">
    <h2 class="block-title">Script</h2>
    {#if model.annotatedScript === null}
      <p class="quiet">The script for this take is not available.</p>
    {:else}
      {#if model.annotatedScript.revisionMismatch}
        <p class="quiet" data-testid="revision-mismatch">
          The script has changed since this take. Marks may no longer line up.
        </p>
      {/if}
      <ol class="passages">
        {#each model.annotatedScript.passages as entry (entry.passage.spanId)}
          <li
            class="passage"
            class:selected={selectedPassageSpanId === entry.passage.spanId}
            data-span={entry.passage.spanId}
          >
            <p class="passage-text">{entry.passage.text}</p>
            {#if entry.annotations.length > 0}
              <ul class="annotations">
                {#each entry.annotations as annotation (annotation.annotationId)}
                  <li class="annotation {annotation.kind}">
                    <span class="annotation-pass">{passLabel(annotation.passOrdinal)}</span>
                    <span class="annotation-label">{annotationTitle(annotation)}</span>
                    {#if annotation.spokenFragment}
                      <span class="annotation-spoken">heard “{annotation.spokenFragment}”</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ol>
      {#if model.annotatedScript.unanchored.length > 0}
        <p class="quiet" data-testid="unanchored">
          {model.annotatedScript.unanchored.length === 1
            ? '1 event was counted but could not be placed in the script.'
            : `${model.annotatedScript.unanchored.length} events were counted but could not be placed in the script.`}
        </p>
      {/if}
    {/if}
  </section>

  <!-- §31.6 -->
  <section class="block" aria-label="Compared with your earlier sessions">
    <h2 class="block-title">Compared with your earlier sessions</h2>
    {#if !model.comparison.hasBaseline}
      <p class="quiet" data-testid="no-baseline">
        {model.comparison.priorSessionCount === 0
          ? 'This is the first saved session for this script, so there is nothing to compare with yet.'
          : 'Your earlier sessions were measured differently, so they are not comparable with this one.'}
      </p>
    {:else}
      <ul class="trends">
        {#each model.comparison.trends as trend (trend.metricId)}
          <li class="trend" data-metric={trend.metricId}>
            <span class="trend-label">{trend.label}</span>
            {#if trend.notComparable !== null || trend.delta === null}
              <span class="quiet">Not compared</span>
            {:else}
              <span class="trend-delta">
                {trend.delta > 0 ? '+' : trend.delta < 0 ? '−' : ''}{Math.abs(
                  Math.round(trend.delta * 100),
                ) / 100} against your last {trend.baselineSessionCount === 1
                  ? 'session'
                  : `${trend.baselineSessionCount} sessions`}
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .page {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    padding: var(--page-y) var(--page-x) var(--space-10);
    overflow-y: auto;
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .back {
    align-self: flex-start;
    height: var(--icon-control-h);
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .back:hover {
    background: var(--bg-hover-chrome);
  }
  /* Quiet focus on a chrome control — no accent ring. */
  .back:focus-visible {
    outline: none;
    background: var(--bg-hover-chrome);
    border-color: var(--border-strong);
  }

  .title {
    margin: 0;
    font-family: var(--font-serif);
    font-size: var(--text-page-title);
    font-weight: 600;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }

  .meta {
    margin: 0;
    font-size: var(--text-meta);
    color: var(--text-muted);
  }

  .retention {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4);
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
  }
  .retention-line {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  /* Leading rule as an inset bar — never a one-sided border on a rounded box. */
  .card.attention::before {
    content: '';
    position: absolute;
    inset: var(--space-2) auto var(--space-2) 0;
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }
  .card.attention {
    padding-left: calc(var(--space-4) + var(--space-2));
  }

  .card-label {
    margin: 0;
    font-size: var(--text-meta);
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .card-value {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
  .card-detail,
  .card-absent {
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--lh-label);
    color: var(--text-muted);
  }
  .card-absent {
    font-style: italic;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .block-title {
    margin: 0;
    font-size: var(--text-section);
    font-weight: 600;
    color: var(--text-primary);
  }

  .quiet {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  .recommendations {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .recommendation {
    position: relative;
    padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + var(--space-2));
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    font-size: var(--text-base);
    line-height: var(--lh-label);
    color: var(--text-primary);
    max-width: var(--prose-measure);
  }
  .recommendation::before {
    content: '';
    position: absolute;
    inset: var(--space-3) auto var(--space-3) var(--space-2);
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }

  .follow-through {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .play {
    height: var(--button-h);
    padding: 0 var(--space-4);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    box-shadow: var(--shadow-card);
    transition: background var(--dur-fast) var(--ease-out);
  }
  .play:hover {
    background: var(--bg-hover-surface);
  }
  .play:active {
    transform: scale(0.98);
  }
  .play:focus-visible {
    outline: none;
    border-color: var(--border-strong);
    background: var(--bg-hover-surface);
  }

  .tracks {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    overflow-x: auto;
  }

  .track {
    display: grid;
    grid-template-columns: 132px 1fr;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .track-label {
    font-size: var(--text-2xs);
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .lane {
    position: relative;
    height: 26px;
    min-width: 0;
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
  }

  .segment {
    position: absolute;
    top: 6px;
    bottom: 6px;
    border-radius: var(--radius-pill);
  }
  .segment.voiced {
    background: var(--accent);
    opacity: 0.55;
  }
  .segment.pause {
    background: var(--border-strong);
  }
  /* Unmeasured audio is drawn as absence, never as silence. */
  .segment.unmeasured {
    background: repeating-linear-gradient(
      135deg,
      var(--border-faint) 0 4px,
      transparent 4px 8px
    );
  }

  .bar {
    position: absolute;
    bottom: 0;
    min-height: 2px;
    background: var(--accent);
    opacity: 0.6;
    border-radius: 2px 2px 0 0;
  }
  .bar.variety {
    background: var(--text-secondary);
    opacity: 0.5;
  }

  .dot {
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: var(--radius-pill);
    background: var(--text-secondary);
  }

  .tick {
    position: absolute;
    top: 3px;
    bottom: 3px;
    width: 8px;
    margin-left: -4px;
    padding: 0;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-pill);
    background: var(--bg-elevated);
    cursor: pointer;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .tick-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tick:hover {
    background: var(--bg-hover-surface);
    border-color: var(--border-strong);
  }
  /* Quiet focus on a dense row control — background and border only. */
  .tick:focus-visible {
    outline: none;
    background: var(--bg-hover-surface);
    border-color: var(--border-strong);
  }
  .tick.selected {
    background: var(--accent);
    border-color: var(--accent-strong);
  }
  .tick.discrepancies {
    background: var(--danger-soft);
  }

  .passages {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: var(--prose-measure);
  }
  .passage {
    position: relative;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: transparent;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .passage.selected {
    background: var(--accent-wash);
    padding-left: calc(var(--space-4) + var(--space-2));
  }
  .passage.selected::before {
    content: '';
    position: absolute;
    inset: var(--space-3) auto var(--space-3) var(--space-2);
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }
  .passage-text {
    margin: 0;
    font-family: var(--font-serif);
    font-size: var(--text-lg);
    line-height: 1.55;
    color: var(--prose-text-warm);
  }

  .annotations {
    margin: var(--space-2) 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .annotation {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: 2px var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--bg-secondary);
    font-size: var(--text-2xs);
    color: var(--text-secondary);
  }
  .annotation-pass {
    color: var(--text-faint);
  }
  /* Small terracotta text uses --accent-strong so it clears AA in the light theme. */
  .annotation.critical_mismatch .annotation-label {
    color: var(--accent-strong);
    font-weight: 600;
  }
  .annotation-spoken {
    color: var(--text-muted);
    font-style: italic;
  }

  .trends {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: var(--prose-measure-narrow);
  }
  .trend {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    border: 1px solid var(--border-faint);
    font-size: var(--text-sm);
  }
  .trend-label {
    color: var(--text-secondary);
  }
  .trend-delta {
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
</style>
