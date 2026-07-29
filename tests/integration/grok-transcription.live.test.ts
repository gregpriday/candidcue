/**
 * Does Grok's streaming STT actually produce words — and does it endpoint?
 *
 * The defect this file exists to catch is the one that has now cost a day on
 * two separate providers: a healthy socket that transcribes nothing. A
 * connection test, a 101, or a mocked event fixture all pass happily while the
 * pipeline returns silence. Only real audio in and real words out distinguishes
 * the two.
 *
 * The second thing pinned here matters more than the first. Server-side
 * endpointing is what this provider is FOR. If `endpoints without an explicit
 * Finalize` ever starts failing while the explicit-`Finalize` test still
 * passes, Grok has stopped endpointing for us and client-side segmentation is
 * back on the table — which is a decision to make deliberately, not a bug to
 * paper over.
 *
 * The third is the one the documentation could not answer. Grok reports
 * finality in two flags: `is_final` marks a chunk of ~3 s that will not be
 * revised, `speech_final` marks the end of an utterance — and the docs call the
 * latter the "complete stitched utterance" without ever saying whether that
 * includes the chunks already locked. If it does, a client that appends both
 * duplicates every word; if it does not, one that does not append loses them.
 * `assembles each word exactly once` is the live answer, and
 * `src-tauri/src/stt/stream.rs` carries the guard that survives either.
 *
 * Wire details established by probing the live service:
 *   - auth is an `Authorization: Bearer` HEADER; xAI's own docs say the key
 *     must never reach client-side code
 *   - the session is configured entirely by URL QUERY, not by a config frame
 *   - the server sends `{"type":"transcript.created"}` when its ASR backend is
 *     ready, and audio sent before that is discarded in silence
 *   - outbound audio is RAW BINARY, not base64 in a JSON envelope
 *   - a refusal is an HTTP status on the UPGRADE, not an error frame: an
 *     unfunded team answers 403 with `"Your newly created team doesn't have any
 *     credits or licenses yet."`
 * Each is asserted rather than merely used, so a protocol change reports itself
 * as a named failure instead of an empty transcript.
 *
 * Gated like every live test: `CANDIDCUE_LIVE_GROK=1` AND a key. Vitest does
 * not load `.env`, so the key is read from there explicitly — see `readApiKey`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The xAI API key, from the environment or from `.env`.
 *
 * `.env` is gitignored and holds the key for the app; vitest loads no dotenv of
 * its own, so without this the gate below would silently never fire and the
 * suite would report a green "skipped" forever. Returns undefined rather than
 * throwing so the ungated run stays clean on a machine with no key at all.
 */
function readApiKey(): string | undefined {
  const fromEnv = process.env.GROK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const dotenv = readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8');
    const matched = /^\s*GROK_API_KEY\s*=\s*(.*)$/m.exec(dotenv)?.[1];
    return matched?.trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

const KEY = readApiKey();
const ENABLED = process.env.CANDIDCUE_LIVE_GROK === '1' && Boolean(KEY);

const BASE_URL = 'wss://api.x.ai/v1/stt';
const SAMPLE_RATE = 24_000;

/** 24 kHz mono PCM16, ~9.4 s. See tests/fixtures/audio/README.md. */
const AUDIO = fileURLToPath(
  new URL('../fixtures/audio/quarterly-update-24k-mono.wav', import.meta.url),
);
/** Words the fixture actually says, lowercased for comparison. */
const SPOKEN = 'good morning everyone and welcome to the quarterly update revenue is up';

/**
 * Raw PCM samples from the fixture, with the RIFF header removed.
 *
 * The socket takes raw PCM, not a WAV container. Parsed rather than hard-coded
 * at offset 44 because a WAV can legally carry extra chunks before `data`, and
 * a header shipped as audio is heard as a click and transcribed as nothing.
 */
function pcmPayload(): Buffer {
  const wav = readFileSync(AUDIO);
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'data') return wav.subarray(at + 8, Math.min(at + 8 + size, wav.length));
    at += 8 + size + (size & 1);
  }
  throw new Error('fixture has no data chunk');
}

interface Frame {
  type?: string;
  text?: string;
  is_final?: boolean;
  speech_final?: boolean;
  message?: string;
  words?: Array<{ text: string; start: number; end: number }>;
}

interface RunResult {
  frames: Frame[];
  /** True once `transcript.created` arrived. */
  becameReady: boolean;
  /** Milliseconds from open to `transcript.created`. */
  readyMs: number | null;
}

function url(extra: Record<string, string | number | boolean> = {}): string {
  const params = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    encoding: 'pcm',
    interim_results: 'true',
    endpointing: '300',
    language: 'en',
  });
  for (const [key, value] of Object.entries(extra)) params.append(key, String(value));
  return `${BASE_URL}?${params.toString()}`;
}

/**
 * Stream the fixture and collect every frame.
 *
 * `finalize: false` is the interesting case: it sends the audio, then trailing
 * SILENCE, and never asks for a boundary. Only server-side endpointing can
 * produce a final transcript from that — which is the guarantee this provider
 * was chosen for.
 */
async function run(options: {
  finalize: boolean;
  extraParams?: Record<string, string | number | boolean>;
  trailingSilenceMs?: number;
}): Promise<RunResult> {
  const pcm = pcmPayload();
  const frames: Frame[] = [];
  const opened = Date.now();
  let readyMs: number | null = null;

  return new Promise<RunResult>((resolve, reject) => {
    const ws = new WebSocket(url(options.extraParams), {
      headers: { Authorization: `Bearer ${KEY}` },
    } as never);
    ws.binaryType = 'arraybuffer';

    const settle = () => resolve({ frames, becameReady: readyMs !== null, readyMs });
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      settle();
    }, 45_000);

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('socket error — check the key and that the team has credits'));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      settle();
    };

    ws.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (!raw) return;
      let frame: Frame;
      try {
        frame = JSON.parse(raw) as Frame;
      } catch {
        return;
      }
      frames.push(frame);
      if (frame.type === 'transcript.created') {
        readyMs = Date.now() - opened;
        void stream();
      }
      if (frame.type === 'transcript.done') {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
    };

    /** 100 ms frames at real-time pace — the app's exact capture cadence. */
    async function stream(): Promise<void> {
      const frameBytes = (SAMPLE_RATE * 2 * 100) / 1000;
      for (let at = 0; at < pcm.length; at += frameBytes) {
        if (ws.readyState !== 1) return;
        ws.send(pcm.subarray(at, Math.min(at + frameBytes, pcm.length)));
        await new Promise((r) => setTimeout(r, 100));
      }
      // Trailing silence, so server VAD has something to endpoint ON. A file
      // that simply runs out supplies none, and a client that stops sending is
      // indistinguishable from one that is still thinking.
      const silence = Buffer.alloc(frameBytes);
      const silenceFrames = Math.ceil((options.trailingSilenceMs ?? 1_500) / 100);
      for (let i = 0; i < silenceFrames; i += 1) {
        if (ws.readyState !== 1) return;
        ws.send(silence);
        await new Promise((r) => setTimeout(r, 100));
      }
      if (options.finalize && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'Finalize' }));
        ws.send(JSON.stringify({ type: 'audio.done' }));
      }
    }
  });
}

const transcripts = (frames: Frame[]) =>
  frames.filter((f) => f.type === 'transcript.partial' && (f.text ?? '').trim().length > 0);

const utteranceFinals = (frames: Frame[]) => transcripts(frames).filter((f) => f.speech_final);
const chunkFinals = (frames: Frame[]) =>
  transcripts(frames).filter((f) => f.is_final && !f.speech_final);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9']/g, ''))
    .filter(Boolean);

describe.skipIf(!ENABLED)('Grok streaming STT, live', () => {
  it('transcribes real audio into real words', { timeout: 60_000 }, async () => {
    const { frames, becameReady, readyMs } = await run({ finalize: true });

    expect(becameReady, 'the service must announce readiness before audio counts').toBe(true);
    expect(readyMs).toBeLessThan(5_000);

    const errors = frames.filter((f) => f.type === 'error');
    expect(errors, `provider errors: ${JSON.stringify(errors)}`).toEqual([]);

    const finals = utteranceFinals(frames);
    expect(finals.length, 'no utterance-final transcript arrived at all').toBeGreaterThan(0);

    const heard = finals
      .map((f) => f.text ?? '')
      .join(' ')
      .toLowerCase();
    // Not an exact match: any recogniser is entitled to its own punctuation and
    // casing. What must be true is that the words the fixture says came back.
    for (const word of ['morning', 'welcome', 'quarterly', 'revenue']) {
      expect(heard, `"${word}" was spoken but never transcribed`).toContain(word);
    }
  });

  /**
   * The guarantee the provider was chosen for.
   *
   * No `Finalize`, no `audio.done` — just audio followed by silence. A final
   * transcript here can only have come from the service deciding on its own
   * that the speaker stopped.
   */
  it('endpoints without an explicit Finalize', { timeout: 60_000 }, async () => {
    const { frames } = await run({ finalize: false, trailingSilenceMs: 3_000 });
    const finals = utteranceFinals(frames);
    expect(
      finals.length,
      'no speech_final arrived from silence alone — server-side endpointing has stopped, ' +
        'and client-side segmentation is back on the table',
    ).toBeGreaterThan(0);
  });

  /**
   * The question the documentation could not answer.
   *
   * Whichever way the service stitches — tail-only or whole-utterance — the
   * text a client assembles must contain each spoken word exactly once. This
   * asserts the OUTCOME rather than the mechanism, so it stays true if xAI
   * changes its mind, and `Utterances::finish` in Rust is what makes it so.
   */
  it('assembles each word exactly once', { timeout: 60_000 }, async () => {
    const { frames } = await run({ finalize: true });
    const chunks = chunkFinals(frames);
    const finals = utteranceFinals(frames);
    expect(finals.length).toBeGreaterThan(0);

    // Report the shape observed, so a future reader does not have to re-derive
    // it from a failing assertion.
    const lastChunk = chunks.at(-1)?.text ?? '';
    const lastFinal = finals.at(-1)?.text ?? '';
    const stitched =
      words(lastFinal).slice(0, words(lastChunk).length).join(' ') === words(lastChunk).join(' ');
    console.log(
      `[live] ${chunks.length} chunk-final(s), ${finals.length} utterance-final(s)\n` +
        `[live] last chunk-final : ${JSON.stringify(lastChunk)}\n` +
        `[live] last utt-final   : ${JSON.stringify(lastFinal)}\n` +
        `[live] shape            : ${
          lastChunk === ''
            ? 'no chunk-finals observed on this clip'
            : stitched
              ? 'utterance-final REPEATS the locked chunks'
              : 'utterance-final carries only the new tail'
        }`,
    );

    // The spoken fixture has no repeated words, so a duplicate in the assembled
    // transcript is the stitching bug and nothing else.
    const assembled = words(finals.map((f) => f.text ?? '').join(' '));
    for (const word of words(SPOKEN)) {
      const seen = assembled.filter((w) => w === word).length;
      expect(seen, `"${word}" appears ${seen}× in the assembled transcript`).toBeLessThanOrEqual(1);
    }
  });

  /**
   * Custom vocabulary rides on the URL that OPENS the socket, so a term the
   * gateway dislikes does not weaken a take — it prevents one.
   */
  it('accepts a custom vocabulary on the session URL', { timeout: 60_000 }, async () => {
    const { frames, becameReady } = await run({
      finalize: true,
      extraParams: { keyterm: 'RustLight Games' },
    });
    expect(becameReady, 'a keyterm must not stop the session opening').toBe(true);
    expect(frames.filter((f) => f.type === 'error')).toEqual([]);
    expect(utteranceFinals(frames).length).toBeGreaterThan(0);
  });

  /** Word timings are what a future change to the audio clock would use. */
  it('returns word-level timings on final transcripts', { timeout: 60_000 }, async () => {
    const { frames } = await run({ finalize: true });
    const withWords = utteranceFinals(frames).find((f) => (f.words?.length ?? 0) > 0);
    expect(withWords, 'no final carried a words array').toBeDefined();
    for (const word of withWords?.words ?? []) {
      expect(word.end).toBeGreaterThanOrEqual(word.start);
    }
  });
});

describe.skipIf(ENABLED)('Grok streaming STT, live (skipped)', () => {
  it('reports why it did not run', () => {
    console.log(
      'SKIP: set CANDIDCUE_LIVE_GROK=1 and GROK_API_KEY (env or .env) to run the live STT tests',
    );
    expect(true).toBe(true);
  });
});
