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

/**
 * The text of every live region in server-rendered markup — anything a screen
 * reader would speak when it changes: `role="status" | "alert" | "log"` or an
 * explicit `aria-live` other than "off". Svelte's hydration comments and any
 * nested tags are dropped, so an empty region reads as ''.
 */
function liveRegionTexts(html: string): string[] {
  const regions = html.matchAll(
    /<(\w+)\b[^>]*\b(?:role="(?:status|alert|log)"|aria-live="(?:polite|assertive)")[^>]*>([\s\S]*?)<\/\1>/g,
  );
  return [...regions].map((m) =>
    (m[2] ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim(),
  );
}

/** No live region may carry text. Present-but-empty is fine; speaking is not. */
function expectNothingAnnounced(html: string): void {
  for (const text of liveRegionTexts(html)) {
    expect(text, 'a live region carries text for a meter with nothing to act on').toBe('');
  }
}

/** Feed a sequence of frames and return the final held state. */
function feed(frames: AudioLevelSnapshot[]): MicAdviceState {
  return frames.reduce(
    (state, level) => reduceMicLevel(state, level, level.generatedAtMs),
    INITIAL_MIC_ADVICE_STATE,
  );
}

describe('mic conditions', () => {
  it('is idle before any frame has been measured, and still says so', () => {
    expect(micCondition(null, INITIAL_MIC_ADVICE_STATE, 0)).toBe('idle');
    // Every condition carries a line now, healthy ones included. Three of the
    // six were null, so the line existed only while something was wrong: it
    // appeared when the speaker paused, vanished when they resumed, and moved
    // the panel each way. Speaking into a microphone to test it is exactly
    // when the level changes most, so the only time it flickered was the only
    // time anyone was watching.
    expect(MIC_ADVICE.idle).toBeTruthy();
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
      'Speaking Glass cannot hear this microphone. Check the selected device and input level.',
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
    expect(MIC_ADVICE.quiet).toBeTruthy();
  });

  it('does not call a pause between sentences a broken microphone', () => {
    /*
     * The complaint, exactly: "as soon as the volume goes down it says it
     * can't hear you — what am I meant to be, making a sound all the time?"
     *
     * `signalPresent` is a ~90 ms reading and goes false in the gap between
     * two words, and `no_signal` was returned from that single frame. So the
     * meter accused the microphone of being unusable every time the speaker
     * drew breath, and took it back a moment later.
     */
    const speech = frame({ generatedAtMs: 0, rms: 0.4, peak: 0.7, speaking: true });
    const pause = frame({ generatedAtMs: 800, rms: 0, peak: 0, signalPresent: false });
    const state = feed([speech, pause]);
    expect(micCondition(pause, state, 800)).toBe('quiet');
  });

  it('still reports a genuinely dead input once the silence lasts', () => {
    // Tolerance must not become silence: an input that really is gone has to
    // be named, or the user hunts for a fault the app already knows about.
    const speech = frame({ generatedAtMs: 0, rms: 0.4, peak: 0.7, speaking: true });
    const gone = frame({ generatedAtMs: 6000, rms: 0, peak: 0, signalPresent: false });
    const state = feed([speech, gone]);
    expect(micCondition(gone, state, 6000)).toBe('no_signal');
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

  it('shows a line when there is nothing to act on, but does not announce it', () => {
    /*
     * Both halves matter and they used to be one decision. The line is always
     * visible, so the panel cannot jitter; and a screen reader is not made to
     * narrate every breath the speaker takes.
     *
     * The live region is now mounted permanently — a region created at the
     * same moment as its text is the case assistive technology is least
     * reliable about — so "not announced" means what it always meant at the
     * listener's end: no live region carries any text. Checked for the idle
     * meter AND for a healthy one, since a speaking frame is the condition that
     * arrives ~11 times a second.
     */
    const idle = render(MicMeter, { props: { level: null } }).body;
    expect(idle).toContain('No signal yet');
    expect(idle).toContain('Say a few words');
    expectNothingAnnounced(idle);

    const healthy = render(MicMeter, {
      props: { level: frame({ generatedAtMs: 1000, rms: 0.3, peak: 0.5, speaking: true }) },
    }).body;
    expect(healthy).toContain('Hearing you');
    expect(healthy).toContain(MIC_ADVICE.speaking);
    expectNothingAnnounced(healthy);

    // And the visible line itself is never the live region, so its text can
    // change without being read out.
    expect(idle).not.toMatch(/<p class="advice[^"]*"[^>]*\b(?:role|aria-live)=/);
  });

  it('announces the remedy itself when there is something to act on', () => {
    // The other half of the same decision: the persistent region is not just
    // present for a fault, it carries the remedy text.
    const html = render(MicMeter, {
      props: { level: frame({ generatedAtMs: 1000, clipped: true, peak: 1 }) },
    }).body;
    expect(liveRegionTexts(html)).toContain(MIC_ADVICE.clipping);
  });
});
