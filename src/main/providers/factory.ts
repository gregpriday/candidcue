import OpenAI from 'openai';
import WebSocket from 'ws';
import { createOpenAiAdaptersFromClient, type OpenAiAdapters } from './openai';
import {
  InworldSttClient,
  InworldTtsClient,
  type SttConnectFactory,
  type SttTransport,
} from './inworld';
import type { SpeechToTextAdapter, TextToSpeechAdapter } from '@shared/contracts';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';

export function buildOpenAiAdapters(apiKey: string): OpenAiAdapters {
  return createOpenAiAdaptersFromClient(new OpenAI({ apiKey }));
}

/**
 * Live WebSocket transport for Inworld streaming STT. The exact endpoint and
 * wire shape are a documented assumption (the agent that wrote stt-client noted
 * the same) and are isolated here so they can be corrected in one place once the
 * real Inworld contract is confirmed.
 */
const STT_STREAM_URL = 'wss://api.inworld.ai/v1/stt:streamingRecognize';

const inworldWsConnect: SttConnectFactory = async ({ apiKey, model, config }, signal) => {
  const ws = new WebSocket(STT_STREAM_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err instanceof Error ? err : new Error('STT socket error'));
    };
    const onAbort = (): void => {
      cleanup();
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error('aborted'));
    };
    const cleanup = (): void => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    signal?.addEventListener('abort', onAbort);
  });

  ws.send(
    JSON.stringify({
      type: 'config',
      model,
      sampleRate: config.sampleRate,
      channels: config.channels,
      interimResults: config.interimResults,
      languageHint: config.languageHint,
    }),
  );

  const transport: SttTransport = {
    send: (payload) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(payload));
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
    onMessage: (listener) => {
      const handler = (data: WebSocket.RawData): void => {
        try {
          listener(JSON.parse(data.toString()));
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.on('message', handler);
      return () => ws.off('message', handler);
    },
  };
  return transport;
};

export function buildInworldAdapters(
  apiKey: string,
  sttModel: string = INWORLD_DEFAULTS.sttModel,
  ttsModel: string = INWORLD_DEFAULTS.ttsModel,
): { stt: SpeechToTextAdapter; tts: TextToSpeechAdapter } {
  const stt = new InworldSttClient({ apiKey, model: sttModel, connect: inworldWsConnect });
  const tts = new InworldTtsClient({ apiKey, modelId: ttsModel });
  return { stt, tts };
}
