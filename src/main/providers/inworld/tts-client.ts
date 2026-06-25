import type {
  TextToSpeechAdapter,
  TtsInput,
  TestVoiceInput,
  TtsResult,
} from '@shared/contracts/adapters';
import { AppError } from '@shared/errors/app-error';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';
import { nowMs } from '@shared/utils/deadline';
import { durationMsFromPcm, pcm16ToWav } from './wav';

/** Injectable fetch implementation. Defaults to the global `fetch`. */
export type TtsFetch = typeof fetch;

export interface InworldTtsClientOptions {
  apiKey: string;
  /** Inworld TTS model id. Defaults to {@link INWORLD_DEFAULTS.ttsModel}. */
  modelId?: string;
  /** Base URL of the Inworld TTS endpoint. */
  baseUrl?: string;
  /** Injectable fetch (real `fetch` in production, fake in tests). */
  fetchImpl?: TtsFetch;
}

/** Default synthesize endpoint (real Inworld tts/v1/voice contract; overridable). */
const DEFAULT_BASE_URL = 'https://api.inworld.ai/tts/v1/voice';

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
 * Wire shape: the Inworld `tts/v1/voice` endpoint returns JSON with a base64
 * `audioContent` field carrying raw LINEAR16 (pcm_s16le) samples. We base64-decode
 * it, wrap it in a canonical WAV header so the renderer can decode it, and report
 * `audio/wav`.
 */
export class InworldTtsClient implements TextToSpeechAdapter {
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: TtsFetch;

  constructor(options: InworldTtsClientOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId ?? INWORLD_DEFAULTS.ttsModel;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Synthesize speech for `input.text` in voice `input.voiceId`. Buffers the
   * whole response, computes duration from the decoded PCM, and returns a
   * complete {@link TtsResult}.
   * @throws AppError INWORLD_AUTH on 401/403, TTS_FAILED on any other non-OK
   *   response or a malformed/empty `audioContent`.
   */
  async synthesize(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    const start = nowMs();

    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Inworld passes the API key verbatim as the Basic credential — it is
        // already the Basic token, so we do NOT base64-encode it again.
        Authorization: `Basic ${this.apiKey}`,
      },
      // Follows the documented Inworld `tts/v1/voice` request contract. Field
      // names are doc-derived and may need live confirmation against the API.
      body: JSON.stringify({
        text: input.text,
        voiceId: input.voiceId,
        modelId: this.modelId,
        audioConfig: {
          audioEncoding: 'LINEAR16',
          sampleRateHertz: input.sampleRate,
          speakingRate: input.speakingRate,
        },
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

    const providerRequestId =
      response.headers.get('x-request-id') ?? response.headers.get('x-inworld-request-id');

    let payload: { audioContent?: unknown };
    try {
      payload = (await response.json()) as { audioContent?: unknown };
    } catch (error) {
      // Preserve abort semantics: a caller-triggered abort surfaces here as an
      // AbortError and must propagate unchanged, never masked as TTS_FAILED.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      // An OK status with a non-JSON or truncated body is a synthesis failure,
      // not a raw SyntaxError leaking out of the adapter.
      throw new AppError('TTS_FAILED', {
        message: 'Inworld TTS response body was not valid JSON',
        cause: error,
      });
    }

    const audioContent = payload.audioContent;
    if (typeof audioContent !== 'string' || audioContent.trim().length === 0) {
      // A missing/empty/whitespace-only/non-string body is a failure, not silence.
      throw new AppError('TTS_FAILED', {
        message: 'Inworld TTS response did not include base64 audioContent',
      });
    }

    // `audioContent` is base64-encoded raw LINEAR16 (pcm_s16le) PCM. Decode it,
    // wrap it in a WAV header for the renderer, and derive duration from the PCM.
    const pcm = base64ToBytes(audioContent);
    // LINEAR16 is 2 bytes/sample, so a valid clip has a non-zero, even byte
    // count. Anything else means the decoded payload is truncated or corrupt.
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
      throw new AppError('TTS_FAILED', {
        message: 'Inworld TTS response decoded to malformed LINEAR16 PCM',
      });
    }
    const bytes = pcm16ToWav(pcm, input.sampleRate, TTS_CHANNELS);
    const durationMs = durationMsFromPcm(pcm.byteLength, input.sampleRate, TTS_CHANNELS);

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
}

/** Decode a base64 string to raw bytes (works in both Node and Electron main). */
function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
