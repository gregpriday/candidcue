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
 *   stt://event → handleSttFrame → ledger + tracking worker
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

  it('a completed item is applied to the ledger AND sent to the worker', () => {
    const body = code(PIPELINE);
    // Both, not either: forwarding without applying leaves the aligner reading
    // an empty ledger; applying without forwarding leaves the cursor still.
    expect(/this\.ledger\.apply\(event\)/.test(body)).toBe(true);
    expect(/this\.deps\.onTrackingEvent\(event\)/.test(body)).toBe(true);
  });

  it('the session store feeds transcript events to the tracking driver', () => {
    expect(
      /driver\?\.feedTranscript\(event\)/.test(code(STORE)),
      'the store must hand transcript events to the worker driver',
    ).toBe(true);
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
    ['every inbound provider frame', PIPELINE, /trace\(\s*`rx:\$\{frame\.kind\}`/],
    ['a frame dropped by generation', PIPELINE, /trace\('rx-dropped'/],
    ['a final the ledger refused', PIPELINE, /trace\('ledger-rejected'/],
    ['transcripts with no worker to take them', STORE, /trace\('no-driver'/],
    ['the committed cursor advancing', DRIVER, /trace\(\s*'committed'/],
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
