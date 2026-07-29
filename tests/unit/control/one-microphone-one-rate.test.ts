/**
 * The two taps on one microphone must agree about the sample rate.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * CandidCue attaches two `MediaStreamAudioSourceNode`s to one `MediaStream`:
 * `PcmCapture`, which encodes what xAI transcribes, and the analyser graph
 * behind the level meter and the §28.6 dead-input detector. Each built its own
 * `AudioContext` — the capture at `STT_SAMPLE_RATE_HZ`, the analyser at
 * whatever the hardware defaulted to.
 *
 * Two source nodes on one stream, across contexts at DIFFERENT rates, is the
 * WebKit case where one of them quietly delivers nothing. On a RODE NT-USB Mini
 * (48 kHz) it was the analyser that lost, and the Settings screen printed the
 * contradiction one line above the other:
 *
 *     No signal — CandidCue cannot hear this microphone.
 *     Transcription is working.   "This is a test of the transcription."
 *
 * That silence reached the dead-input detector, which held following for the
 * whole take. The stage heard, transcribed, aligned and moved the document
 * ~315px, then stopped, with every instrument reporting health.
 *
 * This pins the rates together at the source level. It cannot prove WebKit's
 * behaviour from node, which is the honest limit of a unit test here — what it
 * can do is fail the moment somebody reintroduces the mismatch, which is how
 * it arrived.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('one microphone, one sample rate', () => {
  it('builds the analyser context at the capture rate', () => {
    const meter = read('src/control/services/audio/levelMeter.ts');
    expect(
      meter,
      'the analyser must pin its context to STT_SAMPLE_RATE_HZ, not the hardware default',
    ).toMatch(/new AudioContext\(\{\s*sampleRate:\s*STT_SAMPLE_RATE_HZ\s*\}\)/);
  });

  it('never builds a bare default-rate context as the primary path', () => {
    const meter = read('src/control/services/audio/levelMeter.ts');
    /*
     * A bare `new AudioContext()` is allowed exactly once, inside the catch
     * that covers an engine refusing the explicit rate — losing the meter
     * entirely would be worse than the mismatch. More than one means the
     * primary path has drifted back to the hardware default.
     */
    const bare = meter.match(/new AudioContext\(\)/g) ?? [];
    expect(bare.length, 'only the refused-rate fallback may use a bare context').toBeLessThanOrEqual(
      1,
    );
  });

  it('keeps the capture on the rate it tells xAI it is sending', () => {
    const capture = read('src/control/services/audio/capture.ts');
    expect(capture).toMatch(/new AudioContext\(\{\s*sampleRate:\s*rate\s*\}\)/);
    expect(capture).toMatch(/create\(STT_SAMPLE_RATE_HZ\)/);
  });

  it('keeps the PCM tap authoritative about whether the input is dead', () => {
    /*
     * The other half of the same fix. Whatever the analyser believes, a frame
     * on its way to the recogniser is evidence the device is producing audio —
     * so it must veto the dead-input hold rather than the reverse.
     */
    const session = read('src/control/services/voice-session.ts');
    expect(session).toMatch(/frameHasSignal\(samples\)/);
    expect(session, 'the dead-input hold must be vetoed by the PCM tap').toMatch(
      /if \(code && this\.pcmHeardRecently\(\)\)/,
    );
  });
});
