import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The Inworld health check must exercise BOTH provider surfaces — the TTS HTTP
// round-trip and the streaming STT WebSocket — so a green preflight can't hide a
// broken half (issue #68). These tests pin that behaviour at the `testProvider`
// boundary by mocking the adapter factory, so no real socket or HTTP call runs.
const { buildInworldAdapters, buildOpenAiAdapters } = vi.hoisted(() => ({
  buildInworldAdapters: vi.fn(),
  buildOpenAiAdapters: vi.fn(),
}));

vi.mock('@main/providers/factory', () => ({ buildInworldAdapters, buildOpenAiAdapters }));

import { AppController } from '@main/app-controller';
import { NOOP_LOGGER } from '@main/interview/ports';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';

const EXPECTED_STT_PROBE = {
  sampleRate: 16000,
  channels: 1,
  model: INWORLD_DEFAULTS.sttModel,
  interimResults: false,
};

function makeFakeAdapters(overrides?: {
  connect?: (config?: unknown, signal?: AbortSignal) => Promise<void>;
  synthesize?: () => Promise<unknown>;
}) {
  const stt = {
    connect: vi.fn(overrides?.connect ?? (async () => {})),
    close: vi.fn(async () => {}),
  };
  const tts = {
    synthesize: vi.fn(overrides?.synthesize ?? (async () => ({ audio: new ArrayBuffer(0) }))),
  };
  return { stt, tts };
}

function makeController(): AppController {
  return new AppController({
    repository: {
      // Voice id resolution falls back to the bundled Mira character, so null here
      // is fine — the probe never depends on a real stored voice id.
      getSetting: async () => null,
    } as never,
    credentials: {
      getKey: () => 'provider-key',
    } as never,
    logger: NOOP_LOGGER,
    videosRoot: '',
    getControl: () => null,
    getStage: () => null,
    ensureStageWindow: () => {
      throw new Error('stage window must not be opened during a provider health check');
    },
    isDisplayConnected: () => true,
  });
}

describe('testProvider("inworld") STT probe (issue #68)', () => {
  beforeEach(() => {
    buildInworldAdapters.mockReset();
    buildOpenAiAdapters.mockReset();
  });

  it('exercises both TTS and STT, then closes the STT socket, on success', async () => {
    const order: string[] = [];
    const fakes = makeFakeAdapters({
      connect: async () => {
        order.push('stt.connect');
      },
    });
    fakes.tts.synthesize.mockImplementation(async () => {
      order.push('tts.synthesize');
      return { audio: new ArrayBuffer(0) };
    });
    buildInworldAdapters.mockReturnValue(fakes);

    const result = await makeController().testProvider('inworld');

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/TTS and STT/i);
    // Both surfaces were genuinely exercised, not just the key presence — and TTS
    // runs first so a TTS failure short-circuits before any socket is opened.
    expect(order).toEqual(['tts.synthesize', 'stt.connect']);
    // The probe opens with the exact streaming config and a cancellation signal,
    // then closes immediately so a successful probe never leaks a live socket.
    expect(fakes.stt.connect).toHaveBeenCalledTimes(1);
    expect(fakes.stt.connect).toHaveBeenCalledWith(EXPECTED_STT_PROBE, expect.any(AbortSignal));
    expect(fakes.stt.close).toHaveBeenCalledTimes(1);
    // The STT model is configured from the shared defaults, not hard-coded.
    expect(buildInworldAdapters).toHaveBeenCalledWith('provider-key', INWORLD_DEFAULTS.sttModel);
  });

  it('fails the health check with an STT-specific message when the socket cannot open, and still closes it', async () => {
    const fakes = makeFakeAdapters({
      connect: async () => {
        throw new Error('auth denied');
      },
    });
    buildInworldAdapters.mockReturnValue(fakes);

    const result = await makeController().testProvider('inworld');

    expect(result.ok).toBe(false);
    // A bare WebSocket error would surface as "Something went wrong."; the probe
    // re-throws a typed AppError so the preflight screen names the STT surface.
    expect(result.message).toMatch(/STT connection failed/i);
    // close() runs in a finally, so a failed connect never leaks a half-open socket.
    expect(fakes.stt.close).toHaveBeenCalledTimes(1);
  });

  it('does not attempt the STT probe when the TTS round-trip fails', async () => {
    const fakes = makeFakeAdapters({
      synthesize: async () => {
        throw new Error('tts failed');
      },
    });
    buildInworldAdapters.mockReturnValue(fakes);

    const result = await makeController().testProvider('inworld');

    expect(result.ok).toBe(false);
    // TTS fails first, so the STT socket is never opened and never needs closing.
    expect(fakes.stt.connect).not.toHaveBeenCalled();
    expect(fakes.stt.close).not.toHaveBeenCalled();
  });

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('aborts the STT connect after the deadline so a stalled handshake fails the check', async () => {
      // A connect that never resolves on its own — it only settles when the
      // probe's AbortController fires, proving the deadline actually cancels the
      // socket rather than racing a fire-and-forget timer.
      const fakes = makeFakeAdapters({
        connect: (_config, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      });
      buildInworldAdapters.mockReturnValue(fakes);

      const resultPromise = makeController().testProvider('inworld');
      await vi.advanceTimersByTimeAsync(8000);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/STT connection failed/i);
      expect(fakes.stt.close).toHaveBeenCalledTimes(1);
    });
  });
});

describe('testProvider("openai") is unaffected by the Inworld STT probe (issue #68)', () => {
  beforeEach(() => {
    buildInworldAdapters.mockReset();
    buildOpenAiAdapters.mockReset();
  });

  it('still reports the generic success message and never builds Inworld adapters', async () => {
    buildOpenAiAdapters.mockReturnValue({ moderation: { moderate: vi.fn(async () => {}) } });

    const result = await makeController().testProvider('openai');

    // The shared `message` variable defaults to the generic string and the OpenAI
    // branch never overwrites it — the STT-probe refactor must not change this.
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Credentials look valid.');
    expect(buildInworldAdapters).not.toHaveBeenCalled();
  });
});
