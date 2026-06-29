/**
 * Inworld provider adapters: streaming STT and buffered TTS (spec §13.4, §17).
 */
export {
  normalizeSttEvent,
  type NormalizedSttEvent,
  type NormalizedSttEventKind,
} from './event-normalizer';
export {
  durationMsFromPcm,
  isWavFile,
  pcm16ToWav,
  wavDurationMs,
  WAV_HEADER_BYTES,
} from './wav';
export {
  InworldSttClient,
  type InworldSttClientOptions,
  type SttTransport,
  type SttConnectFactory,
  type SttFetch,
} from './stt-client';
export { InworldTtsClient, type InworldTtsClientOptions, type TtsFetch } from './tts-client';
