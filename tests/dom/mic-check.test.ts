/**
 * §29.2 — the microphone check as the presenter actually sees it.
 *
 * The decision is tested elsewhere (services/audio/mic-check.test.ts) and the
 * lifecycle in tests/unit/control/preflight-mic-check.test.ts. What is left is
 * the part those two cannot reach: whether the thing on the glass says what
 * control decided.
 *
 * This overlay covers a hydrated script on a full-screen window moments before
 * a take. The failure that matters is not "it looked wrong" — it is a check
 * that renders a stale or partial view and lets somebody start on a microphone
 * that was never heard, or blocks somebody whose microphone is fine.
 *
 * Assertions are plain DOM reads: this project deliberately does not extend
 * `expect` with jest-dom (see tests/dom/setup.ts).
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MicCheck from '../../src/stage/MicCheck.svelte';
import { MIC_CHECK_COPY } from '../../src/control/services/audio/mic-check';
import {
  STAGE_MIC_CHECK_TRACE_SAMPLES,
  type StageMicCheckPayload,
  type StageMicCheckState,
} from '../../src/shared/contracts';

function payload(overrides: Partial<StageMicCheckPayload> = {}): StageMicCheckPayload {
  const state: StageMicCheckState = overrides.state ?? 'waiting';
  const copy = MIC_CHECK_COPY[state];
  return {
    stageGeneration: 3,
    active: true,
    state,
    levels: [],
    headline: copy.headline,
    detail: copy.detail,
    canOverride: false,
    sentAtMs: 1000,
    ...overrides,
  };
}

function mount(overrides: Partial<StageMicCheckPayload> = {}, fontFamilyId = 'system-sans') {
  return render(MicCheck, { props: { check: payload(overrides), fontFamilyId } });
}

function bars(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.bar'));
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('what the presenter is told', () => {
  it('asks for a voice before anything has been heard', () => {
    const { container } = mount({ state: 'waiting' });
    expect(text(container)).toMatch(/say something/i);
  });

  it('renders the headline control sent, not one it decided for itself', () => {
    /*
     * The stage holds no thresholds. If it ever derived copy from `state` on
     * its own, the words on the glass could disagree with the decision that
     * gates the take — and the glass is the only one the presenter can see.
     */
    const { container } = mount({
      state: 'unheard',
      headline: 'Something specific control said',
    });
    expect(text(container)).toContain('Something specific control said');
  });

  it('shows the detail line control sent', () => {
    // Independently authored text, not `MIC_CHECK_COPY[state].detail` — building
    // the payload from the same constant it is then compared against asserts
    // nothing about the component at all.
    const { container } = mount({ state: 'too_low', detail: 'Move nearer the microphone.' });
    expect(text(container)).toContain('Move nearer the microphone.');
  });

  it('gives every state distinct copy', () => {
    // The copy table is the whole vocabulary of this screen; two states sharing
    // a line would leave the presenter unable to tell them apart.
    const headlines = Object.values(MIC_CHECK_COPY).map((copy) => copy.headline);
    expect(new Set(headlines).size).toBe(headlines.length);
  });

  it('follows the check as it changes, rather than freezing on first paint', async () => {
    /*
     * The one behaviour that matters most and the one a static mount cannot
     * see: this overlay is driven by a stream of payloads at ~10 Hz, and a
     * component that rendered its first and ignored the rest would look
     * completely correct in every single-mount test while showing the presenter
     * a frozen screen.
     */
    const { container, rerender } = render(MicCheck, {
      props: { check: payload({ state: 'waiting' }), fontFamilyId: 'system-sans' },
    });
    expect(text(container)).toMatch(/say something/i);

    await rerender({ check: payload({ state: 'unheard' }), fontFamilyId: 'system-sans' });
    expect(text(container)).toContain(MIC_CHECK_COPY.unheard.headline);
    expect(container.querySelector('.mic-check')?.getAttribute('data-tone')).toBe('warn');

    await rerender({ check: payload({ state: 'passed' }), fontFamilyId: 'system-sans' });
    expect(text(container)).toContain(MIC_CHECK_COPY.passed.headline);
    expect(container.querySelector('.mic-check')?.getAttribute('data-tone')).toBe('good');
  });

  it('reveals "start anyway" when a later payload offers it', async () => {
    // `canOverride` flips mid-check, four seconds in. A frozen component would
    // never show the affordance at all.
    const { container, rerender } = render(MicCheck, {
      props: { check: payload({ canOverride: false }), fontFamilyId: 'system-sans' },
    });
    expect(text(container)).not.toMatch(/start anyway/i);

    await rerender({ check: payload({ canOverride: true }), fontFamilyId: 'system-sans' });
    expect(text(container)).toMatch(/start anyway/i);
  });

  it('announces changes without stealing focus', () => {
    // The stage window has no focus to give, and the headline changes as the
    // check learns things — so it has to be a live region, not a dialog.
    const { container } = mount();
    const root = container.querySelector('.mic-check');
    expect(root?.getAttribute('role')).toBe('status');
    expect(root?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('the waveform', () => {
  it('always draws exactly the traced sample count', () => {
    /*
     * Padded from the left rather than stretched to fit. A trace that rescaled
     * as samples accumulated would read as the level changing when it had not,
     * on the one screen whose entire job is to report the level honestly.
     *
     * Asserted against the shared wire constant, so a producer and a renderer
     * that drifted apart is a failure here rather than a silently rescaling
     * waveform in front of a presenter.
     */
    expect(bars(mount({ levels: [] }).container)).toHaveLength(STAGE_MIC_CHECK_TRACE_SAMPLES);
    expect(bars(mount({ levels: [0.5, 0.6] }).container)).toHaveLength(
      STAGE_MIC_CHECK_TRACE_SAMPLES,
    );
    expect(
      bars(mount({ levels: new Array<number>(200).fill(0.5) }).container),
    ).toHaveLength(STAGE_MIC_CHECK_TRACE_SAMPLES);
  });

  it('pads new samples in from the right, oldest first', () => {
    // Order is the whole readability of a waveform: newest at the right, with
    // the empty history to its left, exactly as the trace accumulates.
    const { container } = mount({ levels: [0.25, 1] });
    const heights = bars(container).map((bar) => parseFloat(bar.style.height));
    const leading = heights.slice(0, STAGE_MIC_CHECK_TRACE_SAMPLES - 2);
    expect(new Set(leading).size).toBe(1);
    expect(heights.at(-1)).toBeGreaterThan(heights.at(-2) ?? 0);
  });

  it('keeps a visible baseline while silent', () => {
    // A row of zero-height bars is indistinguishable from a component that
    // failed to render — at the exact moment the presenter needs to believe
    // the app is listening.
    const { container } = mount({ levels: [0, 0, 0] });
    for (const bar of bars(container)) {
      expect(parseFloat(bar.style.height)).toBeGreaterThan(0);
    }
  });

  it('grows with the level', () => {
    const { container } = mount({ levels: [0.1, 1] });
    const drawn = bars(container);
    const quiet = parseFloat(drawn.at(-2)?.style.height ?? '0');
    const loud = parseFloat(drawn.at(-1)?.style.height ?? '0');
    expect(loud).toBeGreaterThan(quiet);
  });

  it('is not announced — the words already carry it', () => {
    const { container } = mount({ levels: [0.4] });
    expect(container.querySelector('.wave')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the keys', () => {
  it('offers cancel from the start', () => {
    // A presenter must always be able to get off a full-screen stage.
    const { container } = mount({ canOverride: false });
    expect(text(container)).toContain('Esc');
  });

  it('hides "start anyway" until control says it is available', () => {
    const { container } = mount({ canOverride: false });
    expect(text(container)).not.toMatch(/start anyway/i);
  });

  it('shows "start anyway" once control offers it', () => {
    const { container } = mount({ canOverride: true });
    expect(text(container)).toMatch(/start anyway/i);
    expect(text(container)).toContain('Enter');
  });
});

describe('looking like the teleprompter', () => {
  it('uses the session typeface rather than a face of its own', () => {
    // It is the last thing seen before the script and has to read as the same
    // surface, not as a dialog that landed on one.
    const { container } = mount({}, 'serif');
    const inner = container.querySelector('.inner') as HTMLElement | null;
    expect(inner?.style.fontFamily).toContain('Iowan Old Style');
  });

  it('marks a fault so it reads differently from an ordinary state', () => {
    const warn = mount({ state: 'unheard' });
    const good = mount({ state: 'passed' });
    expect(warn.container.querySelector('.mic-check')?.getAttribute('data-tone')).toBe('warn');
    expect(good.container.querySelector('.mic-check')?.getAttribute('data-tone')).toBe('good');
  });
});
