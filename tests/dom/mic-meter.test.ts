/**
 * MicMeter — mounted, because the bug it had was invisible to every other kind
 * of test.
 *
 * The component folded each level frame with `held = reduceMicLevel(held, …)`
 * inside a `$effect`: an effect that reads and writes the same `$state`, where
 * the reducer returns a fresh object every time. Svelte 5 re-runs such an
 * effect until it settles, it never settled, and the component aborted with
 * `effect_update_depth_exceeded` on the FIRST audio frame — so the level meter
 * on Preflight's microphone section died the moment the microphone produced
 * anything. `mic-advice.ts` has a full unit suite and every one of those tests
 * passed throughout, because the reducer was never the broken part.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MicMeter from '../../src/control/components/MicMeter.svelte';
import type { AudioLevelSnapshot } from '../../src/shared/contracts';

function level(overrides: Partial<AudioLevelSnapshot> = {}): AudioLevelSnapshot {
  return {
    rms: 0.3,
    peak: 0.5,
    noiseFloor: 0.02,
    speaking: true,
    clipped: false,
    signalPresent: true,
    generatedAtMs: 1000,
    ...overrides,
  };
}

describe('MicMeter', () => {
  it('survives a level frame instead of aborting the component', () => {
    const { container } = render(MicMeter, { props: { level: level() } });
    const meter = container.querySelector('[role="meter"]');
    expect(meter, 'the meter must render at all').not.toBeNull();
    // Normalised, not raw RMS: 0.30 against this frame's own held peak of
    // 0.50, so 60. A raw percentage drew an ordinary speaking voice as a
    // sliver at the left edge, which read as "the app cannot hear me" while it
    // could hear perfectly well.
    expect(meter?.getAttribute('aria-valuenow')).toBe('60');
  });

  it('fills usefully for a quiet microphone rather than reading as dead', () => {
    // A quiet-but-working input: raw RMS 0.08 is 8% of a bar, which looks
    // broken. Normalisation is what makes the meter answer the question the
    // user is actually asking — "is it hearing me?" — instead of reporting an
    // absolute number that means nothing without a reference.
    const { container } = render(MicMeter, { props: { level: level({ rms: 0.08, peak: 0.1 }) } });
    const value = Number(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow'));
    expect(value).toBeGreaterThan(15);
  });

  it('keeps the advice line present in every condition', () => {
    /*
     * The jitter. Three of the six conditions had no advice, so the line
     * appeared when the speaker paused and vanished when they resumed, moving
     * everything below it — during the one activity the panel exists for.
     */
    const speaking = render(MicMeter, { props: { level: level() } });
    expect(speaking.container.querySelector('.advice')?.textContent?.trim()).toBeTruthy();
    speaking.unmount();

    const idle = render(MicMeter, { props: { level: null } });
    expect(idle.container.querySelector('.advice')?.textContent?.trim()).toBeTruthy();
  });

  it('survives a stream of frames, which is the only way it is ever used', async () => {
    const { container, rerender } = render(MicMeter, { props: { level: level() } });
    for (let i = 1; i <= 12; i += 1) {
      await rerender({ level: level({ generatedAtMs: 1000 + i * 90, rms: 0.2 + i * 0.02 }) });
    }
    expect(container.querySelector('[role="meter"]')).not.toBeNull();
  });

  it('renders with no frame yet', () => {
    const { container } = render(MicMeter, { props: { level: null } });
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('states the condition as text, not only as a colour', () => {
    const { container } = render(MicMeter, { props: { level: level({ clipped: true }) } });
    expect((container.textContent ?? '').length).toBeGreaterThan(0);
    expect(container.querySelector('.status')?.textContent).toBeTruthy();
  });
});
