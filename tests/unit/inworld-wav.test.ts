import {
  durationMsFromPcm,
  pcm16ToWav,
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
