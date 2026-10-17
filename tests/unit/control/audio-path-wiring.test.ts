/**
 * The audio path is wired end to end, not merely implemented.
 *
 * This project's signature defect is a finished mechanism with no production
 * caller, and it is invisible to an ordinary suite: the unit tests call the
 * method directly and pass, while in the running app nothing does. The
 * speech-to-text rewrite is dense with exactly that risk, because every link is
 * individually testable and the chain is only exercised by a live take with a
 * real microphone:
 *
 *   capture → forwardFrame → push_transcription_audio → Rust
 *   stt://event → handleSttFrame → transcript record + UI
 *                 (and, inside Rust, → the alignment engine)
 *
 * Break any arrow and the app connects, bills, and transcribes nothing — the
 * failure that cost this project a full day twice. A behavioural test cannot
 * catch it, because each half behaves correctly *when something calls it*. What
 * has to be asserted is that something in production does, so these are source
 * assertions.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const PIPELINE = source('../../../src/control/services/voice-session.ts');
const CAPTURE = source('../../../src/control/services/audio/capture.ts');
const STORE = source('../../../src/control/stores/session.ts');
const DRIVER = source('../../../src/control/services/session.ts');
const STT_STREAM = source('../../../src-tauri/src/speech/session.rs');
const VOICE_LIVE = source('../../../src/control/services/voice-live.ts');
const SEND_QUEUE = source('../../../src/control/services/audio/send-queue.ts');

/** Strip comments, so a mention in prose can never satisfy a call-site check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('captured audio reaches the provider', () => {
  it('the capture graph is started with the session stream', () => {
    const body = code(PIPELINE);
    expect(/new PcmCapture\(/.test(body), 'the pipeline must build a PCM tap').toBe(true);
    expect(
      /capture\.start\(/.test(body),
      'a PcmCapture that is constructed and never started is a take that sends silence',
    ).toBe(true);
  });

  it('every captured frame is forwarded, not just counted', () => {
    const body = code(PIPELINE);
    expect(/onFrame:\s*\(samples\)\s*=>\s*this\.forwardFrame\(samples\)/.test(body)).toBe(true);
    expect(
      /pushTranscriptionAudio\(/.test(body),
      'forwardFrame must actually invoke the Rust command',
    ).toBe(true);
  });

  it('both callers push through the bounded queue, not an open-ended chain (#288)', () => {
    /*
     * A chain of `.then` hops is unbounded: a push that never settles holds
     * every frame after it, and none of them is counted anywhere. The take and
     * the microphone test both hand frames to `AudioSendQueue` instead, which
     * is only a fix if each of them actually does.
     */
    for (const [caller, text] of [
      ['the take', PIPELINE],
      ['the microphone test', VOICE_LIVE],
    ] as const) {
      const body = code(text);
      expect(/new AudioSendQueue\(/.test(body), `${caller} must build the queue`).toBe(true);
      expect(/sender\?\.enqueue\(/.test(body), `${caller} must feed it`).toBe(true);
      expect(
        /\.then\(\(\) => pushTranscriptionAudio\(/.test(body),
        `${caller} must not chain pushes past the bound`,
      ).toBe(false);
    }
  });

  it('the processor callback is connected to a destination', () => {
    /*
     * A WKWebView audio graph with no path to `destination` is not guaranteed
     * to be PULLED, so `onaudioprocess` may simply never fire — a microphone
     * that is open, healthy, and delivering nothing. The zero-gain hop is what
     * makes the graph render without playing the presenter back into the room.
     */
    const body = code(CAPTURE);
    expect(/processor\.connect\(gain\)/.test(body)).toBe(true);
    expect(/gain\.connect\(context\.destination\)/.test(body)).toBe(true);
    expect(/gain\.gain\.value\s*=\s*0/.test(body)).toBe(true);
  });

  it('a suspended AudioContext is resumed', () => {
    // A context constructed `suspended` measures silence forever, which is
    // indistinguishable from a presenter who never spoke.
    expect(/context\.state === 'suspended'/.test(code(CAPTURE))).toBe(true);
    expect(/context\.resume\(\)/.test(code(CAPTURE))).toBe(true);
  });
});

describe('provider frames reach the aligner', () => {
  it('the pipeline subscribes to the Rust event channel', () => {
    const body = code(PIPELINE);
    expect(/listen<SttFrame>\(STT_EVENT/.test(body), 'nothing subscribes to stt://event').toBe(
      true,
    );
    expect(
      /this\.handleSttFrame\(event\.payload\)/.test(body),
      'the subscription must drive handleSttFrame — a listener that discards its ' +
        'payload is a session that hears everything and reports nothing',
    ).toBe(true);
  });

  it('a final reaches both the transcript bar and the tail', () => {
    const body = code(PIPELINE);
    // Both, not either: the bar and the visible tail are separate consumers,
    // and a final that reaches one but not the other is a take whose two
    // readouts disagree.
    expect(/this\.deps\.onTranscriptText\(frame\.text, true\)/.test(body)).toBe(true);
    expect(/this\.deps\.onTranscriptLine\(text\)/.test(body)).toBe(true);
  });

  /*
   * The alignment engine is fed by RUST, from the same socket, so there is no
   * control-side hop for transcripts to fall down any more. What control still
   * has to do is hand the engine a script — and a take that never does is
   * exactly the "words heard, nothing followed" failure in a new costume.
   */
  it('the session store starts an alignment session for the take', () => {
    expect(
      /startAlignment\(generation, compiled\)/.test(code(DRIVER)),
      'the driver must hand Rust the compiled script',
    ).toBe(true);
  });

  it('Rust feeds transcript frames to the engine at the socket', () => {
    /*
     * Anchored on the load-bearing prefix — right function, right frame, right
     * clock — and left open after it, so a sidecar argument the engine grows
     * later (word times were the first) does not make this go stale. What it
     * still refuses is the failure it was written for: the call deleted, or
     * fed some other frame or some other clock.
     */
    expect(
      /crate::align::observe_frame\(\s*app,\s*&frame,\s*audio_now_ms\s*[,)]/.test(STT_STREAM),
      'no path from a transcript frame to the alignment engine',
    ).toBe(true);
    /*
     * And ONLY transcript frames: `emit_transcript` is the funnel that reaches
     * the engine, so a transport or audio-drop frame going through plain
     * `emit` is a structural guarantee rather than a convention. A reconnect
     * notice is not evidence about where the presenter is reading.
     */
    expect(/fn emit_transcript</.test(STT_STREAM)).toBe(true);
  });

  it('the session is subscribed before the microphone opens', () => {
    /*
     * Ordering, not just presence. A Tauri event is delivered by evaluating JS
     * in the target webview and is never queued, so a frame emitted between
     * `start_transcription` returning and the listener being registered is
     * lost outright — and the frame in that window is `transport: connecting`,
     * the one the UI uses to stop claiming the session is live.
     */
    const body = code(PIPELINE);
    const subscribe = body.indexOf('await this.subscribeToStt()');
    const acquire = body.indexOf('await this.acquireMicrophone(this.preferredDeviceId)');
    expect(subscribe).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(-1);
    expect(subscribe).toBeLessThan(acquire);
  });

  it('the PCM tap opens before the recogniser is asked for a session', () => {
    /*
     * #257. `startTranscription()` loads the model when it is not resident —
     * over a second on the first take after launch — and capture used to wait
     * for it, so the opening words were never recorded at all. The pipeline's
     * own suite (`voice-pre-roll.test.ts`) proves the held frames arrive; this
     * pins the order that makes there be any to hold.
     */
    const body = code(PIPELINE);
    const capture = body.indexOf('await this.startCapture(stream)');
    const transport = body.indexOf('await startTranscription()');
    expect(capture).toBeGreaterThan(-1);
    expect(transport).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(transport);
  });
});

describe('the trace has call sites, not just a module', () => {
  /*
   * This is the guard I needed and did not have.
   *
   * The tracing was written to end exactly this kind of investigation, and
   * then every call site was deleted along with the transport that contained
   * them. The module still initialised, the log file was still created, and
   * `logs/` stayed empty through take after take — so the one tool for
   * answering "where did the words go" answered nothing, silently, at the
   * moment it was most needed.
   *
   * A diagnostic with no callers is worse than no diagnostic: you believe you
   * have evidence and you are actually still guessing.
   */
  const traced = [
    ['the session start sequence', PIPELINE, /traceBegin\(\)/],
    ['microphone acquisition', PIPELINE, /trace\('microphone'/],
    ['the provider session', PIPELINE, /trace\(\s*'session'/],
    ['capture start', PIPELINE, /trace\('capture'/],
    ['audio frames leaving', PIPELINE, /trace\('audio'/],
    ['frames NOT leaving', PIPELINE, /trace\('frame-skipped'/],
    ['frames held for a loading recogniser', PIPELINE, /trace\(\s*'pre-roll'/],
    ['every inbound provider frame', PIPELINE, /trace\(\s*`rx:\$\{frame\.kind\}`/],
    ['a frame dropped by generation', PIPELINE, /trace\('rx-dropped'/],
    ['audio lost before the IPC edge', SEND_QUEUE, /trace\(\s*'audio-dropped'/],
    ['a duplicated final', PIPELINE, /trace\('final-duplicate'/],
    ['the confirmed cursor advancing', DRIVER, /trace\(\s*'confirmed'/],
    ['an explicit navigation', DRIVER, /trace\('align-cmd'/],
  ] as const;

  for (const [what, body, pattern] of traced) {
    it(`traces ${what}`, () => {
      expect(pattern.test(code(body)), `no trace call for ${what}`).toBe(true);
    });
  }

  it('the trace module is initialised at startup', () => {
    const app = code(source('../../../src/control/App.svelte'));
    expect(/initAudioTrace\(\)/.test(app)).toBe(true);
  });
});
