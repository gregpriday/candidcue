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
 * Live WebSocket transport for Inworld streaming STT (transcribe:streamBidirectional).
 * Endpoint, auth, and wire shapes follow the documented streamBidirectional
 * contract (https://docs.inworld.ai/api-reference/sttAPI/speechtotext/transcribe-stream-websocket).
 * They are isolated here so they can be corrected in one place; the inbound
 * error envelope in particular is not documented and may need live confirmation.
 */
const STT_STREAM_URL = 'wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional';

const inworldWsConnect: SttConnectFactory = async ({ apiKey, model, config }, signal) => {
  // Inworld uses HTTP Basic auth; the API key IS the verbatim Basic credential
  // (already base64-encoded by the user), so we pass it through unmodified.
  const ws = new WebSocket(STT_STREAM_URL, { headers: { Authorization: `Basic ${apiKey}` } });
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

  // First message: the documented streamBidirectional `transcribeConfig`. The
  // modelId is the provider-prefixed form (e.g. 'inworld/inworld-stt-1') carried
  // through from INWORLD_DEFAULTS.sttModel. `language` is optional on the caller
  // side, so default it to 'en-US' rather than omitting the field.
  ws.send(
    JSON.stringify({
      transcribeConfig: {
        modelId: model,
        audioEncoding: 'LINEAR16',
        sampleRateHertz: config.sampleRate,
        numberOfChannels: config.channels,
        language: config.languageHint ?? 'en-US',
      },
    }),
  );

  // Track every active inbound listener so a post-connect socket error can be
  // forwarded into the same inbound path consumers already use. Without this,
  // an `error` emitted after connect resolves would be an unhandled EventEmitter
  // 'error' event and crash the Electron main process.
  const inboundListeners = new Set<(raw: unknown) => void>();
  // Message handlers registered via onMessage, tracked so close() can detach
  // every one of them (in addition to each subscription's own unsubscribe).
  const messageHandlers = new Set<(data: WebSocket.RawData) => void>();

  // Persistent 'error' handler installed for the life of the transport. The
  // temporary handler from the connect Promise is removed once 'open' fires, so
  // this is the only thing standing between a late socket error and a hard crash.
  // It normalizes the error into the documented `{ error: { message } }` envelope
  // so the event-normalizer maps it to a 'error' event, then closes the socket.
  const onSocketError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : 'STT socket error';
    const raw = { error: { message } };
    for (const listener of inboundListeners) listener(raw);
    try {
      ws.close();
    } catch {
      /* already closing/closed */
    }
  };
  ws.on('error', onSocketError);

  const transport: SttTransport = {
    // Audio frames are sent as the documented `audioChunk` wrapper carrying
    // base64-encoded PCM in `content` (not raw binary).
    send: (payload) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ audioChunk: { content: Buffer.from(payload).toString('base64') } }),
        );
      }
    },
    close: () => {
      // Remove the persistent error handler and any message handlers we added so
      // the socket can't keep emitting into dead listeners (and can't leak).
      ws.off('error', onSocketError);
      for (const handler of messageHandlers) ws.off('message', handler);
      messageHandlers.clear();
      inboundListeners.clear();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
    onMessage: (listener) => {
      const handler = (data: WebSocket.RawData): void => {
        // Parse inside the guard: a malformed frame is ignored. Listener errors
        // are deliberately raised OUTSIDE the guard so a downstream normalizer
        // throw is never masked as a bad frame.
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return; /* ignore malformed frame */
        }
        listener(parsed);
      };
      inboundListeners.add(listener);
      messageHandlers.add(handler);
      ws.on('message', handler);
      return () => {
        inboundListeners.delete(listener);
        messageHandlers.delete(handler);
        ws.off('message', handler);
      };
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
