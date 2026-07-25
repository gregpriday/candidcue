/**
 * The realtime session config, validated against the real OpenAI API.
 *
 * This is the gap the Rust live tests explicitly could not close. The transport
 * reaches OpenAI over WebRTC, which needs a browser `RTCPeerConnection` and a
 * live audio track, so nothing could ever check the one thing that does not
 * need either: whether the `session.update` the app sends is a payload the
 * service actually accepts.
 *
 * It does not need WebRTC. The realtime service speaks the same protocol over a
 * WebSocket, and `session.update` is the identical event with the identical
 * schema — so the config can be validated end to end from Node, with no audio
 * and no browser. The transport under test is different; the payload is not,
 * and the payload is what was never checked.
 *
 * What that was hiding: `prompt` — the §27.5 vocabulary steering built from a
 * script's dictionary terms — is rejected outright by the configured realtime
 * model:
 *
 *   invalid_value: The 'prompt' parameter is not supported for this model.
 *   param: session.audio.input.transcription.prompt
 *
 * Not ignored, not degraded — a hard error on the event that configures the
 * session, on a connection the user is mid-take on. The production path is
 * already safe, because `vocabularyPromptFor` refuses to build a prompt unless
 * `realtimePromptSteering` says the model takes one and it is false. That guard
 * was written from the spec rather than from the service, though, and nothing
 * anywhere proved the two agreed. These tests are what makes flipping that flag
 * — for this model, or for a model a user selects in Settings — fail here
 * rather than in front of an audience.
 *
 * Gated like every other live test: `CANDIDCUE_LIVE_OPENAI=1` AND a key. The
 * ordinary suite must never open a socket or spend a cent.
 */
import { describe, expect, it } from 'vitest';
import { buildSessionUpdateEvent } from '../../src/control/services/realtime/sessionConfig';
import { DEFAULT_TRANSCRIPTION_CONFIG } from '../../src/control/services/realtime/sessionConfig';

const KEY = process.env.OPENAI_API_KEY;
const ENABLED = process.env.CANDIDCUE_LIVE_OPENAI === '1' && Boolean(KEY);

const REALTIME_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const ATTEMPT_TIMEOUT_MS = 20_000;

interface Verdict {
  accepted: boolean;
  /** Provider text on rejection. Never contains credentials. */
  detail?: string;
  param?: string;
}

/**
 * Open a session, send one `session.update`, and report what the service said.
 *
 * The key is read from the environment and travels only in the `Authorization`
 * header to api.openai.com. Nothing here logs it, and the only provider text
 * that reaches an assertion message is the error `message`/`param`, which
 * carry no credential material.
 */
async function applySessionConfig(session: unknown): Promise<Verdict> {
  return new Promise<Verdict>((resolve) => {
    const ws = new WebSocket(REALTIME_WS_URL, {
      headers: { Authorization: `Bearer ${KEY}` },
      // `headers` is a Node/undici extension to the WHATWG constructor; the
      // browser transport authenticates with an ephemeral secret instead.
    } as unknown as string[]);

    let settled = false;
    const done = (verdict: Verdict) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(verdict);
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'session.update', session }));
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      let parsed: { type?: string; error?: { message?: string; param?: string } };
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (parsed.type === 'error') {
        done({
          accepted: false,
          detail: parsed.error?.message ?? 'unspecified provider error',
          param: parsed.error?.param ?? undefined,
        });
        return;
      }
      // `session.created` arrives first and says nothing about our update; the
      // `.updated` echo is the service confirming it applied the config.
      if (typeof parsed.type === 'string' && parsed.type.endsWith('.updated')) {
        done({ accepted: true });
      }
    });
    ws.addEventListener('error', () => done({ accepted: false, detail: 'websocket error' }));
    ws.addEventListener('close', (event: CloseEvent) =>
      done({ accepted: false, detail: `closed (${event.code})` }),
    );
    setTimeout(() => done({ accepted: false, detail: 'timed out' }), ATTEMPT_TIMEOUT_MS);
  });
}

describe.skipIf(!ENABLED)('the realtime session config the app sends is one OpenAI accepts', () => {
  it('applies the shipped default configuration', async () => {
    // The exact object the transport sends on data-channel open, from the
    // production builder — not a hand-written approximation of it.
    const event = buildSessionUpdateEvent(DEFAULT_TRANSCRIPTION_CONFIG, {});
    const verdict = await applySessionConfig(event.session);
    expect(
      verdict.accepted,
      `the default session config was refused: ${verdict.detail ?? ''} [${verdict.param ?? '-'}]`,
    ).toBe(true);
  }, 30_000);

  it('applies it with logprobs and an explicit language, as a real take does', async () => {
    const event = buildSessionUpdateEvent(
      { ...DEFAULT_TRANSCRIPTION_CONFIG, language: 'en', requestLogprobs: true, delay: 'low' },
      { noiseReduction: 'near_field' },
    );
    const verdict = await applySessionConfig(event.session);
    expect(verdict.accepted, `refused: ${verdict.detail ?? ''} [${verdict.param ?? '-'}]`).toBe(
      true,
    );
  }, 30_000);

  it('refuses a vocabulary prompt on the configured model, which is why the flag is off', async () => {
    /*
     * The assertion that gives `realtimePromptSteering: false` a reason beyond
     * "the spec said so". If OpenAI ever starts accepting `prompt` here this
     * test fails, and the failure is the signal to turn the capability on —
     * which is the only safe way to find that out.
     *
     * Asserted on the SAME builder the app ships, so a change that starts
     * emitting a prompt unconditionally is caught here rather than by a
     * presenter losing a take.
     */
    const event = buildSessionUpdateEvent(DEFAULT_TRANSCRIPTION_CONFIG, {
      vocabularyPrompt: 'CandidCue, Priday, SiteOrigin.',
    });
    const verdict = await applySessionConfig(event.session);

    expect(verdict.accepted, 'if this now passes, `realtimePromptSteering` can be enabled').toBe(
      false,
    );
    expect(verdict.param).toBe('session.audio.input.transcription.prompt');
  }, 30_000);

  it('is a real check: the builder does put the prompt where the service rejects it', () => {
    // Guards the guard. If `buildSessionUpdateEvent` stopped emitting `prompt`
    // altogether, the rejection test above would pass vacuously — it would be
    // asserting that a config with no prompt is refused for some other reason.
    const withPrompt = buildSessionUpdateEvent(DEFAULT_TRANSCRIPTION_CONFIG, {
      vocabularyPrompt: 'CandidCue.',
    });
    const session = withPrompt.session as {
      audio: { input: { transcription: Record<string, unknown> } };
    };
    expect(session.audio.input.transcription['prompt']).toBe('CandidCue.');

    const without = buildSessionUpdateEvent(DEFAULT_TRANSCRIPTION_CONFIG, {});
    const bare = without.session as {
      audio: { input: { transcription: Record<string, unknown> } };
    };
    expect(bare.audio.input.transcription['prompt']).toBeUndefined();
  });
});
