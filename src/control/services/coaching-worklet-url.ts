/**
 * The bundled Coaching-analyzer worklet module URL (§12.1 "Bundling").
 *
 * `worklet-node.ts` deliberately does not compute this: how a worklet is
 * emitted is a build decision, and it flagged two options. This is the choice.
 *
 * ---------------------------------------------------------------------------
 * Why `?worker&url` rather than a second rollup input
 * ---------------------------------------------------------------------------
 * `audioWorklet.addModule()` evaluates the fetched script in a scope with no
 * bundler, so the module must arrive **self-contained**. A second
 * `rollupOptions.input` entry would not give that: Rollup emits ES chunks and
 * hoists anything shared with the control bundle (`worklet-core`, `fft`,
 * `vad`, `ring-buffer`, `pitch-yin`…) into a common chunk, so the emitted file
 * would begin with `import` statements pointing at sibling chunks — the exact
 * shape the header warns is unreliable inside a worklet on WKWebView.
 *
 * `?worker&url` builds the entry through Vite's *worker* pipeline, whose
 * default output format is `iife` (`worker.format`), i.e. one standalone file
 * with every dependency inlined and no import statements at all. It also
 * requires no change to `vite.config.ts`, which is why the config is untouched
 * apart from the comment pointing here.
 *
 * The import lives alone in this module so that:
 *   - node tests never pull a worker build into a non-Vite environment (the
 *     analyzer service reaches it through a lazy `import()`), and
 *   - there is exactly one place to change if the emitted shape ever needs to
 *     be inspected or pinned.
 *
 * It lives directly under `control/services` rather than under
 * `control/services/audio` on purpose: that transport directory is barred by
 * `boundaries.test.ts` from importing the coaching audio package, and this
 * module — the coaching subsystem's own build seam — is not a transport module.
 */
import workletModuleUrl from '../../shared/coaching/audio/audio-worklet.ts?worker&url';

export default workletModuleUrl;
