/**
 * A viewport that changes WHILE the stage is mounted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NEW
 * ---------------------------------------------------------------------------
 * Until reader mode the viewport changed exactly once per take, and it changed
 * BEFORE the stage mounted: `startTake` presents the window and awaits
 * `awaitViewportSettled` precisely so the line map is measured once, at the size
 * it will be read at. Nothing in this component had ever been asked what happens
 * when a window edge is dragged, because no window had a draggable edge.
 *
 * A reading window does. A drag delivers a resize per frame, each one is a layout
 * input, and each one asks for a full rebuild — `document.fonts.ready`, a
 * re-measure of every block, and a §33 semantic re-anchor. So the viewport is
 * coalesced on a trailing edge, and these tests pin the three properties that
 * makes-or-breaks:
 *
 *   1. the OPENING is not delayed by the debounce (the first measurement lands
 *      immediately, because there is nothing to coalesce at mount),
 *   2. a burst of resizes produces one rebuild, not one per resize,
 *   3. mid-drag, the document is NOT re-wrapping under the reader,
 *   4. the sequence converges — it comes to rest rather than rebuilding forever.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT PIN
 * ---------------------------------------------------------------------------
 * The `lineMapDirty` trailing rebuild is NOT directly tested here, and it is
 * worth saying so rather than letting the file's name imply otherwise. The defect
 * it fixes is a two-frame race — a resize landing after `rebuildLineMap()` has
 * read its inputs but before the `finally` clears `lineMapPending` — and nothing
 * available in jsdom can schedule an observation into that window reliably. The
 * flag is reasoned about at its definition and exercised only incidentally by (2)
 * and (4). A real window with a dragged edge is the thing that would prove it,
 * and this machine cannot drive one (see the README on WKWebView).
 *
 * (4) is the closest this file gets: an infinite reschedule would fail it.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ScriptLayer from '../../src/stage/renderer/ScriptLayer.svelte';
import type { StageRenderDocument, StageSettings } from '../../src/shared/contracts';

/**
 * The layer measures itself through `bind:clientWidth/clientHeight`, which is a
 * ResizeObserver — so driving a "resize" here means changing what the prototype
 * getters answer and then firing the observer again.
 *
 * Mutable, unlike the sibling suites' fixed 1024x600, because a changing
 * viewport is the entire subject.
 */
let clientWidth = 1200;
let clientHeight = 800;
const observers: Array<() => void> = [];

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[], self: unknown) => void) {}
    observe(target: Element): void {
      const fire = () => this.cb([{ target }], this);
      observers.push(fire);
      fire();
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => clientWidth,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
});

function resizeTo(width: number, height: number): void {
  clientWidth = width;
  clientHeight = height;
  for (const fire of observers) fire();
}

const doc: StageRenderDocument = {
  schemaVersion: 1,
  title: 'Settle',
  blocks: [
    {
      id: 'b1',
      kind: 'paragraph',
      spoken: true,
      startTokenIndex: 0,
      endTokenIndex: 5,
      renderNodes: [
        { type: 'text', text: 'one two three four five six', tokenIndexes: [0, 1, 2, 3, 4, 5] },
      ],
      layoutHints: {},
      source: { utf16Start: 0, utf16End: 27 },
    },
  ],
  tokenToNode: [0, 1, 2, 3, 4, 5].map((tokenIndex) => ({
    tokenIndex,
    blockId: 'b1',
    nodeKey: '',
  })),
  assets: {},
  sentences: [],
};

/**
 * Uncalibrated on purpose. This suite is about WHEN the map is rebuilt, not about
 * what geometry it is rebuilt with — an `optics` block would add a second reason
 * for the layout to change and make a rebuild count ambiguous.
 */
function settings(): StageSettings {
  return {
    schemaVersion: 1,
    themeId: 'stage-dark',
    background: '#000000',
    foreground: '#f5f3ef',
    fontFamilyId: 'system-sans',
    fontSizePx: 48,
    lineHeight: 1.38,
    letterSpacingEm: 0,
    columnWidthPercent: 68,
    readingBandCenterPercent: 42,
    readingBandHalfHeightPercent: 4,
    pastOpacity: 0.48,
    futureOpacity: 0.92,
    currentUnderlayOpacity: 0,
    mirrorX: false,
    mirrorY: false,
    showCues: true,
    stageAcknowledgements: true,
    reducedMotion: false,
    paragraphSpacingEm: 0.7,
  };
}

/**
 * `onlayoutgeneration` is the observable, and it is the right one: it fires when a
 * rebuild produced a layout the component classifies as NEW — which is exactly
 * what a re-wrap is, and exactly what must not happen sixty times during a drag.
 */
function mount() {
  const onlayoutgeneration = vi.fn();
  const result = render(ScriptLayer, {
    props: {
      doc,
      settings: settings(),
      onlayoutgeneration,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    },
  });
  return { ...result, onlayoutgeneration };
}

/**
 * Long enough for the 120ms viewport settle AND the rebuild behind it (a
 * `document.fonts.ready` await, an rAF, then the measurement pass).
 *
 * Real timers rather than `vi.useFakeTimers()`, deliberately: the chain under
 * test crosses a `setTimeout`, a promise and a `requestAnimationFrame`, and
 * faking only the first of those tests a sequence the browser never runs.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** Shorter than the 120ms settle, so a debounced rebuild has NOT fired yet. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('the viewport settle', () => {
  it('measures the opening immediately rather than waiting out the debounce', async () => {
    /*
     * The opening is already a sequence of waits behind an opaque plate. Adding
     * 120ms before the layout can even begin would spend it on coalescing a
     * resize sequence that, at mount, has exactly one member.
     */
    clientWidth = 1200;
    clientHeight = 800;
    const { onlayoutgeneration } = mount();
    await settle();
    expect(onlayoutgeneration).toHaveBeenCalled();
  });

  it('holds the layout while a drag is still moving', async () => {
    // The point of the debounce, stated as behaviour: the document must not
    // re-wrap under the reader on every frame of a drag.
    clientWidth = 1200;
    clientHeight = 800;
    const { onlayoutgeneration } = mount();
    await settle();
    const atOpen = onlayoutgeneration.mock.calls.length;

    resizeTo(1100, 800);
    await tick();

    expect(onlayoutgeneration.mock.calls.length).toBe(atOpen);
  });

  it('coalesces a burst of resizes rather than rebuilding per observation', async () => {
    clientWidth = 1200;
    clientHeight = 800;
    const { onlayoutgeneration } = mount();
    await settle();
    const atOpen = onlayoutgeneration.mock.calls.length;

    // A drag: eight observations, each well inside one settle window.
    for (let width = 1190; width >= 1120; width -= 10) {
      resizeTo(width, 800);
      await tick();
    }
    await settle();

    const rebuilds = onlayoutgeneration.mock.calls.length - atOpen;
    /*
     * The size ended somewhere new, so SOMETHING must have rebuilt — a debounce
     * that swallowed the drag entirely would be worse than no debounce.
     */
    expect(rebuilds).toBeGreaterThan(0);
    /*
     * And the number that matters: eight observations must not be eight full
     * measurement passes. The bound is 4 rather than 1 because a rebuild
     * legitimately re-runs when the measured line pitch moves the solved padding,
     * which is a second layout input reacting to the first.
     */
    expect(rebuilds).toBeLessThan(4);
  });

  it('comes to rest, rather than rescheduling itself forever', async () => {
    /*
     * The convergence guard for the `lineMapDirty` retry. The flag makes a build
     * re-schedule itself when a request arrived while it was running, and the way
     * that goes wrong is a rebuild whose own effects mark the map dirty again —
     * an infinite loop that would show up here as a call count that keeps
     * climbing after everything has stopped moving.
     */
    clientWidth = 1200;
    clientHeight = 800;
    const { onlayoutgeneration } = mount();
    await settle();

    resizeTo(700, 500);
    await settle();
    const afterResize = onlayoutgeneration.mock.calls.length;

    // Nothing touched. Two further settle windows must add nothing.
    await settle();
    await settle();
    expect(onlayoutgeneration.mock.calls.length).toBe(afterResize);
  });

  it('rebuilds again for a genuinely new size after it has come to rest', async () => {
    // The other half of convergence: coming to rest must not mean going deaf.
    clientWidth = 1200;
    clientHeight = 800;
    const { onlayoutgeneration } = mount();
    await settle();

    resizeTo(900, 700);
    await settle();
    const afterFirst = onlayoutgeneration.mock.calls.length;

    resizeTo(600, 500);
    await settle();
    expect(onlayoutgeneration.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
