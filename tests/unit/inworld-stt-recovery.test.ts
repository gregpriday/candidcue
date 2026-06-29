import {
  InworldSttClient,
  type SttFetch,
  type SttConnectFactory,
  type SttTransport,
} from '@main/providers/inworld/stt-client';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';
import { AppError } from '@shared/errors/app-error';
import type { SttRecoveryConfig, SttSessionConfig } from '@shared/contracts/adapters';

/** A connect factory that is never invoked by the recovery path. */
const unusedConnect: SttConnectFactory = async () => {
  throw new Error('connect should not be called in recovery tests');
};

/** Build a minimal Response-like object for a fake fetch. */
function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const recoveryConfig: SttRecoveryConfig = {
  sampleRate: 16000,
  channels: 1,
  model: 'inworld/inworld-stt-1',
};

describe('InworldSttClient.recoverFromAudio', () => {
  it('posts to the synchronous transcribe endpoint with Basic auth and base64 audio', async () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5]);
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl: SttFetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse({ transcription: { transcript: 'hello world', isFinal: true } });
    };

    const client = new InworldSttClient({ apiKey: 'key-abc', connect: unusedConnect, fetchImpl });
    const result = await client.recoverFromAudio(pcm, recoveryConfig);

    expect(capturedUrl).toBe('https://api.inworld.ai/stt/v1/transcribe');
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Basic key-abc');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toEqual({
      transcribeConfig: {
        modelId: 'inworld/inworld-stt-1',
        audioEncoding: 'LINEAR16',
        sampleRateHertz: 16000,
        numberOfChannels: 1,
        language: 'en-US',
      },
      audioData: { content: Buffer.from(pcm).toString('base64') },
    });

    expect(result.text).toBe('hello world');
    expect(result.finalSegments).toEqual(['hello world']);
    expect(result.confidence).toBeNull();
  });

  it('falls back to the default sttModel when the config model is not provider-prefixed', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: SttFetch = async (_url, init) => {
      capturedInit = init;
      return jsonResponse({ transcription: { transcript: 'x' } });
    };

    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });
    await client.recoverFromAudio(new Uint8Array([0]), { ...recoveryConfig, model: 'bare-model' });

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.transcribeConfig.modelId).toBe(INWORLD_DEFAULTS.sttModel);
  });

  it('returns empty text for a missing/empty transcript without throwing', async () => {
    const fetchImpl: SttFetch = async () => jsonResponse({ transcription: {} });
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    const result = await client.recoverFromAudio(new Uint8Array([0]), recoveryConfig);
    expect(result.text).toBe('');
    expect(result.finalSegments).toEqual([]);
    expect(result.confidence).toBeNull();
  });

  it.each([
    ['null', null],
    ['the number 42', 42],
    ['a string', 'just a string'],
  ])('throws STT_FINALIZE_FAILED when the OK body is %s (non-object/primitive)', async (_label, body) => {
    const fetchImpl: SttFetch = async () => jsonResponse(body);
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    const error = await client.recoverFromAudio(new Uint8Array([0]), recoveryConfig).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STT_FINALIZE_FAILED');
  });

  it('returns empty text when transcription is null (missing transcript is not an error)', async () => {
    const fetchImpl: SttFetch = async () => jsonResponse({ transcription: null });
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    const result = await client.recoverFromAudio(new Uint8Array([0]), recoveryConfig);
    expect(result.text).toBe('');
    expect(result.finalSegments).toEqual([]);
    expect(result.confidence).toBeNull();
  });

  it('treats a non-string transcript as no transcript and returns empty text', async () => {
    const fetchImpl: SttFetch = async () => jsonResponse({ transcription: { transcript: 123 } });
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    const result = await client.recoverFromAudio(new Uint8Array([0]), recoveryConfig);
    expect(result.text).toBe('');
    expect(result.finalSegments).toEqual([]);
    expect(result.confidence).toBeNull();
  });

  it('returns empty text and no segments for an empty-string transcript', async () => {
    const fetchImpl: SttFetch = async () => jsonResponse({ transcription: { transcript: '' } });
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    const result = await client.recoverFromAudio(new Uint8Array([0]), recoveryConfig);
    expect(result.text).toBe('');
    expect(result.finalSegments).toEqual([]);
    expect(result.confidence).toBeNull();
  });

  it('base64-encodes only the subarray view, not the whole backing buffer', async () => {
    // A larger backing buffer with a distinctive payload in the middle. If the
    // implementation ever encoded `pcm.buffer` instead of the view, the decoded
    // bytes would include the surrounding 0xFF padding.
    const backing = new Uint8Array([0xff, 0xff, 0xff, 10, 20, 30, 40, 0xff, 0xff]);
    const view = backing.subarray(3, 7); // [10, 20, 30, 40]

    let capturedInit: RequestInit | undefined;
    const fetchImpl: SttFetch = async (_url, init) => {
      capturedInit = init;
      return jsonResponse({ transcription: { transcript: 'ok' } });
    };

    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });
    await client.recoverFromAudio(view, recoveryConfig);

    const body = JSON.parse(String(capturedInit?.body));
    const decoded = new Uint8Array(Buffer.from(body.audioData.content, 'base64'));
    expect([...decoded]).toEqual([10, 20, 30, 40]);
  });

  it('throws STT_FINALIZE_FAILED on a non-OK response', async () => {
    const fetchImpl: SttFetch = async () => jsonResponse({}, { status: 500 });
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    await expect(client.recoverFromAudio(new Uint8Array([0]), recoveryConfig)).rejects.toMatchObject({
      code: 'STT_FINALIZE_FAILED',
    });
  });

  it.each([401, 403])('classifies %i as INWORLD_AUTH', async (status) => {
    const fetchImpl: SttFetch = async () => jsonResponse({}, { status });
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    await expect(client.recoverFromAudio(new Uint8Array([0]), recoveryConfig)).rejects.toMatchObject({
      code: 'INWORLD_AUTH',
    });
  });

  it('checks status before the body, so a non-OK response with an unreadable body still throws STT_FINALIZE_FAILED', async () => {
    // A 500 whose json() would throw must not be classified by its body; the
    // status check short-circuits first.
    const fetchImpl: SttFetch = async () =>
      ({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }) as unknown as Response;
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    const error = await client.recoverFromAudio(new Uint8Array([0]), recoveryConfig).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STT_FINALIZE_FAILED');
  });

  it('throws a clean AppError when the OK body is not valid JSON', async () => {
    const fetchImpl: SttFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }) as unknown as Response;
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    const error = await client.recoverFromAudio(new Uint8Array([0]), recoveryConfig).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STT_FINALIZE_FAILED');
  });

  it('resumeTurn throws STT_DISCONNECTED before connect, like beginTurn', async () => {
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect });
    const error = await client.resumeTurn('turn-1').catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STT_DISCONNECTED');
  });

  it('rethrows an AbortError unchanged', async () => {
    const fetchImpl: SttFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        },
      }) as unknown as Response;
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect, fetchImpl });

    await expect(client.recoverFromAudio(new Uint8Array([0]), recoveryConfig)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

/** A controllable fake transport that records closure and replays inbound events. */
function makeTransport(): SttTransport & { closed: boolean; push: (raw: unknown) => void } {
  let listener: ((raw: unknown) => void) | null = null;
  return {
    closed: false,
    send() {
      /* no-op for these tests */
    },
    close() {
      this.closed = true;
    },
    onMessage(l: (raw: unknown) => void) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    push(raw: unknown) {
      listener?.(raw);
    },
  };
}

const sessionConfig: SttSessionConfig = {
  sampleRate: 16000,
  channels: 1,
  model: 'inworld-stt-1',
  interimResults: true,
};

describe('InworldSttClient.reconnect', () => {
  it('throws STT_DISCONNECTED when called before connect (no session config)', async () => {
    const client = new InworldSttClient({ apiKey: 'k', connect: unusedConnect });
    const error = await client.reconnect().catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STT_DISCONNECTED');
  });

  it('rebuilds the transport, closes the old one, reuses the config, and preserves listeners', async () => {
    const transports: Array<ReturnType<typeof makeTransport>> = [];
    const configs: SttSessionConfig[] = [];
    const connect: SttConnectFactory = async (args) => {
      configs.push(args.config);
      const t = makeTransport();
      transports.push(t);
      return t;
    };
    const client = new InworldSttClient({ apiKey: 'k', connect });
    await client.connect(sessionConfig);
    expect(transports).toHaveLength(1);

    // A listener registered before the reconnect must keep receiving events
    // (close() would clear it; reconnect must not).
    const partials: string[] = [];
    client.on('partial', (text: string) => partials.push(text));

    await client.reconnect();

    // The dead transport was torn down; a fresh one was built with the SAME config.
    expect(transports[0]!.closed).toBe(true);
    expect(transports).toHaveLength(2);
    expect(configs).toEqual([sessionConfig, sessionConfig]);

    // An event from the NEW transport still reaches the pre-reconnect listener.
    transports[1]!.push({ transcription: { transcript: 'after reconnect', isFinal: false } });
    expect(partials).toEqual(['after reconnect']);

    // The stale transport's late event must NOT fold in (its subscription was detached).
    transports[0]!.push({ transcription: { transcript: 'stale', isFinal: false } });
    expect(partials).toEqual(['after reconnect']);
  });

  it('preserves accumulated transcript across a reconnect (no words dropped)', async () => {
    const transports: Array<ReturnType<typeof makeTransport>> = [];
    const connect: SttConnectFactory = async () => {
      const t = makeTransport();
      transports.push(t);
      return t;
    };
    const client = new InworldSttClient({ apiKey: 'k', connect });
    await client.connect(sessionConfig);
    await client.beginTurn('turn-1');

    // A finalized segment captured before the transport dropped.
    transports[0]!.push({ transcription: { transcript: 'before the drop', isFinal: true } });

    // Reconnect must NOT reset the accumulator; resumeTurn re-activates folding.
    await client.reconnect();
    await client.resumeTurn('turn-1');

    // A finalized segment from the NEW transport after the reconnect.
    transports[1]!.push({ transcription: { transcript: 'after the drop', isFinal: true } });

    const result = await client.endTurn({ deadlineMs: 20 });
    expect(result.finalSegments).toEqual(['before the drop', 'after the drop']);
    expect(result.text).toContain('before the drop');
    expect(result.text).toContain('after the drop');
  });
});
