import OpenAI from 'openai';
import WebSocket from 'ws';
import { createOpenAiAdaptersFromClient, type OpenAiAdapters } from './openai';
import {
  InworldSttClient,
  InworldTtsClient,
  type SttConnectFactory,
  type SttTransport,
} from './inworld';
import { FakeInterviewModel, FakeModeration, FakeStt, FakeTts } from './fakes';
import type {
  InterviewModelAdapter,
  ModerationAdapter,
  SpeechToTextAdapter,
  TextToSpeechAdapter,
} from '@shared/contracts';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';

export function buildOpenAiAdapters(apiKey: string): OpenAiAdapters {
  // Force the SDK onto the platform's native fetch. Its bundled `node-fetch`
  // truncates long gzip response bodies from the Responses API — gpt-5.5's
  // reasoning replies arrive slowly and large — which surfaces either as a
  // "Premature close" error or as a `status: "completed"` response with an empty
  // `output_text`, i.e. a generic "OpenAI returned no output text" preparation
  // failure. Native fetch (undici on Node 18+, and in Electron) reads the body
  // correctly. Where no global fetch exists, fall back to the SDK default.
  const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;
  return createOpenAiAdaptersFromClient(new OpenAI({ apiKey, fetch: nativeFetch }));
}

/**
 * Live WebSocket transport for Inworld streaming STT (transcribe:streamBidirectional).
 * Endpoint, auth, and wire shapes follow the documented streamBidirectional
 * contract (https://docs.inworld.ai/api-reference/sttAPI/speechtotext/transcribe-stream-websocket).
 * They are isolated here so they can be corrected in one place; the inbound
 * error envelope in particular is not documented and may need live confirmation.
 */
const STT_STREAM_URL = 'wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional';

/**
 * Build the streaming-STT WebSocket URL. The streamBidirectional endpoint's
 * security scheme is `httpApiKey` with `in: query` (param name lowercase
 * `authorization`), so the Basic credential travels as a URL query parameter —
 * NOT as an `Authorization` upgrade header (the server ignores the header and
 * rejects the connection). `encodeURIComponent` is used rather than
 * URLSearchParams so the space becomes `%20` (per the docs) instead of `+`, and
 * so the base64 credential's `+` `/` `=` are percent-escaped verbatim.
 *
 * Note: the synchronous REST recovery path (`recoverFromAudio` in stt-client.ts)
 * uses a different Inworld scheme — `apiKey` in an HTTP `Authorization` header —
 * and is intentionally left untouched here.
 */
export function buildSttWsUrl(baseUrl: string, apiKey: string): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}authorization=${encodeURIComponent(`Basic ${apiKey}`)}`;
}

export const inworldWsConnect: SttConnectFactory = async ({ apiKey, model, config }, signal) => {
  // The API key IS the verbatim Basic credential (already base64-encoded by the
  // user), passed through unmodified inside the query-param URL (see
  // buildSttWsUrl) — the streaming endpoint authenticates via query param.
  const ws = new WebSocket(buildSttWsUrl(STT_STREAM_URL, apiKey));
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

// ---------------------------------------------------------------------------
// Provider selection / fake-mode seam
// ---------------------------------------------------------------------------
//
// The four deterministic fakes in ./fakes back unit and integration tests, but
// were never reachable from a RUNNING app: production wiring hardcodes the real
// OpenAI/Inworld adapters. The env-gated seam below lets an app-level launch
// test (issue #24) point the real Electron app at the fakes — exercising real
// IPC, real windows, and the real orchestrator without network access or keys.
// It ships inert: production builds never set CANDIDCUE_PROVIDERS, so the real
// adapters are used unless fakes are explicitly requested.

/** Stand-in credential returned to the auth/preflight gates in fake mode. */
export const FAKE_PROVIDER_KEY = 'fake-provider-key';

/** Whether the running app should be backed by the deterministic provider fakes. */
export function useFakeProviders(): boolean {
  return process.env.CANDIDCUE_PROVIDERS === 'fake';
}

/** The full adapter set the orchestrator drives (model + moderation + stt + tts). */
export interface ProviderAdapters {
  model: InterviewModelAdapter;
  moderation: ModerationAdapter;
  stt: SpeechToTextAdapter;
  tts: TextToSpeechAdapter;
}

/**
 * Build the four provider adapters. In fake mode the existing deterministic
 * fakes are wired in (no network, no keys); otherwise the real OpenAI + Inworld
 * adapters are constructed from the supplied credentials.
 */
export function buildAdapters(input: {
  openaiKey: string;
  inworldKey: string;
  sttModel?: string;
  ttsModel?: string;
}): ProviderAdapters {
  if (useFakeProviders()) return buildFakeAdapters();
  const openai = buildOpenAiAdapters(input.openaiKey);
  const inworld = buildInworldAdapters(input.inworldKey, input.sttModel, input.ttsModel);
  return { model: openai.model, moderation: openai.moderation, stt: inworld.stt, tts: inworld.tts };
}

/**
 * The deterministic fake adapter set. Exported so unit tests and the app-launch
 * harness can assert against the exact instances a fake-mode app uses.
 */
export function buildFakeAdapters(): ProviderAdapters {
  return {
    model: new FakeInterviewModel(),
    moderation: new FakeModeration(),
    stt: new FakeStt({ transcript: 'A clear, candid answer to the opening question.' }),
    tts: new FakeTts({ durationMs: 1500 }),
  };
}

/** Credential-store shape the provider-credential helpers consult. */
interface CredentialStoreLike {
  hasKey(provider: 'openai' | 'inworld'): boolean;
  getKey(provider: 'openai' | 'inworld'): string | null;
}

/**
 * Whether `provider`'s credential requirement is satisfied. Fake mode short-
 * circuits to true so preflight passes without stored keys; otherwise the real
 * credential store is consulted.
 */
export function hasProviderCredential(provider: 'openai' | 'inworld', store: CredentialStoreLike): boolean {
  return useFakeProviders() || store.hasKey(provider);
}

/**
 * The credential for `provider`, or null when none is available. Fake mode
 * returns a stand-in key so the adapter-build auth checks never fire.
 */
export function getProviderCredential(provider: 'openai' | 'inworld', store: CredentialStoreLike): string | null {
  if (useFakeProviders()) return FAKE_PROVIDER_KEY;
  return store.getKey(provider);
}
