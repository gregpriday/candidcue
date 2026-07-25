/**
 * Does Inworld's streaming STT actually produce words — and does it endpoint?
 *
 * We are replacing OpenAI realtime transcription with Inworld, and the defect
 * this file exists to catch is the same one that cost a full day on the OpenAI
 * path: a healthy socket that transcribes nothing. A connection test, a 200, or
 * a mocked event fixture all pass happily while the pipeline returns silence.
 * Only real audio in and real words out distinguishes the two.
 *
 * The second thing pinned here matters more than the first. On OpenAI with
 * `turn_detection: null` the client had to decide when a turn ended, which
 * meant a browser audio graph, a noise-floor calibration and a speech gate —
 * three separate ways to produce a connected session that heard nothing.
 * Inworld does its own VAD server-side: it emits `speechStarted` /
 * `speechStopped` and returns `isFinal` transcripts from streamed audio with
 * no client commit, no `endTurn`, no local endpointing. The no-commit test
 * below is the one that keeps that guarantee honest. If it ever starts failing
 * while the explicit-`endTurn` test still passes, Inworld has stopped
 * endpointing for us and client-side segmentation is back on the table — which
 * is a decision, not a bug to paper over.
 *
 * Wire details that are not guessable from the docs and were established by
 * probing the live service:
 *   - auth is an `Authorization` HEADER; the API key as a query parameter is
 *     rejected with `authentication is required`, which is what a previous
 *     integration attempt died on
 *   - inbound frames are wrapped in a `result` envelope, EXCEPT errors, which
 *     arrive flat as `{ error: { ... } }`
 *   - outbound audio is base64 under `audioChunk.content`, after a first
 *     `transcribeConfig` frame
 * Each is asserted rather than merely used, so a protocol change reports itself
 * as a named failure instead of an empty transcript.
 *
 * Gated like every live test: `CANDIDCUE_LIVE_INWORLD=1` AND a key. Vitest does
 * not load `.env`, so the key is read from there explicitly — see `readApiKey`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Inworld API key, from the environment or from `.env`.
 *
 * `.env` is gitignored and holds the key for the app; vitest loads no dotenv
 * of its own, so without this the gate below would silently never fire and the
 * suite would report a green "skipped" forever. Returns undefined rather than
 * throwing so the ungated run stays clean on a machine with no key at all.
 */
function readApiKey(): string | undefined {
  const fromEnv = process.env.INWORLD_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const dotenv = readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8');
    const matched = /^\s*INWORLD_API_KEY\s*=\s*(.*)$/m.exec(dotenv)?.[1];
    return matched?.trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

const KEY = readApiKey();
const ENABLED = process.env.CANDIDCUE_LIVE_INWORLD === '1' && Boolean(KEY);

const STREAM_URL = 'wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional';
const SYNC_URL = 'https://api.inworld.ai/stt/v1/transcribe';
const MODEL_ID = 'inworld/inworld-stt-1';

/** 24 kHz mono PCM16, ~9.4 s. See tests/fixtures/audio/README.md. */
const AUDIO = fileURLToPath(
  new URL('../fixtures/audio/quarterly-update-24k-mono.wav', import.meta.url),
);
const SAMPLE_RATE = 24_000;
/** Words the fixture actually says, lowercased for comparison. */
const SPOKEN = 'good morning everyone and welcome to the quarterly update revenue is up';

/**
 * Raw PCM samples from the fixture, with the RIFF header removed.
 *
 * `audioChunk.content` takes base64 PCM, not a WAV container. Parsed rather
 * than hard-coded at offset 44 because a WAV can legally carry extra chunks
 * before `data` — this fixture in fact carries a LIST/INFO chunk — and a
 * fixture regenerated with a different tool would otherwise silently lose its
 * first fraction of a second.
 */
function pcmFromWav(path: string): Buffer {
  const wav = readFileSync(path);
  expect(wav.subarray(0, 4).toString('ascii'), 'fixture must be RIFF').toBe('RIFF');
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in the audio fixture');
}

interface StreamRun {
  /** Interim transcripts, in arrival order. */
  partials: string[];
  /** Completed transcripts — the ones the app would commit to a ledger. */
  finals: string[];
  /** Server-side VAD verdicts, by envelope key. */
  vadEvents: string[];
  /** Provider errors, so a failure says which rather than just "nothing". */
  errors: string[];
  /** ms from the first audio byte to the first interim transcript. */
  msToFirstPartial: number | null;
  /** ms from the first audio byte to the first `isFinal` transcript. */
  msToFirstFinal: number | null;
}

/**
 * Stream the fixture to Inworld and collect what comes back.
 *
 * `endTurn` chooses whether to signal the turn boundary explicitly. The
 * interesting run is the one that does NOT: it proves the server endpoints on
 * its own, which is the whole reason for choosing this provider.
 *
 * `trailingSilenceMs` is not padding for its own sake — server-side VAD decides
 * speech has stopped by observing silence, and a client that simply stops
 * sending gives it nothing to observe. A live microphone always supplies this;
 * a fixture that ends at the last syllable does not.
 */
async function transcribeFixture(options: {
  endTurn: boolean;
  trailingSilenceMs: number;
}): Promise<StreamRun> {
  const speech = pcmFromWav(AUDIO);
  const silence = Buffer.alloc(Math.round((SAMPLE_RATE * 2 * options.trailingSilenceMs) / 1000));
  const pcm = Buffer.concat([speech, silence]);

  const run: StreamRun = {
    partials: [],
    finals: [],
    vadEvents: [],
    errors: [],
    msToFirstPartial: null,
    msToFirstFinal: null,
  };

  return new Promise<StreamRun>((resolve) => {
    // The key travels as a header. As a query parameter the service answers
    // `authentication is required` — verified against the live endpoint, and
    // the failure a previous integration attempt spent a day inside.
    const ws = new WebSocket(STREAM_URL, {
      headers: { Authorization: `Basic ${KEY}` },
    } as unknown as string[]);

    let firstAudioAt = 0;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(run);
    };

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          transcribeConfig: {
            modelId: MODEL_ID,
            audioEncoding: 'LINEAR16',
            sampleRateHertz: SAMPLE_RATE,
            language: 'en-US',
          },
        }),
      );

      // 100 ms per frame, roughly what a browser capture graph emits. Pushed
      // as fast as the socket takes them rather than paced in real time: this
      // test is about whether words come back and whether the server
      // endpoints, and a 9.4 s wall-clock wait per case buys neither.
      const bytesPerFrame = SAMPLE_RATE * 2 * 0.1;
      firstAudioAt = Date.now();
      for (let at = 0; at < pcm.length; at += bytesPerFrame) {
        ws.send(
          JSON.stringify({
            audioChunk: { content: pcm.subarray(at, at + bytesPerFrame).toString('base64') },
          }),
        );
      }
      if (options.endTurn) ws.send(JSON.stringify({ endTurn: {} }));
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      const since = Date.now() - firstAudioAt;
      let parsed: {
        error?: { message?: string };
        result?: {
          transcription?: { transcript?: string; isFinal?: boolean };
          speechStarted?: unknown;
          speechStopped?: unknown;
        };
      };
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      // Errors are NOT wrapped in `result`; everything else is.
      if (parsed.error) {
        run.errors.push(parsed.error.message ?? 'unspecified provider error');
        return;
      }
      const body = parsed.result;
      if (!body) return;

      if (body.speechStarted) run.vadEvents.push('speechStarted');
      if (body.speechStopped) run.vadEvents.push('speechStopped');

      const transcript = body.transcription?.transcript;
      if (typeof transcript !== 'string') return;
      if (body.transcription?.isFinal) {
        run.msToFirstFinal ??= since;
        run.finals.push(transcript);
        done();
      } else {
        run.msToFirstPartial ??= since;
        run.partials.push(transcript);
      }
    });

    ws.addEventListener('error', () => done());
    ws.addEventListener('close', () => done());
    // Long enough for a ~9 s clip plus endpointing, short enough to fail rather
    // than hang a suite.
    setTimeout(done, 30_000);
  });
}

/** How much of the fixture's spoken text a transcript actually recovered. */
function wordRecall(heard: string): number {
  const normalised = heard.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const expected = SPOKEN.split(' ');
  return expected.filter((word) => normalised.includes(word)).length / expected.length;
}

describe.skipIf(!ENABLED)('Inworld streaming STT turns real speech into real words', () => {
  it('transcribes with NO client commit, because the server endpoints', async () => {
    /*
     * The load-bearing test. No `endTurn`, no commit, no local speech gate —
     * only audio and the trailing silence a real microphone would produce.
     * A final transcript here means turn detection is the provider's problem,
     * which is precisely what we are buying.
     */
    const run = await transcribeFixture({ endTurn: false, trailingSilenceMs: 2_500 });

    expect(
      run.finals.length,
      `no final transcript without a client commit. errors: ${JSON.stringify(run.errors)}`,
    ).toBeGreaterThan(0);

    const heard = run.finals.join(' ');
    // Not an exact match: recognisers punctuate, capitalise and digit-ise
    // differently ("fifteen" vs "15") and that is not what this is testing.
    // Enough overlap to prove these are the fixture's words and not somebody
    // else's audio.
    expect(wordRecall(heard), `heard "${heard}" — expected most of "${SPOKEN}"`).toBeGreaterThan(
      0.7,
    );

    // The server said so itself, rather than us inferring endpointing from a
    // transcript that might have arrived for some other reason.
    expect(run.vadEvents, 'server-side VAD should report both edges').toContain('speechStarted');
    expect(run.vadEvents).toContain('speechStopped');
  }, 45_000);

  it('emits interim transcripts long before the final one', async () => {
    /*
     * The rail updates as someone speaks, so partials are a product
     * requirement and not a curiosity. This also pins the `isFinal` flag as
     * the partial/final discriminator — if the provider ever marked every
     * frame final, the UI would commit half-sentences to the ledger.
     */
    const run = await transcribeFixture({ endTurn: true, trailingSilenceMs: 0 });

    expect(
      run.partials.length,
      `no interim transcripts. errors: ${JSON.stringify(run.errors)}`,
    ).toBeGreaterThan(1);
    expect(run.finals.length, 'an explicit endTurn must produce a final').toBeGreaterThan(0);
    expect(run.msToFirstPartial).not.toBeNull();
    expect(run.msToFirstFinal).not.toBeNull();
    expect(
      run.msToFirstPartial!,
      'the first partial must precede the first final',
    ).toBeLessThanOrEqual(run.msToFirstFinal!);

    // Partials grow toward the final rather than being independent fragments,
    // which is what lets the UI replace rather than append.
    const last = run.partials[run.partials.length - 1]!;
    expect(run.finals[0]!.length).toBeGreaterThanOrEqual(last.length - 1);
  }, 45_000);

  it('rejects the key as a query parameter, so nobody "simplifies" the header away', async () => {
    /*
     * The regression this whole file was born from. Inworld's own docs have
     * described query-parameter auth; the service does not accept it, and the
     * failure looks like a socket that opens fine and returns nothing useful.
     * Pinned as a negative so the next person to "clean up" the header sees
     * why it is there.
     */
    const errors = await new Promise<string[]>((resolve) => {
      const collected: string[] = [];
      const ws = new WebSocket(`${STREAM_URL}?key=${encodeURIComponent(KEY!)}`);
      const finish = (): void => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve(collected);
      };
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            transcribeConfig: {
              modelId: MODEL_ID,
              audioEncoding: 'LINEAR16',
              sampleRateHertz: SAMPLE_RATE,
              language: 'en-US',
            },
          }),
        );
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        const parsed = JSON.parse(String(event.data)) as { error?: { message?: string } };
        if (parsed.error?.message) collected.push(parsed.error.message);
        finish();
      });
      ws.addEventListener('error', () => finish());
      ws.addEventListener('close', () => finish());
      setTimeout(finish, 15_000);
    });

    // Never interpolate the key into a message; the URL above is the only
    // place it appears and it does not survive into the assertion.
    expect(errors.join(' ')).toMatch(/authentication/i);
  }, 20_000);

  it('transcribes the whole clip in one shot over the sync REST endpoint', async () => {
    /*
     * The batch path, kept because it is the cheapest possible answer to "is
     * the key good and is the service up?" when a streaming failure could be
     * either. It also documents the request shape: the config key is
     * `transcribeConfig` and the audio key is `audioData` — send `audio` and
     * the service answers `audio_data is required`, which reads like a missing
     * field rather than a misnamed one.
     *
     * Note the asymmetry with the stream, which is the trap here: this
     * endpoint wants the WAV CONTAINER, while `audioChunk.content` wants
     * headerless PCM. Feeding it the same bare samples the stream takes
     * returns a 500 "proxy has failed to process your request" — an error that
     * says nothing about the actual cause, so it is pinned by the fact that
     * this test sends the whole file.
     */
    const container = readFileSync(AUDIO);
    const response = await fetch(SYNC_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcribeConfig: {
          modelId: MODEL_ID,
          audioEncoding: 'LINEAR16',
          sampleRateHertz: SAMPLE_RATE,
          language: 'en-US',
        },
        audioData: { content: container.toString('base64') },
      }),
    });

    expect(response.status, 'sync transcription should succeed').toBe(200);
    const payload = (await response.json()) as {
      transcription?: { transcript?: string; isFinal?: boolean };
    };
    const heard = payload.transcription?.transcript ?? '';
    expect(wordRecall(heard), `heard "${heard}" — expected most of "${SPOKEN}"`).toBeGreaterThan(
      0.7,
    );
  }, 45_000);
});
