/**
 * MicMeter interpretation (spec §14.2 C, copy from Appendix F.4).
 *
 * The meter used to render the bare word "Clipping" with no remedy. Every
 * problem state now carries the F.4 sentence that says what to do about it,
 * and the states are held long enough to be read: `clipped` is a single-frame
 * flag at ~90 ms and `speaking` drops out between words.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import MicMeter from '../../../src/control/components/MicMeter.svelte';
import {
  CLIP_HOLD_MS,
  INITIAL_MIC_ADVICE_STATE,
  MIC_ADVICE,
  MIC_STATUS_LABEL,
  micCondition,
  micZone,
  reduceMicLevel,
  type MicAdviceState,
} from '../../../src/control/components/mic-advice';
import type { AudioLevelSnapshot } from '../../../src/shared/contracts';

function frame(partial: Partial<AudioLevelSnapshot> & { generatedAtMs: number }): AudioLevelSnapshot {
  return {
    rms: 0.3,
    peak: 0.5,
    noiseFloor: 0.02,
    speaking: false,
    clipped: false,
    signalPresent: true,
    ...partial,
  };
}

/** Feed a sequence of frames and return the final held state. */
function feed(frames: AudioLevelSnapshot[]): MicAdviceState {
  return frames.reduce(
    (state, level) => reduceMicLevel(state, level, level.generatedAtMs),
    INITIAL_MIC_ADVICE_STATE,
  );
}

describe('mic conditions', () => {
  it('is idle before any frame has been measured', () => {
    expect(micCondition(null, INITIAL_MIC_ADVICE_STATE, 0)).toBe('idle');
    expect(MIC_ADVICE.idle).toBeNull();
  });

  it('reports clipping and keeps it on screen past the frame that caused it', () => {
    const clip = frame({ generatedAtMs: 1000, clipped: true, peak: 1 });
    const state = feed([clip]);
    expect(micCondition(clip, state, 1000)).toBe('clipping');

    const quiet = frame({ generatedAtMs: 1200, peak: 0.5 });
    expect(micCondition(quiet, state, 1200)).toBe('clipping');

    const later = frame({ generatedAtMs: 1000 + CLIP_HOLD_MS + 50, peak: 0.5, speaking: true });
    expect(micCondition(later, state, later.generatedAtMs)).toBe('speaking');
  });

  it('names the remedy for clipping instead of just the problem', () => {
    expect(MIC_STATUS_LABEL.clipping).toBe('Clipping');
    expect(MIC_ADVICE.clipping).toBe(
      'The signal is clipping. Reduce the microphone gain for more reliable transcription.',
    );
  });

  it('uses the F.4 sentence for a silent input', () => {
    const silent = frame({ generatedAtMs: 500, signalPresent: false, rms: 0, peak: 0 });
    const state = feed([silent]);
    expect(micCondition(silent, state, 500)).toBe('no_signal');
    expect(MIC_ADVICE.no_signal).toBe(
      'CandidCue cannot hear this microphone. Check the selected device and input level.',
    );
  });

  it('uses the F.4 sentence for an input that never gets loud enough', () => {
    const frames = [0, 90, 180, 270].map((t) =>
      frame({ generatedAtMs: t, rms: 0.05, peak: 0.06 }),
    );
    const state = feed(frames);
    expect(micCondition(frames[3]!, state, 270)).toBe('too_low');
    expect(MIC_ADVICE.too_low).toBe(
      'The signal is very quiet. Move closer or increase the microphone level.',
    );
  });

  it('does not nag about a normal gap between words', () => {
    // Loud speech, then a quiet frame: the peak hold keeps this out of
    // "too quiet" so the advice does not flash between every word.
    const loud = frame({ generatedAtMs: 0, rms: 0.4, peak: 0.7, speaking: true });
    const gap = frame({ generatedAtMs: 200, rms: 0.05, peak: 0.06 });
    const state = feed([loud, gap]);
    expect(micCondition(gap, state, 200)).toBe('quiet');
    expect(MIC_ADVICE.quiet).toBeNull();
  });

  it('lets the peak hold expire so a real drop is still caught', () => {
    const loud = frame({ generatedAtMs: 0, rms: 0.4, peak: 0.7, speaking: true });
    const muchLater = frame({ generatedAtMs: 10_000, rms: 0.05, peak: 0.06 });
    const state = feed([loud, muchLater]);
    expect(micCondition(muchLater, state, 10_000)).toBe('too_low');
  });

  it('paints the meter red while clipping regardless of rms', () => {
    expect(micZone(frame({ generatedAtMs: 0, rms: 0.1, clipped: true }), 'clipping')).toBe('high');
    expect(micZone(frame({ generatedAtMs: 0, rms: 0.1 }), 'quiet')).toBe('low');
    expect(micZone(frame({ generatedAtMs: 0, rms: 0.5 }), 'speaking')).toBe('mid');
  });
});

describe('rendered meter', () => {
  it('renders the remedy text, not only the problem word', () => {
    const html = render(MicMeter, {
      props: { level: frame({ generatedAtMs: 1000, clipped: true, peak: 1 }) },
    }).body;
    expect(html).toContain('Clipping');
    expect(html).toContain('Reduce the microphone gain');
    expect(html).toContain('role="status"');
  });

  it('stays quiet when there is nothing to act on', () => {
    const html = render(MicMeter, { props: { level: null } }).body;
    expect(html).toContain('No signal yet');
    expect(html).not.toContain('role="status"');
  });
});
