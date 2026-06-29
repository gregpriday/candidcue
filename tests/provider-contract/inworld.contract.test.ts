import { afterEach, describe, it, expect } from 'vitest';
import { buildInworldAdapters } from '@main/providers/factory';
import { isWavFile } from '@main/providers/inworld';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';
import type { SpeechToTextAdapter } from '@shared/contracts';

/**
 * Opt-in contract test (spec §24.1.3). Skipped unless INWORLD_API_KEY is set, so
 * CI never spends credits by default. The key is the verbatim Basic credential
 * Inworld issues (already base64); pass it through unmodified. Run with:
 *   INWORLD_API_KEY=<basic-credential> npm run test:providers
 *
 * Two surfaces are exercised against the real endpoints: the HTTP TTS round-trip
 * (decodable WAV + plausible duration) and the streaming-STT WebSocket lifecycle
 * (auth + transcribeConfig frame + audio frame, resolving a turn result).
 */
const KEY = process.env.INWORLD_API_KEY;

// Mira's default Inworld voice (src/main/characters/registry.ts). Hard-coded
// here on purpose: a contract test pins the provider's wire contract, so if the
// voice id rotates this test failing is the signal to re-point it.
const MIRA_VOICE_ID = 'default-vjmruianb0v3isz0fhtnig__design-voice-99088bb6';

describe.skipIf(!KEY)('Inworld provider contract', () => {
  // The STT client holds a live WebSocket; an un-closed socket keeps Vitest from
  // exiting. The test body closes it in `finally`; this afterEach is the
  // idempotent fallback (InworldSttClient.close() is guarded against double-call).
  let stt: SpeechToTextAdapter | null = null;
  afterEach(async () => {
    await stt?.close();
    stt = null;
  });

  it('synthesizes decodable WAV audio with a plausible duration', async () => {
    const { tts } = buildInworldAdapters(KEY!);
    const result = await tts.synthesize({
      text: 'Hello, this is a CandidCue contract test.',
      voiceId: MIRA_VOICE_ID,
      style: 'neutral',
      speakingRate: 1,
      outputFormat: 'wav',
      sampleRate: INWORLD_DEFAULTS.ttsSampleRate,
    });

    expect(result.bytes.length).toBeGreaterThan(0);
    expect(isWavFile(result.bytes)).toBe(true);
    expect(result.mimeType).toBe('audio/wav');
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('streams an STT turn over the WebSocket and resolves a result', async () => {
    const adapters = buildInworldAdapters(KEY!);
    stt = adapters.stt;

    try {
      // connect performs the auth handshake and sends the transcribeConfig frame.
      await stt.connect({
        sampleRate: 16000,
        channels: 1,
        model: INWORLD_DEFAULTS.sttModel,
        interimResults: true,
      });
      await stt.beginTurn('contract-turn');

      // One second of zeroed PCM silence (16 kHz, 16-bit, mono). Silence is
      // sufficient: the goal is to prove the auth + config + audio-frame wire
      // contract round-trips, not to assert a particular transcription.
      stt.writeAudio({
        sessionId: 'contract-session',
        turnId: 'contract-turn',
        sequence: 1,
        sampleRate: 16000,
        channels: 1,
        format: 'pcm_s16le',
        capturedAtMs: Date.now(),
        payload: new ArrayBuffer(16000 * 2),
      });

      // endTurn resolves by the deadline with whatever accumulated (empty text is
      // fine for silence) — it does not throw on no-speech.
      const result = await stt.endTurn({ deadlineMs: 10_000 });

      expect(typeof result.text).toBe('string');
      expect(Array.isArray(result.finalSegments)).toBe(true);
    } finally {
      await stt.close();
      stt = null;
    }
  });
});
