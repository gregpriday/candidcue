<!--
  §30.3 calibration preview, shown during the Preflight microphone test.

  What it shows: relative input level, how quiet the room is, whether anything
  clipped, pitch-detection confidence, a sample pace once there is enough of a
  read, a variety status once there is evidence for one, and a live example of
  the rail as it is currently configured.

  What it deliberately refuses to show:

  - any decibel figure. §12.7.4: without a calibrated microphone and a known
    distance CandidCue measures relative digital level, not sound pressure, so
    "you are speaking at 68 dB" would be a made-up number. Level is a meter and
    a word;
  - a pace figure before the sample supports one (§14.1 needs voiced time and
    words, and four words over a second is not a pace);
  - a variety score without pitch evidence. §17.5 forbids deriving one from the
    remaining features when pitch reliability is insufficient, so the preview
    says it is not measured rather than showing a plausible zero.

  It is optional and it never gates Start: §30.3 says live adaptation remains
  authoritative. Nothing here reports into the Preflight readiness store.
-->
<script lang="ts">
  import MicMeter from './MicMeter.svelte';
  import {
    INITIAL_CALIBRATION,
    LEVEL_ADVICE,
    LEVEL_LABEL,
    PITCH_CONFIDENCE_LABEL,
    PITCH_CONFIDENCE_TOO_LOW,
    PITCH_NOT_MEASURED_HERE,
    ROOM_LABEL,
    levelVerdict,
    pitchConfidenceVerdict,
    reduceCalibration,
    roomVerdict,
    samplePace,
    samplePaceShortfall,
    type CalibrationState,
  } from '../lib/calibration-preview';
  import { resolvedPaceBand, resolvedVarietyBand } from '../lib/coaching-profiles';
  import type { AudioLevelSnapshot, CoachingSettings } from '../../shared/contracts';

  interface Props {
    level: AudioLevelSnapshot | null;
    /** Whatever the microphone test has transcribed so far. */
    transcript?: string;
    coaching: CoachingSettings;
    /**
     * Optional pitch-detection confidence, 0–1, when a source is wired.
     * `null` — the current state of the control window's audio seam — means
     * "no pitch source", which the preview states as such rather than scoring.
     */
    pitchConfidence?: number | null;
    /**
     * Optional measured variety, 0–100, when a producer supplies one. Absent,
     * the preview says so; it never derives one from loudness (§17.5).
     */
    varietyScore?: number | null;
  }
  let {
    level,
    transcript = '',
    coaching,
    pitchConfidence = null,
    varietyScore = null,
  }: Props = $props();

  /*
   * The accumulator is a PLAIN variable and `sample` is the published copy.
   *
   * Folding straight into a `$state` the effect also reads is an effect that
   * reads and writes the same state, which Svelte 5 stops with
   * `effect_update_depth_exceeded` — i.e. the preview crashed the moment a
   * second audio frame arrived. Reading only `level` keeps the effect's
   * dependency set to the thing that actually changes.
   */
  let accumulator: CalibrationState = { ...INITIAL_CALIBRATION };
  let lastFrameAtMs: number | null = null;
  let sample = $state<CalibrationState>({ ...INITIAL_CALIBRATION });
  $effect(() => {
    const frame = level;
    if (!frame) return;
    // Frames repeat while nothing else changes; folding one twice would double
    // the voiced time and halve the pace it implies.
    if (frame.generatedAtMs === lastFrameAtMs) return;
    lastFrameAtMs = frame.generatedAtMs;
    accumulator = reduceCalibration(accumulator, frame);
    sample = accumulator;
  });

  const verdict = $derived(levelVerdict(sample, level));
  const room = $derived(roomVerdict(sample));
  const pace = $derived(samplePace(sample, transcript));
  const paceShortfall = $derived(samplePaceShortfall(sample, transcript));
  const pitchVerdict = $derived(pitchConfidenceVerdict(pitchConfidence));
  const band = $derived(resolvedPaceBand(coaching));
  const varietyBand = $derived(resolvedVarietyBand(coaching));

  const paceInBand = $derived(
    pace !== null && pace.articulationWpm >= band.lowWpm && pace.articulationWpm <= band.highWpm,
  );

  export function reset(): void {
    accumulator = { ...INITIAL_CALIBRATION };
    sample = accumulator;
    lastFrameAtMs = null;
  }
</script>

<div class="preview">
  <div class="row">
    <span class="key">Input level</span>
    <div class="value meter-cell">
      <MicMeter {level} />
    </div>
  </div>
  <p class="note">
    <strong class="verdict">{LEVEL_LABEL[verdict]}.</strong>
    {LEVEL_ADVICE[verdict]}
    Level is relative — CandidCue has no way to measure how loud the room actually is.
  </p>

  <div class="row">
    <span class="key">Background</span>
    <span class="value">{ROOM_LABEL[room]}</span>
  </div>

  <div class="row">
    <span class="key">Clipping</span>
    <span class="value" class:warn={sample.everClipped}>
      {sample.everClipped ? 'Clipped during this test' : 'None so far'}
    </span>
  </div>

  <div class="row">
    <span class="key">Pitch confidence</span>
    <span class="value">{PITCH_CONFIDENCE_LABEL[pitchVerdict]}</span>
  </div>
  {#if pitchVerdict === 'unavailable'}
    <p class="note">{PITCH_NOT_MEASURED_HERE}</p>
  {:else if pitchVerdict === 'too_low'}
    <p class="note">{PITCH_CONFIDENCE_TOO_LOW}</p>
  {/if}

  <div class="row">
    <span class="key">Sample pace</span>
    <span class="value">
      {#if pace}
        {pace.articulationWpm} wpm
      {:else}
        Not enough yet
      {/if}
    </span>
  </div>
  {#if pace}
    <p class="note">
      Words over speaking time, from {pace.wordCount} words in {pace.speakingSeconds}s of speech —
      pauses excluded, so it reads a little higher than the pace the rail shows.
      {paceInBand
        ? `That is inside your ${band.lowWpm}–${band.highWpm} target.`
        : `Your target is ${band.lowWpm}–${band.highWpm}.`}
    </p>
  {:else}
    <p class="note">{paceShortfall}</p>
  {/if}

  <div class="row">
    <span class="key">Vocal variety</span>
    <span class="value">
      {#if varietyScore !== null && pitchVerdict !== 'unavailable' && pitchVerdict !== 'too_low'}
        {Math.round(varietyScore)} of 100
      {:else}
        Not enough evidence
      {/if}
    </span>
  </div>
  {#if varietyScore !== null && pitchVerdict !== 'unavailable' && pitchVerdict !== 'too_low'}
    <p class="note">Your band is {varietyBand.low}–{varietyBand.high} for this vocal style.</p>
  {/if}

  <!-- §30.3 "a live example of the rail" — the configuration, not a reading. -->
  <div class="rail-example" aria-label="Example coaching rail">
    <span class="example-tag">Example</span>
    <div class="rail">
      {#if coaching.mode === 'off'}
        <span class="rail-item muted">The rail is off.</span>
      {:else if coaching.mode === 'review_only'}
        <span class="rail-item muted">Nothing live — everything waits for the report.</span>
      {:else}
        {#if coaching.modules.paceNumber}<span class="rail-item">142 wpm</span>{/if}
        {#if coaching.modules.paceStatus}<span class="rail-item">On target</span>{/if}
        {#if coaching.modules.targetDurationStatus && coaching.targetDurationSeconds !== null}
          <span class="rail-item">On track</span>
        {/if}
        {#if coaching.modules.varietyScore}<span class="rail-item">Variety 61</span>{/if}
        {#if coaching.modules.fillerCount}<span class="rail-item">2 fillers</span>{/if}
        {#if coaching.modules.liveTips}<span class="rail-item tip">Ease back slightly</span>{/if}
      {/if}
    </div>
    {#if coaching.mode !== 'off' && coaching.mode !== 'review_only' && coaching.modules.fillerRibbon}
      <div class="ribbon" aria-hidden="true">
        <span class="mark"></span><span class="mark"></span><span class="mark"></span>
      </div>
    {/if}
  </div>
  <p class="note">
    These are sample numbers showing the layout you have chosen, not a measurement of this test.
  </p>
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: 26px;
  }
  .key {
    font-size: var(--text-label);
    font-weight: 600;
    color: var(--text-secondary);
    flex: 0 0 auto;
  }
  .value {
    font-size: var(--text-sm);
    color: var(--text-primary);
    text-align: right;
    font-variant-numeric: tabular-nums;
    min-width: 0;
  }
  .value.warn {
    color: var(--warning);
  }
  .meter-cell {
    flex: 1 1 auto;
    max-width: 320px;
  }

  .note {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }
  /* Small terracotta text uses --accent-strong so it clears AA in light. */
  .verdict {
    color: var(--accent-strong);
    font-weight: 600;
  }

  .rail-example {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
  }
  .example-tag {
    font-size: var(--text-2xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 700;
    color: var(--text-faint);
  }
  .rail {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    min-height: 22px;
  }
  .rail-item {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .rail-item.muted {
    font-weight: 500;
    color: var(--text-faint);
  }
  .rail-item.tip {
    color: var(--accent-strong);
    font-weight: 500;
  }
  .ribbon {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 6px;
  }
  .mark {
    width: 14px;
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--border-strong);
  }
</style>
