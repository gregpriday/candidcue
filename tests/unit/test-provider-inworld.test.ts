import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function makeFakeAdapters(overrides?: {
  connect?: () => Promise<void>;
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
      getKey: () => 'inworld-key',
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
    const fakes = makeFakeAdapters();
    buildInworldAdapters.mockReturnValue(fakes);

    const result = await makeController().testProvider('inworld');

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/TTS and STT/i);
    // Both surfaces were genuinely exercised, not just the key presence.
    expect(fakes.tts.synthesize).toHaveBeenCalledTimes(1);
    expect(fakes.stt.connect).toHaveBeenCalledTimes(1);
    // The socket is opened then immediately closed — a successful probe must not
    // leak a live STT connection.
    expect(fakes.stt.close).toHaveBeenCalledTimes(1);
    // The STT model is configured from the shared defaults, not hard-coded.
    expect(buildInworldAdapters).toHaveBeenCalledWith('inworld-key', INWORLD_DEFAULTS.sttModel);
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
});
