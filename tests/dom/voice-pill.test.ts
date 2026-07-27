/**
 * VoicePill — mounted, because everything interesting about it is what it does
 * to a screen the presenter is reading from.
 *
 * The two properties worth a DOM test:
 *
 *   • it fades rather than unmounts. A pill that was removed and re-added would
 *     pop back into existence at full opacity in the corner of a live script,
 *     which is the one kind of movement the stage is supposed to be free of;
 *   • the trace is padded, not stretched. A waveform that rescaled as samples
 *     accumulated would read as the level changing when it had not — on the one
 *     element whose entire job is reporting a level honestly.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import VoicePill from '../../src/stage/VoicePill.svelte';
import {
  STAGE_VOICE_PILL_TRACE_SAMPLES,
  type StageVoicePillPayload,
} from '../../src/shared/contracts';

function pill(overrides: Partial<StageVoicePillPayload> = {}): StageVoicePillPayload {
  return {
    stageGeneration: 3,
    reading: 'listening',
    levels: [],
    label: 'Listening',
    visible: true,
    sentAtMs: 1000,
    ...overrides,
  };
}

function root(container: Element): HTMLElement {
  const el = container.querySelector('.voice-pill');
  if (!(el instanceof HTMLElement)) throw new Error('the pill did not render');
  return el;
}

describe('VoicePill', () => {
  it('draws a full bar count before a single sample has arrived', () => {
    /*
     * Padded from the left so the trace grows INTO the pill from the right. A
     * component that rendered one bar per sample would start as a single stripe
     * and widen, which is motion the presenter has to interpret.
     */
    const { container } = render(VoicePill, { props: { pill: pill() } });
    expect(container.querySelectorAll('.bar')).toHaveLength(STAGE_VOICE_PILL_TRACE_SAMPLES);
  });

  it('keeps the newest sample at the right edge', () => {
    const levels = [0.1, 0.9];
    const { container } = render(VoicePill, { props: { pill: pill({ levels }) } });
    const bars = [...container.querySelectorAll('.bar')] as HTMLElement[];
    expect(bars).toHaveLength(STAGE_VOICE_PILL_TRACE_SAMPLES);
    expect(bars.at(-1)?.style.height).toBe('90%');
    // And the oldest padding is a visible baseline rather than nothing, so a
    // silent input reads as "listening and hearing nothing" instead of as a
    // component that failed to render.
    expect(bars[0]?.style.height).toBe('8%');
  });

  it('stays mounted when it is told to go away, and only fades', () => {
    const { container } = render(VoicePill, { props: { pill: pill({ visible: false }) } });
    expect(root(container).dataset.visible).toBe('false');
    expect(container.querySelectorAll('.bar').length).toBeGreaterThan(0);
  });

  it('says what it is reporting in words, not only in colour (§20)', () => {
    const listening = render(VoicePill, { props: { pill: pill() } });
    expect(root(listening.container).getAttribute('aria-label')).toBe('Listening');

    const confirmed = render(VoicePill, {
      props: { pill: pill({ reading: 'confirmed', label: 'Hearing you' }) },
    });
    expect(root(confirmed.container).dataset.reading).toBe('confirmed');
    expect(root(confirmed.container).getAttribute('aria-label')).toBe('Hearing you');

    /*
     * A fault is the one state that spends screen space on its text: colour
     * alone cannot be acted on, and a presenter who cannot name the problem
     * cannot fix it between sentences.
     */
    const faulted = render(VoicePill, {
      props: { pill: pill({ reading: 'fault', label: 'No audio' }) },
    });
    expect(faulted.container.querySelector('.label')?.textContent).toBe('No audio');
    // ...and the healthy states do not, so the pill stays a pill.
    expect(listening.container.querySelector('.label')).toBeNull();
    expect(confirmed.container.querySelector('.label')).toBeNull();
  });

  it('announces changes without stealing focus from a window that has none', () => {
    const { container } = render(VoicePill, { props: { pill: pill() } });
    expect(root(container).getAttribute('role')).toBe('status');
    expect(root(container).getAttribute('aria-live')).toBe('polite');
    // The waveform is the same fact as the label, drawn. Announcing two dozen
    // bars would be noise.
    expect(container.querySelector('.wave')?.getAttribute('aria-hidden')).toBe('true');
  });
});
