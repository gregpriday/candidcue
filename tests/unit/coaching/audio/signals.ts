/**
 * Synthetic signals for the coaching audio tests.
 *
 * Every generator here has an answer that is known *independently of the
 * implementation under test*: a sine's f0 is its argument, a noise generator's
 * RMS is its argument, and a speech envelope's boundaries are the times the
 * caller placed them. Tests assert those known values, so an analyzer that
 * returned a constant — or was deleted — would fail rather than pass.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

/** Deterministic PRNG: no `Math.random`, so a failure always reproduces. */
export function makeRandom(seed = 1): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export function sine(
  frequencyHz: number,
  amplitude: number,
  sampleRate: number,
  count: number,
  startSample = 0,
  out = new Float32Array(count),
): Float32Array {
  const step = (2 * Math.PI * frequencyHz) / sampleRate;
  for (let i = 0; i < count; i += 1) {
    out[i] = amplitude * Math.sin(step * (startSample + i));
  }
  return out;
}

/**
 * Glottal-ish voiced signal: a harmonic stack on `f0` with 1/n amplitude decay,
 * scaled so the result has exactly `targetRms`. Periodic by construction, so
 * its true f0 is `f0Hz` no matter how many harmonics are present.
 */
export function voicedTone(
  f0Hz: number,
  targetRms: number,
  sampleRate: number,
  count: number,
  startSample = 0,
  harmonics = 8,
  out = new Float32Array(count),
): Float32Array {
  out.fill(0);
  for (let h = 1; h <= harmonics; h += 1) {
    const frequency = f0Hz * h;
    if (frequency >= sampleRate / 2) break;
    const step = (2 * Math.PI * frequency) / sampleRate;
    const gain = 1 / h;
    for (let i = 0; i < count; i += 1) {
      out[i] = (out[i] as number) + gain * Math.sin(step * (startSample + i));
    }
  }
  return scaleToRms(out, targetRms);
}

/** White noise with exactly `targetRms` RMS (measured, then scaled). */
export function whiteNoise(
  targetRms: number,
  count: number,
  random: () => number,
  out = new Float32Array(count),
): Float32Array {
  for (let i = 0; i < count; i += 1) out[i] = random() * 2 - 1;
  return scaleToRms(out, targetRms);
}

/** Rescale in place so the buffer's RMS is exactly `targetRms`. */
export function scaleToRms(buffer: Float32Array, targetRms: number): Float32Array {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i] as number;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / Math.max(buffer.length, 1));
  if (rms === 0) return buffer;
  const gain = targetRms / rms;
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = (buffer[i] as number) * gain;
  return buffer;
}

export interface SpeechSegment {
  startMs: number;
  endMs: number;
  /** Defaults to 150 Hz. */
  f0Hz?: number;
  /** Defaults to 0.1 (≈ -20 dBFS). */
  rms?: number;
}

/**
 * A full take: continuous background noise at `noiseRms`, with voiced segments
 * layered on top at the exact millisecond boundaries given. The VAD's correct
 * answer is therefore fixed by the caller, not by the analyzer.
 */
export function speechTimeline(options: {
  sampleRate: number;
  durationMs: number;
  noiseRms: number;
  segments: SpeechSegment[];
  seed?: number;
}): Float32Array {
  const { sampleRate, durationMs, noiseRms, segments } = options;
  const count = Math.round((durationMs / 1000) * sampleRate);
  const random = makeRandom(options.seed ?? 7);
  const out = whiteNoise(noiseRms, count, random);
  for (const segment of segments) {
    const start = Math.round((segment.startMs / 1000) * sampleRate);
    const end = Math.round((segment.endMs / 1000) * sampleRate);
    const length = end - start;
    if (length <= 0) continue;
    const voiced = voicedTone(segment.f0Hz ?? 150, segment.rms ?? 0.1, sampleRate, length, start);
    // 5 ms raised-cosine edges: an instantaneous onset is not something a
    // microphone ever sees, and it would let a broken VAD pass on a click.
    const edge = Math.min(Math.round(sampleRate * 0.005), Math.floor(length / 2));
    for (let i = 0; i < length; i += 1) {
      let gain = 1;
      if (i < edge) gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / edge);
      else if (i >= length - edge) gain = 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - i)) / edge);
      const index = start + i;
      out[index] = (out[index] as number) + (voiced[i] as number) * gain;
    }
  }
  return out;
}
