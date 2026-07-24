/**
 * CoachingSettingsFields — the §30.1 panel, mounted against a real DOM.
 *
 * The three things worth asserting about a settings panel are things only a
 * mounted component can show:
 *
 *   1. every control reports the change UPWARD. A control that reads the store
 *      but never calls `onchange` looks perfect and saves nothing — and that is
 *      indistinguishable from a working panel in an SSR snapshot.
 *   2. §30.2's copy is on the screen verbatim, including the sentence that says
 *      Basic will miss fillers and the one that says Full precision spends the
 *      user's API key. That copy is the honest part of the trade-off; a
 *      friendlier paraphrase is a regression.
 *   3. §32.2's retention statement changes with the toggles and says where the
 *      data goes.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import CoachingSettingsFields from '../../src/control/components/CoachingSettingsFields.svelte';
import { defaultCoachingSettings } from '../../src/control/lib/coaching-profiles';
import type { CoachingSettings } from '../../src/shared/contracts';
import type { TranscriptRetention } from '../../src/control/services/settings-types';

function renderPanel(
  overrides: Partial<CoachingSettings> = {},
  props: { compact?: boolean; transcriptRetention?: TranscriptRetention } = {},
) {
  const onchange = vi.fn();
  const coaching = { ...defaultCoachingSettings(), ...overrides };
  const utils = render(CoachingSettingsFields, {
    props: {
      coaching,
      transcriptRetention: props.transcriptRetention ?? 'off',
      compact: props.compact ?? false,
      onchange,
    },
  });
  return { ...utils, onchange, coaching };
}

/** The first patch the panel reported, typed and asserted to exist. */
function firstPatch(onchange: ReturnType<typeof vi.fn>): Partial<CoachingSettings> {
  const call = onchange.mock.calls[0];
  expect(call, 'the control must report its change upward').toBeDefined();
  return call![0] as Partial<CoachingSettings>;
}

function text(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

describe('§30.1 the panel reports every change upward', () => {
  it('coaching mode saves the mode AND the module flags it implies (§6.6)', async () => {
    const { container, onchange } = renderPanel();
    const select = container.querySelector('select') as HTMLSelectElement;
    select.value = 'studio';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(onchange).toHaveBeenCalledTimes(1);
    const patch = firstPatch(onchange);
    expect(patch.mode).toBe('studio');
    // Without this the user picks Studio and the rail keeps rendering Coach.
    expect(patch.modules?.varietyScore).toBe(true);
    expect(patch.modules?.inlineGutterMarks).toBe(true);
  });

  it('custom mode keeps the stored module set rather than overwriting it', async () => {
    const { container, onchange } = renderPanel();
    const select = container.querySelector('select') as HTMLSelectElement;
    select.value = 'custom';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    expect(firstPatch(onchange)).toEqual({ mode: 'custom' });
  });

  it('a retention toggle reports the new value', async () => {
    const { getByRole, onchange } = renderPanel();
    getByRole('switch', { name: 'Keep an audio recording' }).click();
    await Promise.resolve();
    expect(onchange).toHaveBeenCalledWith({ retainAudioRecordingEnabled: true });
  });

  it('the filler scope segmented control reports the new scope', async () => {
    const { getByRole, onchange } = renderPanel();
    getByRole('radio', { name: 'Broad' }).click();
    await Promise.resolve();
    expect(onchange).toHaveBeenCalledWith({ fillerDetectionScope: 'broad' });
  });

  it('module toggles are only editable in Custom mode (§6.6)', () => {
    const named = renderPanel({ mode: 'coach' });
    expect(
      (named.getByRole('switch', { name: 'Numeric variety score' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    named.unmount();

    const custom = renderPanel({ mode: 'custom' });
    expect(
      (custom.getByRole('switch', { name: 'Numeric variety score' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('says which rail modules the mode decides, instead of silently omitting them', () => {
    // `CoachingSettings.modules` has no `deliveryScore` or `paceSparkline`
    // field, so neither can have a switch here. A panel that simply left them
    // out would leave a user hunting for a control that does not exist; the
    // panel states what governs them instead (Speaking Score report §11.1).
    const { container } = renderPanel({ mode: 'custom' });
    const body = text(container);
    expect(body).toContain('The delivery score follows the coaching mode');
    expect(body).toContain('Coach and Studio show it, Minimal and Review only do not');
    expect(body).toContain('the figure waits in the post-take report');
    expect(body).toContain('The pace sparkline is a Studio affordance');
  });

  it('turning a goal on chooses a starting threshold rather than saving zero', async () => {
    const { getByRole, onchange } = renderPanel();
    getByRole('switch', { name: 'Fewer than N fillers a minute' }).click();
    await Promise.resolve();
    const patch = firstPatch(onchange);
    expect(patch.goals?.maxFillersPerMinute).toBeGreaterThan(0);
  });

  it('the review-only goal sets the review-only MODE, not a second copy of it', async () => {
    const { getByRole, onchange } = renderPanel();
    getByRole('switch', { name: 'Review only — nothing live' }).click();
    await Promise.resolve();
    expect(onchange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'review_only' }),
    );
  });

  it('“finish within the target duration” is unavailable until a target exists', () => {
    const without = renderPanel({ targetDurationSeconds: null });
    expect(
      (
        without.getByRole('switch', {
          name: 'Finish within the target duration',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    without.unmount();

    const withTarget = renderPanel({ targetDurationSeconds: 210 });
    expect(
      (
        withTarget.getByRole('switch', {
          name: 'Finish within the target duration',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('resetting personal calibration records when it happened (§30.1)', async () => {
    const { getByText, onchange } = renderPanel();
    (getByText('Reset personal calibration') as HTMLElement).click();
    await Promise.resolve();
    const patch = firstPatch(onchange);
    expect(patch.personalCalibrationResetAtEpochMs).toBeGreaterThan(0);
  });
});

describe('§30.2 the filler-detection copy is on screen verbatim', () => {
  it('Basic says plainly that fillers may be missed', () => {
    const { container } = renderPanel({ precisionTranscriptionMode: 'off' });
    expect(text(container)).toContain(
      'Uses the live transcript and local audio cues. Fast and inexpensive, but some fillers may be missed.',
    );
  });

  it('Full precision says it spends the user’s API key', () => {
    const { container } = renderPanel({ precisionTranscriptionMode: 'full' });
    const body = text(container);
    expect(body).toContain(
      'Runs short audio segments through an additional verbatim transcription pass.',
    );
    expect(body).toContain('additional OpenAI transcription calls on your API key');
  });

  it('offers all four §29.3 cost modes, not a boolean', () => {
    const { container } = renderPanel();
    const options = Array.from(container.querySelectorAll('option')).map((o) => o.value);
    for (const mode of ['off', 'on_candidates', 'full', 'review_only']) {
      expect(options).toContain(mode);
    }
  });

  it('Strict only and Broad are both offered, with §30.2’s wording', () => {
    const strict = renderPanel({ fillerDetectionScope: 'strict' });
    expect(text(strict.container)).toContain(
      'Counts clear fillers such as “um,” “uh,” “er,” and “erm.”',
    );
    strict.unmount();

    const broad = renderPanel({ fillerDetectionScope: 'broad' });
    expect(text(broad.container)).toContain(
      'Also evaluates contextual phrases such as “you know,” “like,” and repeated sentence openers. Contextual items require higher confidence.',
    );
  });
});

describe('§32.2 the panel states exactly what is retained', () => {
  it('says nothing is kept when every consent is off', () => {
    const { container } = renderPanel({
      postTakeReportEnabled: false,
      retainAudioRecordingEnabled: false,
    });
    const body = text(container);
    expect(body).toContain('Your coaching measurements are not saved.');
    expect(body).toContain('The transcript is not saved');
    expect(body).toContain('No audio is saved.');
  });

  it('says where the audio goes when the audio consent is on', () => {
    const { container } = renderPanel({ retainAudioRecordingEnabled: true });
    const body = text(container);
    expect(body).toContain('A recording of your voice is written to this device');
    expect(body).toContain('application data folder');
  });

  it('names the transcript window when transcript retention is on', () => {
    const { container } = renderPanel({}, { transcriptRetention: '7d' });
    expect(text(container)).toContain('kept for 7d');
  });

  it('states that turning a toggle off deletes what is already saved', () => {
    const { container } = renderPanel();
    expect(text(container)).toContain(
      'Turning either of these off deletes what earlier takes already saved. It does not only stop saving from now on.',
    );
  });

  it('the audio consent is off by default (§32.1)', () => {
    const { getByRole } = renderPanel();
    expect(
      getByRole('switch', { name: 'Keep an audio recording' }).getAttribute('aria-checked'),
    ).toBe('false');
  });
});

describe('the panel does not invent limits (§30.1 custom filler words)', () => {
  it('reports the count informationally, with no maximum', () => {
    const words = Array.from({ length: 37 }, (_, i) => `word-${i}`);
    const { container } = renderPanel({ customFillerWords: words });
    const body = text(container);
    expect(body).toContain('37 words of your own');
    expect(body).not.toMatch(/37\s*\/\s*\d+/);
    expect(body).not.toMatch(/\bmax(imum)?\b/i);
  });

  it('is honest about an empty list rather than showing 0/20', () => {
    const { container } = renderPanel({ customFillerWords: [] });
    expect(text(container)).toContain('None yet.');
  });
});

describe('the Preflight (compact) variant', () => {
  it('keeps the session-relevant controls and the retention statement', () => {
    const { container } = renderPanel({}, { compact: true });
    const body = text(container);
    expect(body).toContain('Coaching mode');
    expect(body).toContain('Filler detection');
    expect(body).toContain('No audio is saved.');
  });

  it('leaves the module grid and calibration reset to the Settings screen', () => {
    const { container, queryByRole } = renderPanel({ mode: 'custom' }, { compact: true });
    expect(queryByRole('switch', { name: 'Numeric variety score' })).toBeNull();
    expect(text(container)).not.toContain('Reset personal calibration');
  });
});
