<!--
  Local input level meter (spec §14.2 C) — responds before anything is streamed.
  Zones use the dedicated meter tokens; state is also written as text (§20).
-->
<script lang="ts">
  import type { AudioLevelSnapshot } from '../../shared/contracts';
  import {
    INITIAL_MIC_ADVICE_STATE,
    MIC_ADVICE,
    MIC_STATUS_LABEL,
    NO_SIGNAL_AFTER_MS,
    micCondition,
    micFillPercent,
    micZone,
    reduceMicLevel,
    type MicAdviceState,
    type MicCondition,
  } from './mic-advice';

  interface Props {
    level: AudioLevelSnapshot | null;
    /**
     * Another capture has the microphone — the transcription test — so there
     * is nothing to measure. Said as a pause rather than shown as an empty
     * meter, which read as "No signal yet" beside a test that was hearing
     * every word.
     */
    paused?: boolean;
  }

  let { level, paused = false }: Props = $props();

  /* Peak hold + clip latch, so a momentary problem stays readable and the
     remedy does not flicker between words (see mic-advice.ts). Every time
     value comes from `generatedAtMs`, which rides the monitor's own clock —
     frames arrive continuously (~90 ms), so the latch expires on its own. */
  /* Seeded synchronously so the first paint already reflects the frame the
     component was handed, instead of one frame of "No signal yet". */
  function seed(): MicAdviceState {
    const first = level;
    if (!first) return INITIAL_MIC_ADVICE_STATE;
    return reduceMicLevel(INITIAL_MIC_ADVICE_STATE, first, first.generatedAtMs);
  }
  /*
   * The fold runs on a PLAIN accumulator and publishes into `held`.
   *
   * It used to be `held = reduceMicLevel(held, …)` inside the effect — an
   * effect that reads and writes the same `$state`. `reduceMicLevel` always
   * returns a fresh object, so the write re-triggered the effect, which wrote
   * again, and Svelte 5 aborted the whole component with
   * `effect_update_depth_exceeded` on the very first level frame. The meter on
   * Preflight's microphone section died as soon as audio arrived; the DOM test
   * project (tests/dom/mic-meter.test.ts) is what made it visible.
   */
  let accumulator: MicAdviceState = seed();
  /** The frame `seed()` already folded, so the effect does not fold it twice. */
  function seedFrameMs(): number | null {
    return level?.generatedAtMs ?? null;
  }
  let lastFrameAtMs: number | null = seedFrameMs();
  let held = $state<MicAdviceState>(accumulator);

  /*
   * Two more marks, folded the same way and for the same reason.
   *
   * `openedAtMs` is when this run of frames began — the section opening, or
   * the meter coming back after a test. Silence is only news once it has
   * lasted, and "lasted" has to count from here as well as from the last
   * sound: the advice table's own clock starts at minus infinity, so the first
   * silent frame of a freshly opened input used to say "cannot hear this
   * microphone" before it had listened at all.
   *
   * `spokeAtMs` is the last frame that heard speech. The breath between two
   * words is a gap in `speaking`, and reading it out — "Hearing you", then
   * "Quiet", then "Hearing you" again, with the advice swapping beneath —
   * made the healthy state flicker at exactly the moment someone was watching.
   */
  /** Seeded from the first frame, like the fold above. */
  function seedMarks(): { openedAtMs: number | null; spokeAtMs: number } {
    const first = level;
    return {
      openedAtMs: first?.generatedAtMs ?? null,
      spokeAtMs: first?.speaking ? first.generatedAtMs : -Infinity,
    };
  }
  let { openedAtMs, spokeAtMs } = seedMarks();
  let marks = $state({ openedAtMs, spokeAtMs });
  $effect(() => {
    const frame = level;
    if (!frame) {
      openedAtMs = null;
      return;
    }
    if (frame.generatedAtMs === lastFrameAtMs) return;
    lastFrameAtMs = frame.generatedAtMs;
    accumulator = reduceMicLevel(accumulator, frame, frame.generatedAtMs);
    openedAtMs ??= frame.generatedAtMs;
    if (frame.speaking) spokeAtMs = frame.generatedAtMs;
    held = accumulator;
    marks = { openedAtMs, spokeAtMs };
  });

  /** Long enough to bridge a breath, short enough that stopping still shows. */
  const SPEAKING_HOLD_MS = 1200;

  // Normalised against the held peak, so an ordinary voice fills an ordinary
  // amount of bar instead of a sliver at the left edge (see mic-advice.ts).
  const percent = $derived(paused ? 0 : micFillPercent(level, held));
  const condition = $derived.by((): MicCondition => {
    const now = level?.generatedAtMs ?? 0;
    const raw = micCondition(level, held, now);
    if (raw === 'no_signal' && marks.openedAtMs !== null && now - marks.openedAtMs < NO_SIGNAL_AFTER_MS) {
      return 'quiet';
    }
    if (raw === 'quiet' && now - marks.spokeAtMs < SPEAKING_HOLD_MS) return 'speaking';
    return raw;
  });
  /* A fault is drawn in the colour it is named in: a sliver of healthy green
     under "Too quiet" said two things at once. */
  const zone = $derived(
    condition === 'too_low' || condition === 'no_signal' ? 'mid' : micZone(level, condition),
  );
  const statusText = $derived(paused ? 'Paused' : MIC_STATUS_LABEL[condition]);
  const advice = $derived(
    paused ? 'The test is using the microphone; the level returns when it ends.' : MIC_ADVICE[condition],
  );
  /** Conditions the operator can actually do something about (Appendix F.4). */
  const actionable = $derived(
    !paused && (condition === 'clipping' || condition === 'no_signal' || condition === 'too_low'),
  );
  /** The status word's tone. Text first; the colour only agrees with it. */
  const TONE: Record<MicCondition, 'good' | 'warn' | 'bad' | 'quiet'> = {
    idle: 'quiet',
    quiet: 'quiet',
    speaking: 'good',
    too_low: 'warn',
    no_signal: 'warn',
    clipping: 'bad',
  };
  const tone = $derived(paused ? 'quiet' : TONE[condition]);
</script>

<div class="meter-block" class:paused>
  <div class="meter-head">
    <span class="label" aria-hidden="true">Input level</span>
    <span class="status {tone}">{statusText}</span>
  </div>
  <div
    class="meter"
    role="meter"
    aria-label="Microphone input level"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent}
    aria-valuetext={paused ? 'Paused while the transcription test runs' : `${statusText}, ${percent}%`}
  >
    <div class="fill {zone}" class:some={percent > 0} style="width: {percent}%"></div>
  </div>
  <!-- Always rendered: it used to appear only for fault states, so it came and
       went as the speaker paused and resumed, reflowing everything below it
       during the one activity the panel exists for. -->
  <p class="advice">{advice}</p>
  <!-- The announcer is permanent and only its TEXT changes. Attaching
       `role="status"` at the same moment as the fault text is a region a
       screen reader may not have registered yet; an empty live region that is
       always there is one it has. Faults only — narrating every breath is the
       opposite of help. -->
  <span class="announcer" role="status">{actionable ? advice : ''}</span>
</div>

<style>
  .meter-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    container-type: inline-size;
  }

  .meter-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    min-width: 0;
  }

  /* Matches a settings row's label, so the level reads as the next row of the
     same form rather than as decoration under the picker. */
  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .status {
    flex: 0 0 auto;
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    text-align: right;
  }
  .status.quiet {
    font-weight: 500;
    color: var(--text-muted);
  }
  .status.good {
    color: var(--success);
  }
  .status.warn {
    color: var(--warning);
  }
  .status.bad {
    color: var(--danger);
  }

  /*
   * The scale has to be visible when it is empty — that is exactly when it is
   * telling somebody something. A sunken track on warm paper measured 1.16:1,
   * so silence drew no meter at all; the outline is mixed from the strong
   * border toward the faint text colour until it clears 3:1 (WCAG 1.4.11).
   */
  .meter {
    position: relative;
    height: 10px;
    border-radius: var(--radius-pill);
    background: var(--bg-sunken);
    overflow: hidden;
  }
  /* Drawn over the fill, so the whole scale is outlined rather than only the
     part nothing has reached; warm, like every other hairline here. */
  .meter::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 72%, var(--text-primary));
    pointer-events: none;
  }

  .fill {
    height: 100%;
    border-radius: var(--radius-pill);
    transition: width var(--dur-press) linear;
  }
  /* A faint signal is still a signal: never thinner than the end cap, where
     it read as part of the track rather than as a level. */
  .fill.some {
    min-width: 10px;
  }
  /* The meter tokens are tuned for a dark track; on the light one they sat
     under 3:1. Pulled toward the text colour locally rather than retuning the
     shared tokens. */
  .fill.low {
    background: color-mix(in srgb, var(--meter-low) 72%, var(--text-primary));
  }
  .fill.mid {
    background: color-mix(in srgb, var(--meter-mid) 62%, var(--text-primary));
  }
  .fill.high {
    background: var(--meter-high);
  }

  .advice {
    margin: 0;
    font-size: var(--text-label);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    /* One line, always — the height is reserved whatever the text says, so a
       longer remedy replacing a shorter reassurance cannot move the panel. */
    min-height: var(--lh-label);
  }
  /* The longest remedies run to about 500px, which is the whole column at the
     smallest window. There the line is two lines tall in every condition, so
     a fault arriving cannot push the test down by one. */
  @container (max-width: 520px) {
    .advice {
      min-height: calc(2 * var(--lh-label));
    }
  }

  /* Not an empty reading: the whole scale steps back while the test has it. */
  .paused .meter {
    opacity: 0.55;
  }
  .paused .advice {
    color: var(--text-muted);
  }

  .announcer {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }
  }
</style>
