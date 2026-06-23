/**
 * Minimal WAV helpers for 16-bit little-endian PCM (spec §17).
 *
 * Inworld TTS returns either raw PCM (`pcm_s16le`) or a fully-formed WAV. When we
 * receive raw PCM we wrap it in a canonical 44-byte RIFF/WAVE header so the
 * renderer can decode and play it through a standard <audio>/Web Audio path.
 * Duration is derived deterministically from the sample-accurate byte length,
 * which is exactly what the MVP needs (TTS is buffered fully before playback).
 */

/** Bytes per sample for signed 16-bit PCM. */
const BYTES_PER_SAMPLE = 2;

/** PCM (uncompressed) format tag in the WAV `fmt ` chunk. */
const PCM_FORMAT_TAG = 1;

/** Size of the canonical RIFF/WAVE header we emit, in bytes. */
export const WAV_HEADER_BYTES = 44;

/**
 * Compute the playback duration, in milliseconds, of a 16-bit PCM buffer.
 *
 *   ms = byteLength / (sampleRate * channels * 2) * 1000
 *
 * `byteLength` is the size of the raw PCM payload (no header). Returns 0 for an
 * empty buffer or non-positive rate/channel inputs to avoid NaN/Infinity.
 */
export function durationMsFromPcm(byteLength: number, sampleRate: number, channels: number): number {
  if (byteLength <= 0 || sampleRate <= 0 || channels <= 0) return 0;
  const bytesPerSecond = sampleRate * channels * BYTES_PER_SAMPLE;
  return (byteLength / bytesPerSecond) * 1000;
}

/**
 * Prepend a canonical 44-byte RIFF/WAVE header to a raw 16-bit PCM payload,
 * returning a new `Uint8Array` containing header + samples.
 *
 * Layout (all multi-byte fields little-endian):
 *   offset  field
 *   0..3    'RIFF'
 *   4..7    file size - 8 (riff chunk size)
 *   8..11   'WAVE'
 *   12..15  'fmt '
 *   16..19  fmt chunk size (16 for PCM)
 *   20..21  audio format (1 = PCM)
 *   22..23  channels
 *   24..27  sample rate
 *   28..31  byte rate (sampleRate * channels * 2)
 *   32..33  block align (channels * 2)
 *   34..35  bits per sample (16)
 *   36..39  'data'
 *   40..43  data chunk size (== pcm byte length)
 *   44..    PCM samples
 */
export function pcm16ToWav(bytes: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const dataLength = bytes.byteLength;
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign;

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataLength);
  const view = new DataView(buffer);

  // 'RIFF' chunk descriptor.
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataLength, true); // chunk size = total - 8
  writeAscii(view, 8, 'WAVE');

  // 'fmt ' sub-chunk.
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, PCM_FORMAT_TAG, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true); // bits per sample

  // 'data' sub-chunk.
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Copy the PCM payload after the header.
  new Uint8Array(buffer, WAV_HEADER_BYTES).set(bytes);

  return new Uint8Array(buffer);
}

/** Write a short ASCII string (e.g. a 4-char chunk id) byte-by-byte into `view`. */
function writeAscii(view: DataView, offset: number, ascii: string): void {
  for (let i = 0; i < ascii.length; i++) {
    view.setUint8(offset + i, ascii.charCodeAt(i));
  }
}
