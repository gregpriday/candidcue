/**
 * When the two microphone taps disagree, the one feeding the recogniser wins.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * CandidCue taps one microphone twice. `PcmCapture` encodes the frames the
 * recogniser actually transcribes. A separate `MicrophoneMonitor` — an
 * AnalyserNode graph —
 * drives the level meter and the §28.6 dead-input detector.
 *
 * On a RODE NT-USB Mini under macOS those two disagree completely: the analyser
 * reports pure silence while the PCM tap carries perfectly transcribable
 * speech. The Settings screen shows both answers at once, one above the other:
 *
 *     No signal — CandidCue cannot hear this microphone.
 *     Transcription is working.       "This is a test of the transcription."
 *
 * In Settings that costs nothing, because the transcription test reads the PCM
 * tap. In a take it cost everything: the analyser's verdict reached
 * `setFollowingHold(true)`, following was held for the whole session, and the
 * script never moved — while the take heard the presenter, transcribed them,
 * confirmed nine words against the script and reported every one of those
 * numbers as healthy.
 *
 * The rule now: a dead input is a real fault worth holding for, but only the
 * tap that feeds the recogniser may declare it. If bytes are on their way to
 * the decoder, the input is not dead, whatever the analyser believes.
 */
import { describe, expect, it } from 'vitest';
import { frameHasSignal } from '../../../src/control/services/audio/levelMeter';

/** A frame of the literal zeros a dead capture path produces. */
function deadFrame(length = 480): Float32Array {
  return new Float32Array(length);
}

/**
 * A frame from a REAL microphone in a silent room.
 *
 * The distinction this test turns on: analog silence is not digital silence. A
 * converter with nothing in front of it still emits thermal noise and a dither
 * floor, so a quiet room has to read as a WORKING microphone — otherwise every
 * pause between sentences would look like an unplugged device.
 */
function quietRoomFrame(length = 480): Float32Array {
  const frame = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    // ~ -70 dBFS, alternating so it cannot be mistaken for a DC offset.
    frame[i] = (i % 2 === 0 ? 1 : -1) * 3e-4;
  }
  return frame;
}

/** Speech. */
function speechFrame(length = 480): Float32Array {
  const frame = new Float32Array(length);
  for (let i = 0; i < length; i += 1) frame[i] = Math.sin(i / 8) * 0.25;
  return frame;
}

describe('frameHasSignal — is this device producing audio at all', () => {
  it('rejects the literal zeros of a dead capture path', () => {
    expect(frameHasSignal(deadFrame())).toBe(false);
  });

  it('accepts a real microphone in a silent room', () => {
    /*
     * The false positive that would matter most. A presenter pausing between
     * paragraphs must not read as a device that has stopped working, or the
     * hold this feeds would fire in the middle of every take.
     */
    expect(frameHasSignal(quietRoomFrame())).toBe(true);
  });

  it('accepts speech', () => {
    expect(frameHasSignal(speechFrame())).toBe(true);
  });

  it('accepts a frame whose signal arrives late in the buffer', () => {
    // Onsets land mid-frame; scanning must not stop at the first quiet samples.
    const frame = deadFrame();
    frame[frame.length - 1] = 0.4;
    expect(frameHasSignal(frame)).toBe(true);
  });

  it('is unmoved by a single sample at the noise floor', () => {
    // The floor is a floor, not a hair trigger: one sample AT it is not signal.
    const frame = deadFrame();
    frame[10] = 1e-5;
    expect(frameHasSignal(frame)).toBe(false);
  });

  it('handles an empty frame without claiming signal', () => {
    expect(frameHasSignal(new Float32Array(0))).toBe(false);
  });
});
