import type {
  TextToSpeechAdapter,
  TtsInput,
  TestVoiceInput,
  TtsResult,
} from '@shared/contracts/adapters';
import { AppError } from '@shared/errors/app-error';
import { nowMs } from '@shared/utils/deadline';
import { durationMsFromPcm, pcm16ToWav, WAV_HEADER_BYTES } from './wav';

/** Injectable fetch implementation. Defaults to the global `fetch`. */
export type TtsFetch = typeof fetch;

export interface InworldTtsClientOptions {
  apiKey: string;
  /** Base URL of the Inworld TTS synthesize endpoint. */
  baseUrl?: string;
  /** Injectable fetch (real `fetch` in production, fake in tests). */
  fetchImpl?: TtsFetch;
}

/** Default synthesize endpoint (documented assumption; overridable). */
const DEFAULT_BASE_URL = 'https://api.inworld.ai/v1/tts:synthesize';

/** Single mono channel for all TTS output (spec §17). */
const TTS_CHANNELS = 1;

/**
 * Inworld TTS client (spec §13.4, §17).
 *
 * MVP requirement: each request is buffered fully before returning — we read the
 * entire audio body, compute its duration deterministically from the PCM byte
 * length, and hand back a complete {@link TtsResult}. There is no streaming
 * playback in the MVP, so callers always receive the whole clip up front.
 *
 * Output handling:
 *  - `pcm_s16le`: the body is raw 16-bit PCM; we wrap it in a WAV header so the
 *    renderer can decode it, and report `audio/wav`.
 *  - `wav`: the body already carries a RIFF/WAVE header; we pass it through and
 *    derive duration from the payload after the 44-byte header.
 */
export class InworldTtsClient implements TextToSpeechAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: TtsFetch;

  constructor(options: InworldTtsClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Synthesize speech for `input.text` in voice `input.voiceId`. Buffers the
   * whole response, computes duration from the decoded PCM, and returns a
   * complete {@link TtsResult}.
   * @throws AppError TTS_FAILED on a non-OK response.
   */
  async synthesize(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    const start = nowMs();

    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: input.outputFormat === 'wav' ? 'audio/wav' : 'audio/L16',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        text: input.text,
        voiceId: input.voiceId,
        style: input.style,
        speakingRate: input.speakingRate,
        outputFormat: input.outputFormat,
        sampleRate: input.sampleRate,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      // 401/403 specifically mean bad credentials; everything else is a generic
      // synthesis failure. Both are surfaced as user-safe AppErrors.
      const code = response.status === 401 || response.status === 403 ? 'INWORLD_AUTH' : 'TTS_FAILED';
      throw new AppError(code, {
        message: `Inworld TTS failed with status ${response.status}`,
      });
    }

    const raw = new Uint8Array(await response.arrayBuffer());
    const providerRequestId =
      response.headers.get('x-request-id') ?? response.headers.get('x-inworld-request-id');

    // Normalize to a renderer-playable WAV and compute duration from the PCM
    // payload (the data chunk, i.e. everything after the 44-byte header).
    const { bytes, pcmByteLength } = this.toWav(raw, input.outputFormat, input.sampleRate);
    const durationMs = durationMsFromPcm(pcmByteLength, input.sampleRate, TTS_CHANNELS);

    return {
      bytes,
      mimeType: 'audio/wav',
      sampleRate: input.sampleRate,
      channels: TTS_CHANNELS,
      durationMs,
      providerRequestId,
      latencyMs: nowMs() - start,
    };
  }

  /** Probe a voice configuration. Delegates to {@link synthesize} (spec §13.4). */
  async testVoice(input: TestVoiceInput, signal?: AbortSignal): Promise<TtsResult> {
    return this.synthesize(input, signal);
  }

  /**
   * Coerce the raw response body into a renderer-playable WAV buffer and report
   * the size of its PCM payload (used for duration math). Raw PCM is wrapped in
   * a fresh 44-byte header at `sampleRate`; an already-WAV body is passed
   * through and its header subtracted from the reported PCM length.
   */
  private toWav(
    raw: Uint8Array,
    outputFormat: TtsInput['outputFormat'],
    sampleRate: number,
  ): { bytes: Uint8Array; pcmByteLength: number } {
    if (outputFormat === 'wav') {
      // Body already carries a RIFF/WAVE header; duration is from the data chunk.
      return { bytes: raw, pcmByteLength: Math.max(0, raw.byteLength - WAV_HEADER_BYTES) };
    }
    // Raw PCM: wrap so the renderer can decode it; the whole body is the payload.
    return { bytes: pcm16ToWav(raw, sampleRate, TTS_CHANNELS), pcmByteLength: raw.byteLength };
  }
}
