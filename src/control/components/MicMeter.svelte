<!--
  Local input level meter (spec §14.2 C) — responds before any OpenAI call.
  Zones use the dedicated meter tokens; state is also written as text (§20).
-->
<script lang="ts">
  import type { AudioLevelSnapshot } from '../../shared/contracts';

  interface Props {
    level: AudioLevelSnapshot | null;
  }

  let { level }: Props = $props();

  const percent = $derived(Math.round(Math.min(1, level?.rms ?? 0) * 100));
  const zone = $derived(
    level?.clipped ? 'high' : (level?.rms ?? 0) > 0.65 ? 'high' : (level?.rms ?? 0) > 0.35 ? 'mid' : 'low',
  );
  const statusText = $derived(
    !level
      ? 'No signal yet'
      : level.clipped
        ? 'Clipping'
        : level.speaking
          ? 'Hearing you'
          : level.signalPresent
            ? 'Quiet'
            : 'No signal',
  );
</script>

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

<style>
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
