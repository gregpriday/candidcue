/**
 * Minimal WAV helpers for 16-bit little-endian PCM (spec §17).
 *
 * Two directions are supported. {@link pcm16ToWav} wraps a raw `pcm_s16le`
 * payload in a canonical 44-byte RIFF/WAVE header (used to build fixtures and to
 * normalise any raw-PCM source). {@link isWavFile} / {@link wavDurationMs} go the
 * other way: they detect an already-formed WAV container and read its duration by
 * walking the RIFF chunks, so a provider that returns a complete WAV (as Inworld
 * does for `LINEAR16`) can be passed through untouched. Duration is derived
 * deterministically from the sample-accurate byte length, which is exactly what
 * the MVP needs (TTS is buffered fully before playback).
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

/**
 * Cheap predicate: does `bytes` begin with a RIFF/WAVE container? Checks only the
 * 12-byte magic (`'RIFF'` at 0, `'WAVE'` at 8); it does not validate the chunk
 * structure — use {@link wavDurationMs} for that.
 */
export function isWavFile(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && readTag(bytes, 0) === 'RIFF' && readTag(bytes, 8) === 'WAVE';
}

/**
 * Compute the playback duration, in milliseconds, of a RIFF/WAVE PCM file by
 * walking its sub-chunks rather than assuming the canonical 44-byte layout. The
 * sample rate and channel count come from the `fmt ` chunk and the payload length
 * from the `data` chunk, so leading/trailing metadata chunks (e.g. `fact`,
 * `LIST`) between `fmt ` and `data` do not throw off the result.
 *
 * Requires 16-bit samples (the only depth Inworld emits, and what
 * {@link durationMsFromPcm} assumes); the `fmt ` format tag is checked to be PCM.
 * Throws a plain {@link Error} on any malformed or unsupported input (missing
 * magic, missing/truncated `fmt `, non-PCM tag, non-16-bit depth, `data` before
 * `fmt `, or no `data` chunk) — callers wrap it in a domain error.
 */
export function wavDurationMs(bytes: Uint8Array): number {
  if (!isWavFile(bytes)) {
    throw new Error('WAV: missing RIFF/WAVE magic');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let sampleRate = 0;
  let channels = 0;
  let sawFmt = false;

  // Sub-chunks begin right after 'RIFF'<size>'WAVE' (offset 12). Each is a 4-byte
  // id + 4-byte little-endian size + payload, padded to an even byte boundary. We
  // walk to the end of `bytes` rather than trusting the RIFF size at offset 4,
  // which makes the parser robust to streaming headers that under-state the size.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readTag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;

    if (id === 'fmt ') {
      if (size < 16 || bodyStart + 16 > bytes.length) {
        throw new Error('WAV: fmt chunk is truncated');
      }
      const formatTag = view.getUint16(bodyStart, true);
      if (formatTag !== PCM_FORMAT_TAG) {
        throw new Error(`WAV: format is not PCM (tag ${formatTag})`);
      }
      const bitsPerSample = view.getUint16(bodyStart + 14, true);
      if (bitsPerSample !== BYTES_PER_SAMPLE * 8) {
        throw new Error(`WAV: unsupported bit depth ${bitsPerSample} (expected 16)`);
      }
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      sawFmt = true;
    } else if (id === 'data') {
      if (!sawFmt) {
        throw new Error('WAV: data chunk precedes fmt chunk');
      }
      if (sampleRate <= 0 || channels <= 0) {
        throw new Error('WAV: fmt chunk has invalid sample rate or channels');
      }
      // Clamp the declared size to the bytes actually present so a header that
      // over-states (or streams with an unknown 0xFFFFFFFF length) cannot inflate
      // the duration past the real audio.
      const dataLength = Math.min(size, bytes.length - bodyStart);
      return durationMsFromPcm(dataLength, sampleRate, channels);
    }

    // Advance past this chunk, padding an odd-sized payload to the 2-byte boundary.
    offset = bodyStart + size + (size % 2);
  }

  throw new Error('WAV: data chunk not found');
}

/**
 * Extract the raw 16-bit PCM payload (the `data` chunk body) from a RIFF/WAVE
 * file, walking sub-chunks like {@link wavDurationMs}. Used to concatenate the
 * independently-WAV-wrapped chunks of a streamed synthesis back into one clip.
 * Throws on malformed input or a missing `data` chunk.
 */
export function wavPcmPayload(bytes: Uint8Array): Uint8Array {
  if (!isWavFile(bytes)) {
    throw new Error('WAV: missing RIFF/WAVE magic');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readTag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (id === 'data') {
      const dataLength = Math.min(size, bytes.length - bodyStart);
      return bytes.subarray(bodyStart, bodyStart + dataLength);
    }
    offset = bodyStart + size + (size % 2);
  }
  throw new Error('WAV: data chunk not found');
}

/** Write a short ASCII string (e.g. a 4-char chunk id) byte-by-byte into `view`. */
function writeAscii(view: DataView, offset: number, ascii: string): void {
  for (let i = 0; i < ascii.length; i++) {
    view.setUint8(offset + i, ascii.charCodeAt(i));
  }
}

/** Read a 4-byte ASCII chunk id (e.g. `'fmt '`, `'data'`) at `offset`. */
function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}
