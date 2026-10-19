/**
 * Nothing may be holding the microphone when a take asks for it.
 *
 * This is the defect that made "voice tracking is unavailable" unfixable for
 * three rounds, and it was never a network problem. Preflight's level meter
 * held a live `getUserMedia` stream for as long as that screen was showing, and
 * `startLiveSession` opened the take's own capture while the component was
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
 * ---------------------------------------------------------------------------
 * WHY THESE ASSERTIONS CHANGED SHAPE
 * ---------------------------------------------------------------------------
 * The old fix was a flag (`micHeldForTake`) plus an awaited teardown, because
 * the meter and the Present button were on the SAME screen and the handover was
 * a matter of milliseconds. They are not any more: the meter lives in Settings,
 * scoped to the Audio section, and every route that can start a take is a
 * different route — so the meter's component is unmounted, and its capture
 * released, before a take can be requested at all.
 *
 * That is a stronger guarantee than the flag was, and it holds for a structural
 * reason rather than an ordering one. So what is pinned here is the structure:
 * exactly one screen opens a meter, it is gated on being the visible section,
 * it releases on teardown, and the take path opens no capture of its own.
 *
 * These are source assertions because the failure is an ORDERING between a
 * Svelte effect's teardown and an async call in another module, in components
 * that cannot be mounted in this project (they pull the whole control window
 * behind them). A behavioural test would need a real WebView to reproduce the
 * hang at all, which is precisely why nothing caught this.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

/** Strip comments, so prose about the fix cannot satisfy an assertion. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

function sources(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|svelte)$/.test(entry)) continue;
      // Forward slashes on every host, as the expectations spell them.
      files.push({ path: full.slice(SRC.length + 1).replaceAll('\\', '/'), text: readFileSync(full, 'utf8') });
    }
  };
  walk(SRC);
  return files;
}

const SETTINGS = read('control/routes/Settings.svelte');
const START_TAKE = read('control/lib/start-take.ts');

describe('only one screen opens a level meter, and it is not a screen that presents', () => {
  it('Settings is the only caller of observeLevels', () => {
    /*
     * `observeLevels` is the meter's capture. A second caller anywhere is a
     * second concurrent stream on the same device, which is the hang above.
     * The voice facade and the services behind it are the implementation, not
     * callers, so only screens are counted.
     */
    const screens = sources().filter(
      (f) => f.path.endsWith('.svelte') && code(f.text).includes('observeLevels('),
    );
    expect(screens.map((f) => f.path)).toEqual(['control/routes/Settings.svelte']);
  });

  it('the meter runs only while the Audio section is the one being looked at', () => {
    // A capture held open by a screen nobody is reading is a microphone the
    // next take has to prise away from a page that has no use for it. The test
    // is in the same condition because it opens the same device: one capture,
    // not two, on the one path where both controls are a click apart.
    expect(code(SETTINGS)).toMatch(
      /if \(section !== 'audio' \|\| micPermission !== 'granted' \|\| micTestRunning\)/,
    );
  });

  it('the next capture WAITS for the last one, rather than merely starting its release', () => {
    /*
     * This is the assertion that matters, and the one an earlier version of
     * this file got wrong. It used to accept `void unsub()` in the teardown as
     * proof of a handover — but `observeLevels`' disposer is asynchronous, and
     * firing it without awaiting it is precisely the defect: it starts the
     * release and returns, so the replacement capture opens while the previous
     * one is still letting go. That is the hang, blessed by a passing test.
     *
     * What has to hold is an ORDERING between two async operations in two
     * different modules, so what is pinned is the mechanism that provides it:
     * every acquisition is chained onto the previous release.
     */
    const body = code(SETTINGS);
    const meter = body.slice(body.indexOf("if (section !== 'audio' || micPermission"));
    const effect = meter.slice(0, meter.indexOf('async function microphoneQuiet'));

    expect(effect, 'the capture must be chained onto the baton, not opened outright').toMatch(
      /captureBaton\.then\(/,
    );
    expect(effect, 'and the baton must advance to this capture').toMatch(/captureBaton = opened/);
    // Scoped to the TEARDOWN, not the whole effect: the acquisition above also
    // assigns the baton, so a looser match is satisfied by the very code this
    // is meant to reject — a release fired into the void while the assignment
    // it no longer feeds sits a few lines higher.
    const teardown = effect.slice(effect.indexOf('return () => {'));
    expect(teardown, 'the teardown must publish the RELEASE as the next baton').toMatch(
      /captureBaton =/,
    );
    expect(teardown, 'and the baton must actually await the release').toMatch(/await release\(\)/);
    expect(
      teardown.indexOf('captureBaton ='),
      'the release must BE the baton, not run beside it',
    ).toBeLessThan(teardown.indexOf('await release()'));
    // A rejected release must not wedge the baton, or every later capture on
    // this screen waits on a promise that never settles.
    expect(teardown, 'a failed release must not deadlock the baton').toMatch(/\.catch\(/);
  });

  it('the billable test takes the device only once the meter is genuinely off it', () => {
    /*
     * `await tick()` flushes Svelte, not `getUserMedia`; the baton is what
     * waits for the capture the teardown started to let go of. Both halves are
     * needed, and the gap between them is exactly where the contention lives.
     */
    const body = code(SETTINGS);
    const quiet = body.slice(body.indexOf('async function microphoneQuiet'));
    expect(quiet.slice(0, 200)).toMatch(/await tick\(\)[\s\S]*?await captureBaton/);

    const run = body.slice(body.indexOf('async function runTranscriptionTest'));
    const fn = run.slice(0, run.indexOf('\n  }') + 4);
    expect(fn, 'the test must wait for the microphone').toMatch(/await microphoneQuiet\(\)/);
    expect(
      fn.indexOf('await microphoneQuiet()'),
      'and it must wait BEFORE opening the session, not after',
    ).toBeLessThan(fn.indexOf('micTestSession.start('));
  });

  it('the button that starts the test goes through that wait', () => {
    // A second entry point that calls `micTestSession.start` directly would
    // bypass the handover entirely and look completely reasonable doing it.
    expect(SETTINGS).toMatch(/onclick=\{\(\) => void runTranscriptionTest\(\)\}/);
    const starts = [...code(SETTINGS).matchAll(/micTestSession\.start\(/g)];
    expect(starts, 'exactly one caller may open the test session').toHaveLength(1);
  });

  it('the take opens no capture of its own outside the pipeline', () => {
    /*
     * §5.3 single-capture fan-out. The take's ONE stream belongs to the voice
     * pipeline; the start sequence must never open a second one to sample a
     * level, prove a device or check a permission — that is the same collision
     * from the other side.
     */
    const body = code(START_TAKE);
    expect(body).not.toMatch(/getUserMedia|observeLevels|requestMicrophoneAccess/);
  });
});

describe('the transcription test cannot outlive the screen that started it', () => {
  it('is disposed on unmount and on leaving the Audio section', () => {
    /*
     * A BILLABLE realtime session. The old screen had no Stop and no timeout,
     * so starting the test and then reading something else left a connection
     * streaming the owner's microphone — and their money — until they happened
     * to navigate away.
     */
    const body = code(SETTINGS);
    expect(body).toMatch(/if \(section === 'audio'\)\s*return;\s*micTestSession\.dispose\(\)/);
    expect(body).toMatch(/return \(\) => micTestSession\.dispose\(\)/);
  });
});

describe('guards the guard: the symbols these assertions rely on still exist', () => {
  it('Settings still holds the meter and the test session', () => {
    expect(SETTINGS).toContain('observeLevels(');
    expect(SETTINGS).toContain('micTestSession');
    expect(SETTINGS.length).toBeGreaterThan(1000);
  });

  it('start-take is still the start sequence', () => {
    expect(START_TAKE).toMatch(/export async function startTake/);
    expect(START_TAKE).toContain('startLiveSession(');
  });
});
