/**
 * CalibrationPreview — §30.3, and the two things it must never do.
 *
 * Mounted rather than reasoned about, because "does not display a decibel
 * figure" and "does not display a variety score it has no evidence for" are
 * claims about rendered text. A pure-function test of the helpers can prove the
 * helpers return `null`; only the component can prove that the `null` is
 * rendered as a sentence rather than as `0`, `—`, or `NaN`.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CalibrationPreview from '../../src/control/components/CalibrationPreview.svelte';
import { defaultCoachingSettings } from '../../src/control/lib/coaching-profiles';
import type { AudioLevelSnapshot, CoachingSettings } from '../../src/shared/contracts';

function level(overrides: Partial<AudioLevelSnapshot> = {}): AudioLevelSnapshot {
  return {
    rms: 0.32,
    peak: 0.5,
    noiseFloor: 0.01,
    speaking: true,
    clipped: false,
    signalPresent: true,
    generatedAtMs: 1000,
    ...overrides,
  };
}

function renderPreview(props: Partial<Record<string, unknown>> = {}) {
  const coaching: CoachingSettings = {
    ...defaultCoachingSettings(),
    ...((props.coaching as Partial<CoachingSettings>) ?? {}),
  };
  return render(CalibrationPreview, {
    props: { level: level(), transcript: '', ...props, coaching },
  });
}

function text(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

describe('§12.7.4 — the preview never claims an absolute loudness', () => {
  it('renders no decibel or SPL figure anywhere', () => {
    const { container } = renderPreview({ level: level({ rms: 0.9 }) });
    const body = text(container);
    expect(body).not.toMatch(/\d\s*dB/i);
    expect(body).not.toMatch(/\bdBFS\b/i);
    expect(body).not.toMatch(/\bSPL\b/i);
  });

  it('says out loud that the level it shows is relative', () => {
    const { container } = renderPreview();
    expect(text(container)).toContain(
      'CandidCue has no way to measure how loud the room actually is',
    );
  });

  it('still exposes the level as a meter with a percentage, which is relative', () => {
    const { container } = renderPreview();
    const meter = container.querySelector('[role="meter"]');
    expect(meter?.getAttribute('aria-valuemax')).toBe('100');
  });
});

describe('§17.5 — nothing is shown that has not been measured', () => {
  it('reports pitch confidence as not measured when no source is wired', () => {
    const { container } = renderPreview();
    const body = text(container);
    expect(body).toContain('Not measured here');
    expect(body).toContain('it needs the pitch analyzer');
  });

  it('shows no variety number without a pitch source, and does not show a zero', () => {
    const { container } = renderPreview();
    const body = text(container);
    expect(body).toContain('Not enough evidence');
    expect(body).not.toMatch(/Vocal variety\s*0 of 100/);
  });

  it('still refuses a variety number when a wired pitch source is unsure', () => {
    const { container } = renderPreview({ pitchConfidence: 0.1, varietyScore: 62 });
    const body = text(container);
    expect(body).toContain('Too low to score variety');
    expect(body).toContain('Not enough evidence');
    expect(body).not.toContain('62 of 100');
  });

  it('shows the variety number once there is confidence AND a reading', () => {
    const { container } = renderPreview({ pitchConfidence: 0.8, varietyScore: 62 });
    expect(text(container)).toContain('62 of 100');
  });

  it('asks for more of a read rather than showing a pace it cannot support', () => {
    const { container } = renderPreview({ transcript: 'a few words only' });
    const body = text(container);
    expect(body).toContain('Not enough yet');
    expect(body).toContain('Keep reading');
    expect(body).not.toMatch(/\bNaN\b/);
    expect(body).not.toMatch(/Sample pace\s*0 wpm/);
  });
});

describe('§30.3 the example rail reflects the configuration', () => {
  it('is labelled as an example, not as a measurement of this test', () => {
    const { container } = renderPreview();
    const body = text(container);
    expect(body).toContain('Example');
    expect(body).toContain('not a measurement of this test');
  });

  it('shows the modules the chosen mode turns on', () => {
    const studio = renderPreview({
      coaching: {
        ...defaultCoachingSettings(),
        mode: 'studio',
        modules: {
          paceNumber: true,
          paceStatus: true,
          targetDurationStatus: false,
          varietyScore: true,
          fillerCount: true,
          fillerRibbon: true,
          inlineGutterMarks: true,
          liveTips: true,
        },
      },
    });
    expect(text(studio.container)).toContain('Variety 61');
    studio.unmount();

    const minimal = renderPreview({
      coaching: {
        ...defaultCoachingSettings(),
        mode: 'minimal',
        modules: {
          paceNumber: true,
          paceStatus: true,
          targetDurationStatus: false,
          varietyScore: false,
          fillerCount: false,
          fillerRibbon: false,
          inlineGutterMarks: false,
          liveTips: false,
        },
      },
    });
    const body = text(minimal.container);
    expect(body).toContain('142 wpm');
    expect(body).not.toContain('Variety 61');
    expect(body).not.toContain('2 fillers');
  });

  it('says the rail is off rather than drawing an empty one', () => {
    const { container } = renderPreview({
      coaching: { ...defaultCoachingSettings(), mode: 'off' },
    });
    expect(text(container)).toContain('The rail is off.');
  });
});
