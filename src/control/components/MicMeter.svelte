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
    micCondition,
    micFillPercent,
    micZone,
    reduceMicLevel,
    type MicAdviceState,
  } from './mic-advice';

  interface Props {
    level: AudioLevelSnapshot | null;
  }

  let { level }: Props = $props();

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
  $effect(() => {
    const frame = level;
    if (!frame) return;
    if (frame.generatedAtMs === lastFrameAtMs) return;
    lastFrameAtMs = frame.generatedAtMs;
    accumulator = reduceMicLevel(accumulator, frame, frame.generatedAtMs);
    held = accumulator;
  });

  // Normalised against the held peak, so an ordinary voice fills an ordinary
  // amount of bar instead of a sliver at the left edge (see mic-advice.ts).
  const percent = $derived(micFillPercent(level, held));
  const condition = $derived(micCondition(level, held, level?.generatedAtMs ?? 0));
  const zone = $derived(micZone(level, condition));
  const statusText = $derived(MIC_STATUS_LABEL[condition]);
  const advice = $derived(MIC_ADVICE[condition]);
  /** Conditions the operator can actually do something about (Appendix F.4). */
  const actionable = $derived(
    condition === 'clipping' || condition === 'no_signal' || condition === 'too_low',
  );
</script>

<div class="meter-block">
  <div class="meter-row">
    <div
      class="meter"
      role="meter"
      aria-label="Microphone input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div class="fill {zone}" style="width: {percent}%"></div>
    </div>
    <span class="status">{statusText}</span>
  </div>
  <!-- Always rendered, but only announced when it is actionable.
       It used to appear only for fault states, so it came and went as the
       speaker paused and resumed, reflowing everything below it during the one
       activity the panel exists for. Making it permanent fixes that; leaving it
       a live region permanently would trade the flicker for a screen reader
       narrating every breath, so the role is attached to the fault states that
       have something to act on. -->
  <p class="advice" role={actionable ? 'status' : undefined}>{advice}</p>
</div>

<style>
  .meter-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
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

  .meter-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .meter {
    flex: 1 1 auto;
    height: 8px;
    border-radius: var(--radius-pill);
    background: var(--bg-sunken);
    border: 1px solid var(--border-faint);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: var(--radius-pill);
    transition: width 90ms linear;
  }
  .fill.low {
    background: var(--meter-low);
  }
  .fill.mid {
    background: var(--meter-mid);
  }
  .fill.high {
    background: var(--meter-high);
  }

  .status {
    flex: 0 0 auto;
    min-width: 84px;
    font-size: var(--text-meta);
    color: var(--text-muted);
    text-align: right;
  }
</style>
