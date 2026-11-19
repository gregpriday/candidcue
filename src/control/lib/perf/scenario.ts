/**
 * The benchmark scenario (issue #240): what a presenter waits for, measured
 * in the packaged app by the app itself.
 *
 * Loaded only by `probe.ts` in an armed launch (`src-tauri/src/perf.rs`), so
 * nothing here — the fixture included — is in any path a normal launch runs.
 * `scripts/perf-run.mjs` launches the benchmark build twice per pair on a
 * profile it has just emptied:
 *
 *   first use  Welcome is up → record the launch → save the scenario's
 *              settings and create the fixture → exit.
 *   relaunch   the Library is up → record the launch → open the fixture,
 *              back to the Library, open it again → Present, roll at pace
 *              for TAKE_MS, end → Present again, roll, end → exit.
 *
 * So "cold" is the first launch of a fresh profile and the first open,
 * Present and take in a process; "warm" is the second of each. The page's
 * filesystem cache is not controlled, and the README says so.
 *
 * HOW THE WAITS ARE MEASURED. Every end point is a predicate over the DOM and
 * the stores, polled once per animation frame, and the measurement ends at
 * the frame AFTER the one where the predicate first held — the first frame
 * whose paint includes it. So the resolution is one frame and the error is
 * always late, never early. Nothing in the product is instrumented for this:
 * the predicates read what a person would see, which is what keeps the
 * number honest if the product's internals move. A wait that never completes
 * is an error record and an invalid pair, never a quiet maximum.
 *
 * Nothing here opens the microphone: the takes are "roll at pace" (`fixed`),
 * which never builds the voice pipeline, so an unattended run cannot stop on
 * a permission prompt. No speech model is needed either.
 *
 * Every record goes through `log_client_diagnostic` (scope `perf`) as one JSON
 * line under the command's 2,000-character cap; the runner reads them back out
 * of the profile's `logs/client-trace.log`.
 */
import { get } from 'svelte/store';
import { emit } from '@tauri-apps/api/event';
import fixtureSource from '../../../../bench/scripts/huge.md?raw';
import { ipcInvoke } from '../../services/ipc';
import { createScript } from '../../services/scripts';
import { markWelcomed } from '../../stores/app-status';
import { compiled } from '../../stores/compiled';
import { editor } from '../../stores/editor';
import { library } from '../../stores/library';
import { navigate, route } from '../../stores/router';
import { autoScrollLive, session, toggleAutoScroll } from '../../stores/session';
import { patchSettings, settings } from '../../stores/settings';
import { emitShortcut } from '../shortcuts';
import { perfMarkTime } from './probe';

/** The fixture's title in the benchmark profile's library. */
export const FIXTURE_TITLE = 'Perf fixture (bench/scripts/huge.md)';

/** How long each take rolls while its frames are sampled. */
const TAKE_MS = 10_000;

/** Longest any single wait may take before the pair is declared broken. */
const WAIT_TIMEOUT_MS = 30_000;

/** Frame intervals per record: 200 × at most 8 characters stays under 2,000. */
const DELTAS_PER_RECORD = 200;

/** Longest the rolling script may sit still before the take is a stall. */
const STILL_LIMIT_MS = 1_000;

/** Must match `FINISHED_EVENT` in `src-tauri/src/perf.rs`. */
const FINISHED_EVENT = 'perf://finished';

type PerfRecord = { kind: string } & Record<string, unknown>;

async function report(record: PerfRecord): Promise<void> {
  const line = JSON.stringify({ v: 1, ...record });
  await ipcInvoke('log_client_diagnostic', { scope: 'perf', line });
}

/**
 * Where the scenario is, before each step that waits on something. A run
 * that hangs leaves its last step in the trace instead of only "timeout".
 */
async function progress(step: string): Promise<void> {
  await report({ kind: 'step', step });
}

class StepError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * Poll `holds` once per frame; resolve with the timestamp of the first frame
 * AFTER it held — the first paint that includes it.
 */
function paintedWhen(step: string, holds: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new StepError(step, `not reached within ${timeoutMs} ms`));
    }, timeoutMs);
    const poll = (): void => {
      if (done) return;
      let held = false;
      try {
        held = holds();
      } catch {
        held = false;
      }
      if (!held) {
        requestAnimationFrame(poll);
        return;
      }
      requestAnimationFrame((painted) => {
        if (done) return;
        // Still true in the frame that paints it, or it was a flicker and the
        // wait goes on: a predicate that held for one callback and then let go
        // is not something anyone saw.
        let still = false;
        try {
          still = holds();
        } catch {
          still = false;
        }
        if (!still) {
          requestAnimationFrame(poll);
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(painted);
      });
    };
    requestAnimationFrame(poll);
  });
}

function visible(el: Element | null): boolean {
  if (el === null) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
  if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/* ------------------------------------------------------------ predicates */

function fixtureId(): string | undefined {
  return get(library).scripts.find((s) => s.title === FIXTURE_TITLE)?.id;
}

function fixtureRow(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#script-row-${CSS.escape(id)} .row`);
}

/**
 * The editor can be worked in: this script's document is loaded, its FIRST
 * compile has succeeded (the opening panel also lowers on a timeout, which
 * would be a false finish), the panel is gone and the text is on screen.
 */
function editorReady(id: string): boolean {
  const r = get(route);
  const e = get(editor);
  const c = get(compiled);
  return (
    r.name === 'editor' &&
    r.scriptId === id &&
    e.scriptId === id &&
    !e.loading &&
    c.scriptId === id &&
    c.status === 'ready' &&
    document.querySelector('.page .opening') === null &&
    (document.querySelector('.cm-content')?.textContent?.length ?? 0) > 0 &&
    visible(document.querySelector('.cm-content'))
  );
}

/**
 * The first line can be read: the take is live on the Live route, the
 * opening plate and the presenting cover are gone, the script layer is shown
 * and a word of the script is on screen.
 */
function firstLineReadable(): boolean {
  const s = get(session);
  if (get(route).name !== 'live' || !s.active) return false;
  if (document.querySelector('.present-cover') !== null) return false;
  if (document.querySelector('.stage-root .waiting') !== null) return false;
  const layer = document.querySelector('.script-layer');
  if (!visible(layer)) return false;
  return visible(layer?.querySelector('[data-t]') ?? null);
}

function scrollOffset(): number | null {
  const plane = document.querySelector<HTMLElement>('.scroll-plane');
  const match = plane?.style.transform.match(/translate3d\(\s*0(?:px)?,\s*(-?[\d.]+)px/);
  return match ? Number(match[1]) : null;
}

/* ----------------------------------------------------------------- steps */

async function recordLaunch(phase: 'first-use' | 'relaunch'): Promise<void> {
  const readyMs = perfMarkTime('ready');
  const entryMs = perfMarkTime('entry');
  const mountedMs = perfMarkTime('mounted');
  if (readyMs === undefined || entryMs === undefined || mountedMs === undefined) {
    throw new StepError('launch', 'a launch mark is missing');
  }
  await report({
    kind: 'launch',
    phase,
    timeOrigin: performance.timeOrigin,
    entryMs,
    mountedMs,
    readyMs,
    headParsedMs: headParsedMs(),
  });
}

/**
 * When the page began to parse, from `public/boot-mark.js`: the first script
 * in `<head>`, run before the module graph is requested. Resource Timing was
 * the first choice and WKWebView reports no entries for `tauri://` scripts.
 */
function headParsedMs(): number | null {
  const at = (window as { __SPEAKING_GLASS_BOOT__?: unknown }).__SPEAKING_GLASS_BOOT__;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/** Hex SHA-256 of the fixture this build embeds, so a stale bundle is caught. */
async function fixtureDigest(): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(fixtureSource);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function recordEnvironment(): Promise<void> {
  const s = get(settings);
  await report({
    kind: 'env',
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
    screen: [window.screen.width, window.screen.height],
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    supportedEntryTypes: [...(PerformanceObserver.supportedEntryTypes ?? [])],
    presentationMode: s.stage.presentationMode,
    sessionMode: s.general.defaultSessionMode,
    wordsPerMinute: s.teleprompter.fixedSpeedWpm,
    fixtureSha256: await fixtureDigest(),
  });
}

/** First use: save what the relaunch needs, without warming anything it measures. */
async function prepareProfile(): Promise<void> {
  await patchSettings('general', {
    launchBehavior: 'library',
    defaultSessionMode: 'fixed',
    checkForUpdates: false,
    confirmEndSession: false,
  });
  await patchSettings('stage', { presentationMode: 'reader' });
  // Through the service, not the editor: opening it here would warm the
  // compiler worker this process is about to throw away anyway, and the
  // relaunch has to find the script exactly as a returning user would.
  await createScript({ title: FIXTURE_TITLE, source: fixtureSource });
  markWelcomed();
}

async function openFixture(ordinal: number, id: string): Promise<void> {
  if (get(route).name !== 'library') {
    await navigate({ name: 'library', view: 'all' });
  }
  await progress(`open ${ordinal}`);
  await paintedWhen(`open ${ordinal}: library row`, () => visible(fixtureRow(id)));
  const row = fixtureRow(id);
  if (row === null) throw new StepError(`open ${ordinal}`, 'the fixture row went away');
  const startedAt = performance.now();
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const readyAt = await paintedWhen(`open ${ordinal}`, () => editorReady(id));
  await report({
    kind: 'open',
    ordinal,
    ms: readyAt - startedAt,
    words: fixtureSource.split(/\s+/).filter(Boolean).length,
  });
}

async function presentAndRoll(ordinal: number, id: string): Promise<void> {
  await progress(`present ${ordinal}`);
  await paintedWhen(`present ${ordinal}: editor`, () => editorReady(id));
  const button = document.querySelector<HTMLButtonElement>('.present-group .split button.main');
  if (button === null || button.disabled) throw new StepError(`present ${ordinal}`, 'no Present button');
  const startedAt = performance.now();
  button.click();
  const readableAt = await paintedWhen(`present ${ordinal}`, firstLineReadable);
  // A stage whose opening placement fails reveals its script anyway, after a
  // 700 ms deadline from the layer's mount. Nothing on screen tells that
  // reveal from a placed one, so it is not detected here; it cannot hide,
  // though: it lands well above the 531–550 ms a placed reveal takes on the
  // baseline Mac (bench/perf/README.md).
  await report({ kind: 'present', ordinal, ms: readableAt - startedAt, outcome: 'readable' });

  await progress(`take ${ordinal}: roll`);
  toggleAutoScroll();
  await paintedWhen(`take ${ordinal}: rolling`, () => get(autoScrollLive).running);
  await progress(`take ${ordinal}: sample`);
  const take = await sampleFrames(TAKE_MS);
  await progress(`take ${ordinal}: sampled ${take.outcome}`);
  toggleAutoScroll();
  for (let part = 0; part * DELTAS_PER_RECORD < take.deltas.length || part === 0; part++) {
    await report({
      kind: 'frames',
      ordinal,
      part: part + 1,
      parts: Math.max(1, Math.ceil(take.deltas.length / DELTAS_PER_RECORD)),
      deltas: take.deltas.slice(part * DELTAS_PER_RECORD, (part + 1) * DELTAS_PER_RECORD),
    });
  }
  await report({
    kind: 'take',
    ordinal,
    outcome: take.outcome,
    durationMs: take.durationMs,
    frameCount: take.deltas.length,
    displacementPx: take.displacementPx,
    longestStillMs: take.longestStillMs,
  });

  await progress(`end ${ordinal}`);
  if (!emitShortcut('stop-session')) throw new StepError(`end ${ordinal}`, 'stop-session was not taken');
  await paintedWhen(`end ${ordinal}: summary`, () => doneButton() !== null);
  doneButton()?.click();
  await paintedWhen(`end ${ordinal}: editor`, () => editorReady(id) && doneButton() === null);
}

function doneButton(): HTMLButtonElement | null {
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) {
      if (button.textContent?.trim() === 'Done') return button;
    }
  }
  return null;
}

/**
 * The interval between successive animation frames for `durationMs`, while
 * the script rolls.
 *
 * Its own rAF loop beside the stage's: every callback in a frame shares that
 * frame's timestamp, so this sees exactly the cadence the stage's follower
 * runs at — including any stall, whatever caused it — without a line of
 * instrumentation in the renderer. The raw interval is kept, before the
 * follower's own gap handling could hide it. A take during which the window
 * was hidden is not a take: rAF stops, and the gap would be a lie.
 *
 * It also has a watchdog, because it is the one wait driven by nothing but
 * animation frames: if they stop altogether (an occluded window, a blocked
 * main thread) it would never finish, the process would be killed and the
 * pair would say only "timeout". A stalled take reports itself instead. If
 * the main thread itself is blocked the watchdog cannot run either, and that
 * difference — a `stalled` record against no record at all — is the clue.
 */
function sampleFrames(
  durationMs: number,
): Promise<{
  deltas: number[];
  durationMs: number;
  displacementPx: number;
  outcome: string;
  longestStillMs: number;
}> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    // From the state now, not only from changes: a document already hidden
    // when sampling starts, and shown again before it ends, fires only a
    // change back to visible.
    let hidden = document.visibilityState !== 'visible';
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') hidden = true;
    };
    document.addEventListener('visibilitychange', onVisibility);
    const startOffset = scrollOffset();
    // The script has to keep moving, not just have moved: a renderer whose
    // loop died a second in would leave positive displacement and perfect
    // frame intervals from this loop, and pass. At 130 wpm it moves about
    // 11 px a second, so any still stretch over a second is a stall.
    let lastOffset = startOffset;
    let lastMovedAt: number | null = null;
    let longestStillMs = 0;
    let first: number | null = null;
    let last: number | null = null;
    let finished = false;
    let rafId = 0;
    const finish = (endedAt: number, outcome: string): void => {
      finished = true;
      clearTimeout(watchdog);
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', onVisibility);
      const endOffset = scrollOffset();
      resolve({
        deltas,
        durationMs: first === null ? 0 : endedAt - first,
        displacementPx: startOffset === null || endOffset === null ? 0 : Math.abs(endOffset - startOffset),
        outcome,
        longestStillMs: Math.round(longestStillMs),
      });
    };
    const watchdog = setTimeout(() => {
      if (!finished) finish(last ?? 0, `stalled (frames stopped; ${document.visibilityState})`);
    }, durationMs + 5_000);
    const frame = (now: number): void => {
      if (finished) return;
      if (first === null) first = now;
      else if (last !== null) deltas.push(Math.round((now - last) * 100) / 100);
      last = now;
      const offset = scrollOffset();
      if (lastMovedAt === null || offset !== lastOffset) {
        lastMovedAt = now;
        lastOffset = offset;
      } else {
        longestStillMs = Math.max(longestStillMs, now - lastMovedAt);
      }
      if (now - first < durationMs && !hidden) {
        rafId = requestAnimationFrame(frame);
        return;
      }
      finish(now, hidden ? 'hidden' : longestStillMs > STILL_LIMIT_MS ? 'stopped moving' : 'ok');
    };
    rafId = requestAnimationFrame(frame);
  });
}

/* ------------------------------------------------------------------- run */

let started = false;

/**
 * Run whichever half of the pair this launch is, report it, and ask Rust to
 * exit. Errors are reported, not thrown: the runner judges the pair from the
 * records, and a scenario that died silently would only look like a hang.
 */
export async function runScenario(): Promise<void> {
  if (started) return;
  started = true;
  const firstRoute = get(route).name;
  const phase = firstRoute === 'welcome' ? 'first-use' : 'relaunch';
  try {
    if (firstRoute !== 'welcome' && firstRoute !== 'library') {
      throw new StepError('launch', `the launch landed on ${firstRoute}`);
    }
    if (phase === 'relaunch' && fixtureId() === undefined) {
      throw new StepError('launch', 'the Library is up without the fixture');
    }
    await recordLaunch(phase);
    if (phase === 'first-use') {
      await prepareProfile();
    } else {
      const id = fixtureId() as string;
      await recordEnvironment();
      await openFixture(1, id);
      await openFixture(2, id);
      await presentAndRoll(1, id);
      await presentAndRoll(2, id);
    }
  } catch (err) {
    const step = err instanceof StepError ? err.step : 'scenario';
    const message = err instanceof Error ? err.message : String(err);
    await report({ kind: 'error', step, message: message.slice(0, 500) }).catch(() => {});
  }
  await report({ kind: 'done', phase }).catch(() => {});
  await emit(FINISHED_EVENT);
}
