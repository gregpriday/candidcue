/**
 * Preflight must let go of the microphone before the take opens its own.
 *
 * This is the defect that made "voice tracking is unavailable" unfixable for
 * three rounds, and it was never a network problem. Preflight's level meter
 * holds a live `getUserMedia` stream for as long as the screen is showing, and
 * `startLiveSession` opens the take's own capture while that component is
 * STILL MOUNTED — so WKWebView was asked for a second concurrent stream on a
 * device it had already granted. That call does not fail. It does not reject.
 * It simply never returns, so the connect attempt sat at "opening the
 * microphone" until its deadline and reported that the realtime connection
 * could not be opened — a connection it had never got far enough to attempt.
 *
 * The trace that found it, from a real take:
 *
 *   #1 +0ms     begin — connect attempt started
 *   #2 +0ms     mic — opening the microphone
 *   #3 +9915ms  failed — Connect cancelled: disconnect (stop)
 *
 * Nothing between step 2 and the stop, ten seconds apart.
 *
 * These are source assertions because the failure is an ORDERING between a
 * Svelte effect's teardown and an async call in another module, in a component
 * that cannot be mounted in this project (it pulls the whole control window
 * behind it). What has to hold is that the release happens, and happens before
 * the start — and both of those are properties of the source. A behavioural
 * test would need a real WebView to reproduce the hang at all, which is
 * precisely why nothing caught this.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PREFLIGHT = readFileSync(
  fileURLToPath(new URL('../../../src/control/routes/Preflight.svelte', import.meta.url)),
  'utf8',
);

/** Strip comments, so prose about the fix cannot satisfy an assertion. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CODE = code(PREFLIGHT);

describe('the microphone is handed to the take before the take asks for it', () => {
  it('gates the level meter on a flag the start sequence can set', () => {
    expect(
      /micPermission !== 'granted' \|\| micHeldForTake/.test(CODE),
      'the meter effect must stop when the take claims the microphone',
    ).toBe(true);
  });

  it('claims it inside startSession', () => {
    const start = CODE.slice(CODE.indexOf('async function startSession'));
    const body = start.slice(0, start.indexOf('\n  async function abandonSession'));
    expect(body).toMatch(/micHeldForTake = true/);
    expect(body, 'a running mic test holds a stream too').toMatch(/micTestSession\.stop\(/);
  });

  it('claims it BEFORE the take opens its capture, not after', () => {
    /*
     * The whole defect in one assertion. Releasing after `startLiveSession`
     * would read as correct, pass any test that only checks the release
     * happens, and hang exactly as before.
     */
    const claim = CODE.indexOf('micHeldForTake = true');
    const openCapture = CODE.indexOf('startLiveSession(');
    expect(claim, 'the claim must exist').toBeGreaterThan(-1);
    expect(openCapture, 'the take start must exist').toBeGreaterThan(-1);
    expect(claim, 'the microphone must be released before the take opens it').toBeLessThan(
      openCapture,
    );
  });

  it('waits for the teardown, because setting the flag is not releasing it', () => {
    // A Svelte effect's cleanup does not run synchronously on assignment. With
    // no flush, the flag is set and the stream is still open when the
    // transport calls getUserMedia — the same hang, with code that looks
    // fixed.
    const claim = CODE.indexOf('micHeldForTake = true');
    const afterClaim = CODE.slice(claim, CODE.indexOf('startLiveSession('));
    expect(afterClaim).toMatch(/await tick\(\)/);
  });

  it('gives the microphone back when the start fails', () => {
    // Otherwise a failed start leaves the meter dead and the operator with no
    // way to see whether the input works at all.
    const failure = CODE.slice(CODE.indexOf('Could not start the session.'));
    expect(failure.slice(0, 400)).toMatch(/micHeldForTake = false/);
  });

  it('guards the guard: the symbols these assertions rely on still exist', () => {
    expect(PREFLIGHT).toMatch(/let micHeldForTake = \$state\(false\)/);
    expect(PREFLIGHT.length).toBeGreaterThan(1000);
  });
});
