import { test, expect } from '@playwright/test';

/**
 * Both taps on one microphone, in a real browser, on a real MediaStream.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN E2E TEST AND NOT A UNIT TEST
 * ---------------------------------------------------------------------------
 * The defect was two `MediaStreamAudioSourceNode`s attached to ONE
 * `MediaStream` from two `AudioContext`s at different sample rates — the
 * analyser behind the level meter at the hardware rate, `PcmCapture` at
 * `STT_SAMPLE_RATE_HZ`. On WebKit that combination lets one of them deliver
 * silence, and on a RODE NT-USB Mini it was the analyser that lost. Settings
 * printed the contradiction one line above the other, "No signal" over
 * "Transcription is working", and the silence reached the §28.6 dead-input
 * detector, which held following for the whole take.
 *
 * jsdom has no Web Audio at all, so nothing in the unit suite can execute a
 * line of this. The source-level test (`one-microphone-one-rate.test.ts`) pins
 * the rates against a relapse and cannot run the graph. This one runs it: real
 * `getUserMedia`, real `AudioContext`, real `AnalyserNode`, real
 * `ScriptProcessor`, both attached to the same track at once.
 *
 * Chromium's fake capture device emits a continuous tone, so "the analyser
 * reads zero" is a failure with no innocent explanation — which is exactly the
 * reading the RODE produced.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 * ---------------------------------------------------------------------------
 * It proves the shipped graph construction is sound and that the two taps
 * coexist on one stream without either falling silent. It cannot reproduce
 * WebKit's specific failure from Chromium, and it is not a substitute for
 * running the app on the affected device. What it removes is the possibility
 * that the fix is broken in some way nobody noticed — a context that throws,
 * a graph that never renders, a suspended context, a processor that never
 * fires — every one of which would look identical to the original bug.
 */

/** Long enough for the analyser to fill and several PCM frames to land. */
const OBSERVE_MS = 1200;

test('the level meter and the PCM tap both hear one microphone', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(String(e)));

  // Any app page will do — it is the Vite dev server that matters, so the real
  // modules can be imported and transformed rather than reimplemented here.
  await page.goto('/control.html');

  const result = await page.evaluate(async (observeMs) => {
    /*
     * Served by the Vite dev server and resolved at RUNTIME, so the real
     * modules are exercised rather than reimplemented. The specifiers are held
     * in variables because they are browser-absolute URLs: as literals, tsc
     * tries to resolve them against the repo and fails, and rewriting them to
     * paths tsc likes would import something other than what ships.
     */
    const meterUrl = '/src/control/services/audio/levelMeter.ts';
    const captureUrl = '/src/control/services/audio/capture.ts';
    const { createAnalyserGraph } = await import(/* @vite-ignore */ meterUrl);
    const { PcmCapture } = await import(/* @vite-ignore */ captureUrl);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // The order the take uses: the monitor is built during microphone
    // acquisition, the PCM tap when capture starts.
    const graph = createAnalyserGraph(stream);

    let pcmFrames = 0;
    let pcmPeak = 0;
    const capture = new PcmCapture({
      onFrame: (samples: Float32Array) => {
        pcmFrames += 1;
        for (let i = 0; i < samples.length; i += 1) {
          const v = Math.abs(samples[i] ?? 0);
          if (v > pcmPeak) pcmPeak = v;
        }
      },
    });
    await capture.start(stream);

    // Sample the analyser the way `MicrophoneMonitor` does.
    const buffer = new Float32Array(graph.analyser.fftSize);
    let analyserPeak = 0;
    const deadline = performance.now() + observeMs;
    while (performance.now() < deadline) {
      graph.analyser.getFloatTimeDomainData(buffer);
      for (let i = 0; i < buffer.length; i += 1) {
        const v = Math.abs(buffer[i] ?? 0);
        if (v > analyserPeak) analyserPeak = v;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const analyserRate = (graph.analyser.context as AudioContext).sampleRate;
    const captureRate = capture.contextSampleRate;

    await capture.stop();
    await graph.close();
    stream.getTracks().forEach((t) => t.stop());

    return { analyserPeak, pcmFrames, pcmPeak, analyserRate, captureRate };
  }, OBSERVE_MS);

  expect(failures, `page errors: ${failures.join(' | ')}`).toEqual([]);

  /*
   * THE CLAIM. Both taps carry signal at the same time.
   *
   * The fake device emits a continuous tone, so a zero peak on either side is
   * a tap that has fallen silent — the RODE reading, reproduced.
   */
  expect(result.pcmFrames, 'the PCM tap produced no frames at all').toBeGreaterThan(2);
  expect(result.pcmPeak, 'the PCM tap fell silent while the analyser was attached').toBeGreaterThan(
    0.001,
  );
  expect(
    result.analyserPeak,
    `the analyser fell silent while the PCM tap was attached — the exact "No signal" over "Transcription is working" reading (${JSON.stringify(result)})`,
  ).toBeGreaterThan(0.001);

  /*
   * And they agree about the rate, which is what stops the two source nodes
   * being the mismatched pair in the first place. Reported rather than assumed
   * equal to the constant: an engine may refuse an explicit rate, and the point
   * is that the two AGREE, not what number they landed on.
   */
  expect(
    result.analyserRate,
    `the two taps disagree about the sample rate (${JSON.stringify(result)})`,
  ).toBe(result.captureRate);
});
