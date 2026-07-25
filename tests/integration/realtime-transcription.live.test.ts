/**
 * Does audio in produce words out? Against the real API, with real speech.
 *
 * A take connected cleanly — SDP 201, ICE connected, data channel open,
 * session config accepted — and transcribed nothing. "Words heard: 0." Every
 * test in this repo up to now fed the transcription pipeline *fixtures of
 * provider events*: they prove the adapter, the ledger and the aligner handle
 * a transcript correctly, and none of them can tell you whether a transcript
 * ever arrives. The one link nothing covered is the one that broke.
 *
 * So this sends known audio to the real service and asserts on the words that
 * come back. It uses the WebSocket transport rather than WebRTC for the same
 * reason `realtime-session-config.live.test.ts` does: same protocol, same
 * events, same `session.update`, no browser peer connection or live
 * microphone needed. What it cannot cover is the browser's capture and
 * encoding — but it draws a hard line under everything after that, so a
 * failure is on one side of it or the other instead of anywhere at all.
 *
 * The commit strategy is the specific thing worth pinning. The app runs with
 * `turn_detection: null` (§29.3): the SERVER does no endpointing, and audio is
 * only transcribed when the client sends `input_audio_buffer.commit`. A
 * pipeline that streams audio perfectly and never commits produces exactly
 * what was observed — a healthy connection and total silence — so the first
 * test drives that path explicitly and the second proves the negative.
 *
 * Gated like every live test: `CANDIDCUE_LIVE_OPENAI=1` AND a key.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildSessionUpdateEvent,
  DEFAULT_TRANSCRIPTION_CONFIG,
} from '../../src/control/services/realtime/sessionConfig';

const KEY = process.env.OPENAI_API_KEY;
const ENABLED = process.env.CANDIDCUE_LIVE_OPENAI === '1' && Boolean(KEY);

const REALTIME_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
/** 24 kHz mono PCM16, ~9.4 s. See tests/fixtures/audio/README.md. */
const AUDIO = fileURLToPath(
  new URL('../fixtures/audio/quarterly-update-24k-mono.wav', import.meta.url),
);
/** Words the fixture actually says, lowercased for comparison. */
const SPOKEN = 'good morning everyone and welcome to the quarterly update revenue is up fifteen percent';

/**
 * Raw PCM samples from the fixture, with the RIFF header removed.
 *
 * `input_audio_buffer.append` takes base64 PCM, not a WAV container — sending
 * the header would be transcribed as 44 bytes of noise at the front. Parsed
 * rather than hard-coded at offset 44 because a WAV can legally carry extra
 * chunks before `data`, and a fixture regenerated with a different tool would
 * then silently lose its first fraction of a second.
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

interface TranscriptionRun {
  /** Every completed transcript the service returned, in arrival order. */
  transcripts: string[];
  /** Provider errors, so a failure says which rather than just "nothing". */
  errors: string[];
}

/**
 * Stream the fixture to the realtime service and collect what comes back.
 *
 * `commit` chooses whether to send `input_audio_buffer.commit` after the
 * audio — the difference between the app's manual-commit strategy working and
 * the failure mode it produces when the commit never fires.
 */
async function transcribeFixture(options: { commit: boolean }): Promise<TranscriptionRun> {
  const pcm = pcmFromWav(AUDIO);
  const run: TranscriptionRun = { transcripts: [], errors: [] };

  return new Promise<TranscriptionRun>((resolve) => {
    const ws = new WebSocket(REALTIME_WS_URL, {
      headers: { Authorization: `Bearer ${KEY}` },
    } as unknown as string[]);

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
      const event = buildSessionUpdateEvent(DEFAULT_TRANSCRIPTION_CONFIG, {});
      ws.send(JSON.stringify(event));

      // 100 ms of audio per frame, which is roughly what the browser transport
      // sends. One giant append would also work but would not resemble the
      // thing under test.
      const bytesPerFrame = 24000 * 2 * 0.1;
      for (let at = 0; at < pcm.length; at += bytesPerFrame) {
        ws.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: pcm.subarray(at, at + bytesPerFrame).toString('base64'),
          }),
        );
      }
      if (options.commit) ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      let parsed: { type?: string; transcript?: string; error?: { message?: string } };
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (parsed.type === 'error') {
        run.errors.push(parsed.error?.message ?? 'unspecified provider error');
        return;
      }
      if (
        typeof parsed.type === 'string' &&
        parsed.type.includes('input_audio_transcription') &&
        parsed.type.endsWith('completed') &&
        typeof parsed.transcript === 'string'
      ) {
        run.transcripts.push(parsed.transcript);
        done();
      }
    });

    ws.addEventListener('error', () => done());
    ws.addEventListener('close', () => done());
    // Long enough for a ~9 s clip plus transcription, short enough to fail
    // rather than hang a suite.
    setTimeout(done, 45_000);
  });
}

describe.skipIf(!ENABLED)('real speech produces real transcripts', () => {
  it('transcribes committed audio into the words that were spoken', async () => {
    const run = await transcribeFixture({ commit: true });

    expect(
      run.transcripts.length,
      `no transcript came back. provider errors: ${JSON.stringify(run.errors)}`,
    ).toBeGreaterThan(0);

    const heard = run.transcripts.join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    // Not an exact match: recognisers punctuate and capitalise differently and
    // that is not what this is testing. Enough overlap to prove these are the
    // words from the fixture and not somebody else's audio.
    const expected = SPOKEN.split(' ');
    const matched = expected.filter((word) => heard.includes(word));
    expect(
      matched.length / expected.length,
      `heard "${heard}" — expected most of "${SPOKEN}"`,
    ).toBeGreaterThan(0.7);
  }, 60_000);

  it('returns NOTHING when the audio is never committed, which is the failure seen', async () => {
    /*
     * The negative that gives the positive its meaning.
     *
     * With `turn_detection: null` the server never decides a turn has ended,
     * so audio streamed without a commit is held and never transcribed. That
     * is not a broken connection, a bad key, or a rejected config — every one
     * of which reports itself — it is a completely healthy session that
     * returns silence, which is precisely what a take reporting "Words heard:
     * 0" over a connected transport looks like.
     *
     * If this ever starts returning transcripts, the server has begun doing
     * its own endpointing and the app's manual commit strategy needs
     * revisiting — so a failure here is informative rather than annoying.
     */
    const run = await transcribeFixture({ commit: false });
    expect(run.transcripts).toHaveLength(0);
  }, 60_000);
});
