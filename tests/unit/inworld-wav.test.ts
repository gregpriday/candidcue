import {
  durationMsFromPcm,
  isWavFile,
  pcm16ToWav,
  wavDurationMs,
  WAV_HEADER_BYTES,
} from '@main/providers/inworld/wav';

/** Read a 4-char ASCII tag out of a WAV header at the given offset. */
function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/** Read a little-endian uint32 out of a byte array at the given offset. */
function readUint32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** Read a little-endian uint16 out of a byte array at the given offset. */
function readUint16LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

describe('durationMsFromPcm', () => {
  it('computes ms = byteLength / (sampleRate * channels * 2) * 1000', () => {
    // 1 second of 16 kHz mono 16-bit PCM = 16000 * 1 * 2 = 32000 bytes.
    expect(durationMsFromPcm(32000, 16000, 1)).toBe(1000);
  });

  it('halves duration when there are two channels at the same rate', () => {
    // 32000 bytes at 16 kHz stereo (4 bytes/frame) = 0.5 s.
    expect(durationMsFromPcm(32000, 16000, 2)).toBe(500);
  });

  it('computes a fractional duration for a partial buffer', () => {
    // 16000 bytes at 16 kHz mono = 0.5 s.
    expect(durationMsFromPcm(16000, 16000, 1)).toBe(500);
  });

  it('matches the spec example for 24 kHz mono TTS output', () => {
    // 24000 * 1 * 2 = 48000 bytes per second at the default TTS sample rate.
    expect(durationMsFromPcm(48000, 24000, 1)).toBe(1000);
    expect(durationMsFromPcm(24000, 24000, 1)).toBe(500);
  });

  it('returns 0 for an empty buffer', () => {
    expect(durationMsFromPcm(0, 16000, 1)).toBe(0);
  });

  it('returns 0 for non-positive sample rate or channels (no NaN/Infinity)', () => {
    expect(durationMsFromPcm(1000, 0, 1)).toBe(0);
    expect(durationMsFromPcm(1000, 16000, 0)).toBe(0);
    expect(durationMsFromPcm(-100, 16000, 1)).toBe(0);
  });
});

describe('pcm16ToWav', () => {
  // A known 8-byte PCM payload (four 16-bit samples).
  const pcm = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  const sampleRate = 24000;
  const channels = 1;

  it('produces a buffer that is 44 bytes longer than the payload', () => {
    const wav = pcm16ToWav(pcm, sampleRate, channels);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcm.byteLength);
    expect(WAV_HEADER_BYTES).toBe(44);
  });

  it('starts with the RIFF magic and contains the WAVE form type', () => {
    const wav = pcm16ToWav(pcm, sampleRate, channels);
    expect(readAscii(wav, 0, 4)).toBe('RIFF');
    expect(readAscii(wav, 8, 4)).toBe('WAVE');
  });

  it('contains the fmt and data chunk identifiers', () => {
    const wav = pcm16ToWav(pcm, sampleRate, channels);
    expect(readAscii(wav, 12, 4)).toBe('fmt ');
    expect(readAscii(wav, 36, 4)).toBe('data');
  });

  it('writes the RIFF chunk size as total length minus 8', () => {
    const wav = pcm16ToWav(pcm, sampleRate, channels);
    expect(readUint32LE(wav, 4)).toBe(wav.byteLength - 8);
  });

  it('writes the data chunk size equal to the PCM byte length', () => {
    const wav = pcm16ToWav(pcm, sampleRate, channels);
    expect(readUint32LE(wav, 40)).toBe(pcm.byteLength);
  });

  it('writes a PCM fmt chunk: size 16, format 1, 16 bits per sample', () => {
    const wav = pcm16ToWav(pcm, sampleRate, channels);
    expect(readUint32LE(wav, 16)).toBe(16); // fmt chunk size
    expect(readUint16LE(wav, 20)).toBe(1); // PCM format tag
    expect(readUint16LE(wav, 34)).toBe(16); // bits per sample
  });

  it('writes channels, sample rate, byte rate and block align consistently', () => {
    const wav = pcm16ToWav(pcm, sampleRate, channels);
    expect(readUint16LE(wav, 22)).toBe(channels);
    expect(readUint32LE(wav, 24)).toBe(sampleRate);
    expect(readUint32LE(wav, 28)).toBe(sampleRate * channels * 2); // byte rate
    expect(readUint16LE(wav, 32)).toBe(channels * 2); // block align
  });

  it('appends the PCM payload verbatim after the header', () => {
    const wav = pcm16ToWav(pcm, sampleRate, channels);
    expect(Array.from(wav.subarray(WAV_HEADER_BYTES))).toEqual(Array.from(pcm));
  });

  it('handles a two-channel header without corrupting derived fields', () => {
    const wav = pcm16ToWav(pcm, 48000, 2);
    expect(readUint16LE(wav, 22)).toBe(2);
    expect(readUint32LE(wav, 24)).toBe(48000);
    expect(readUint32LE(wav, 28)).toBe(48000 * 2 * 2);
    expect(readUint16LE(wav, 32)).toBe(2 * 2);
  });

  it('produces a valid header for an empty payload', () => {
    const wav = pcm16ToWav(new Uint8Array(0), sampleRate, channels);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES);
    expect(readAscii(wav, 0, 4)).toBe('RIFF');
    expect(readUint32LE(wav, 40)).toBe(0); // data chunk size
  });

  it('agrees with durationMsFromPcm for a known buffer', () => {
    // 48000 bytes of 24 kHz mono PCM is exactly 1 second.
    const oneSecondPcm = new Uint8Array(48000);
    const wav = pcm16ToWav(oneSecondPcm, 24000, 1);
    const payloadLength = wav.byteLength - WAV_HEADER_BYTES;
    expect(payloadLength).toBe(48000);
    expect(durationMsFromPcm(payloadLength, 24000, 1)).toBe(1000);
  });
});

/** Encode `s` (4 chars) as a 4-byte ASCII tag. */
function tag(s: string): Uint8Array {
  return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}

/** Encode `n` as a 4-byte little-endian uint32. */
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** Concatenate byte arrays into a single buffer. */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Build a 16-byte PCM `fmt ` chunk body with the given parameters. */
function fmtBody(sampleRate: number, channels: number, bitsPerSample = 16, formatTag = 1): Uint8Array {
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  const blockAlign = channels * (bitsPerSample / 8);
  view.setUint16(0, formatTag, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * blockAlign, true); // byte rate
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bitsPerSample, true);
  return body;
}

/**
 * Assemble a RIFF/WAVE file from explicit sub-chunks, padding odd-sized bodies to
 * the 2-byte boundary — lets each test exercise a specific chunk layout.
 */
function buildWav(chunks: Array<{ id: string; body: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const { id, body } of chunks) {
    parts.push(tag(id), u32le(body.byteLength), body);
    if (body.byteLength % 2 === 1) parts.push(new Uint8Array(1)); // pad byte
  }
  const payload = concat(parts);
  return concat([tag('RIFF'), u32le(4 + payload.byteLength), tag('WAVE'), payload]);
}

describe('isWavFile', () => {
  it('returns true for a canonical WAV from pcm16ToWav', () => {
    expect(isWavFile(pcm16ToWav(new Uint8Array(4), 24000, 1))).toBe(true);
  });

  it('returns false for an empty buffer', () => {
    expect(isWavFile(new Uint8Array(0))).toBe(false);
  });

  it('returns false for a buffer shorter than the 12-byte magic', () => {
    expect(isWavFile(new Uint8Array(11))).toBe(false);
  });

  it('returns false when the chunk id is RIFX rather than RIFF', () => {
    const wav = pcm16ToWav(new Uint8Array(4), 24000, 1);
    wav[3] = 'X'.charCodeAt(0); // RIFF -> RIFX
    expect(isWavFile(wav)).toBe(false);
  });

  it('returns false when the form type is not WAVE', () => {
    const wav = pcm16ToWav(new Uint8Array(4), 24000, 1);
    wav.set(tag('AVI '), 8); // WAVE -> 'AVI '
    expect(isWavFile(wav)).toBe(false);
  });

  it('returns false for raw PCM bytes with no header', () => {
    expect(isWavFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
  });
});

describe('wavDurationMs', () => {
  it('reads duration from a canonical pcm16ToWav buffer', () => {
    // 48000 data bytes of 24 kHz mono 16-bit PCM = exactly 1 second.
    expect(wavDurationMs(pcm16ToWav(new Uint8Array(48000), 24000, 1))).toBe(1000);
  });

  it('uses the data chunk size, not the total file length (no header inflation)', () => {
    // 24000 data bytes at 24 kHz mono = 0.5 s; the 44 header bytes must not count.
    expect(wavDurationMs(pcm16ToWav(new Uint8Array(24000), 24000, 1))).toBe(500);
  });

  it('halves duration for stereo at the same data length', () => {
    expect(wavDurationMs(pcm16ToWav(new Uint8Array(48000), 24000, 2))).toBe(500);
  });

  it('finds the data chunk past a fact chunk between fmt and data', () => {
    const wav = buildWav([
      { id: 'fmt ', body: fmtBody(24000, 1) },
      { id: 'fact', body: u32le(24000) },
      { id: 'data', body: new Uint8Array(48000) },
    ]);
    expect(wavDurationMs(wav)).toBe(1000);
  });

  it('skips an odd-sized metadata chunk with its pad byte', () => {
    const wav = buildWav([
      { id: 'fmt ', body: fmtBody(24000, 1) },
      { id: 'LIST', body: new Uint8Array(5) }, // odd -> padded to 6
      { id: 'data', body: new Uint8Array(24000) }, // 0.5 s
    ]);
    expect(wavDurationMs(wav)).toBe(500);
  });

  it('clamps a data chunk size that over-states the bytes present', () => {
    // Declared data size 48000 but only 24000 real bytes -> 0.5 s, not 1 s.
    const wav = concat([
      tag('RIFF'),
      u32le(0),
      tag('WAVE'),
      tag('fmt '),
      u32le(16),
      fmtBody(24000, 1),
      tag('data'),
      u32le(48000), // lies: claims 48000 data bytes
      new Uint8Array(24000), // only 24000 present
    ]);
    expect(wavDurationMs(wav)).toBe(500);
  });

  it('returns 0 for a zero-length data chunk', () => {
    const wav = buildWav([
      { id: 'fmt ', body: fmtBody(24000, 1) },
      { id: 'data', body: new Uint8Array(0) },
    ]);
    expect(wavDurationMs(wav)).toBe(0);
  });

  it('throws for bytes without the RIFF/WAVE magic', () => {
    expect(() => wavDurationMs(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });

  it('throws when the fmt chunk is truncated (size < 16)', () => {
    const wav = buildWav([
      { id: 'fmt ', body: new Uint8Array(14) },
      { id: 'data', body: new Uint8Array(100) },
    ]);
    expect(() => wavDurationMs(wav)).toThrow();
  });

  it('throws for a non-PCM format tag', () => {
    const wav = buildWav([
      { id: 'fmt ', body: fmtBody(24000, 1, 16, 3) }, // tag 3 = IEEE float
      { id: 'data', body: new Uint8Array(100) },
    ]);
    expect(() => wavDurationMs(wav)).toThrow();
  });

  it('throws when a data chunk precedes the fmt chunk', () => {
    const wav = buildWav([
      { id: 'data', body: new Uint8Array(100) },
      { id: 'fmt ', body: fmtBody(24000, 1) },
    ]);
    expect(() => wavDurationMs(wav)).toThrow();
  });

  it('throws when no data chunk is present', () => {
    const wav = buildWav([{ id: 'fmt ', body: fmtBody(24000, 1) }]);
    expect(() => wavDurationMs(wav)).toThrow();
  });
});
