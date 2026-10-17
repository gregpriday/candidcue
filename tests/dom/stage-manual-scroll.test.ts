/**
 * The wheel, as the presenter's own hand on the script (§16.9, §30.6).
 *
 * ---------------------------------------------------------------------------
 * WHY A MOUNTED STAGE
 * ---------------------------------------------------------------------------
 * What changed here is not a handler but a SHAPE. The intent used to be
 * throttled — arm a timer on the first wheel event, report whatever had piled
 * up when it fired — which is right for a stream of deltas and wrong for what
 * this now carries: a decision about where the presenter ended up. Half a
 * gesture answers that question wrong, and a long scroll produced several
 * halves. Only a real listener taking real wheel events in sequence can show
 * that one gesture produces one report, so this drives a mounted `StageApp`.
 *
 * The judgement that report carries — moved, or only looked — is geometry, and
 * jsdom has none. It is tested where it lives, as a pure function:
 * `manualScrollRelocated` in `src/stage/renderer/motion.test.ts`. What this
 * file pins is the half jsdom CAN see, including the one that matters most for
 * a stage with no measured layout: with nothing to measure against, the answer
 * is null — leave the tracker alone — rather than a guess.
 */
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type {
  StageIntent,
  StageRenderDocument,
  StageSessionEnvelope,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';

const StageApp = (await import('../../src/stage/StageApp.svelte')).default;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  /*
   * Give the BLOCKS a height, because jsdom will not.
   *
   * Every box measures zero here, so the stage's document was as tall as its
   * own padding and nothing else — and the legacy padding table sums to 0.93
   * of the viewport, so `maxScroll` was the handful of pixels the line-entry
   * offset happened to add on top. A document that cannot scroll reports no
   * gesture, so a change to a typography constant could silently empty every
   * assertion in this file. One stubbed height is the difference between a
   * fixture that is scrollable and one that is scrollable by luck.
   */
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function boundedRect(this: Element): DOMRect {
    const rect = realRect.call(this) as DOMRect;
    if (!(this as HTMLElement).dataset?.['blockId']) return rect;
    return { ...rect.toJSON?.(), height: 120, bottom: 120, width: 800, right: 800, top: 0, left: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve(), load: async () => [] },
    });
  }
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

/**
 * A script long enough to actually scroll.
 *
 * jsdom measures every box as zero, so a short document has `maxScroll === 0`
 * and the wheel moves nothing — which the stage now correctly declines to
 * report, leaving nothing to observe. `heights` falls back to
 * `estimateBlockHeightPx` for any block it has not measured, and that estimate
 * is pure arithmetic over the font size and column width, so enough blocks
 * produce a genuinely scrollable document with no layout engine at all.
 */
const BLOCK_COUNT = 60;
const WORDS_PER_BLOCK = 40;

function renderDocument(): StageRenderDocument {
  const blocks = [];
  const tokenToNode = [];
  const sentences = [];
  let token = 0;
  for (let b = 0; b < BLOCK_COUNT; b++) {
    const id = `b${b}`;
    const start = token;
    const indexes: number[] = [];
    for (let w = 0; w < WORDS_PER_BLOCK; w++) indexes.push(token++);
    blocks.push({
      id,
      kind: 'paragraph',
      renderNodes: [
        {
          type: 'text',
          text: Array.from({ length: WORDS_PER_BLOCK }, (_, w) => `word${w}`).join(' '),
          tokenIndexes: indexes,
        },
      ],
      startTokenIndex: start,
      endTokenIndex: token - 1,
      source: { utf16Start: start * 6, utf16End: token * 6 },
      spoken: true,
    });
    for (const tokenIndex of indexes) tokenToNode.push({ tokenIndex, blockId: id, nodeKey: '' });
    sentences.push({ id: `s${b}`, blockId: id, startTokenIndex: start, endTokenIndex: token - 1 });
  }
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks,
    tokenToNode,
    assets: {},
    sentences,
  } as unknown as StageRenderDocument;
}

function envelope(): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    sessionGeneration: 1,
    stageGeneration: 0,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'hash-abc',
    compileRevision: 1,
    stageSettings: buildStageSettings({}),
    renderDocument: renderDocument(),
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

/**
 * Mount and WAIT for the script layer.
 *
 * `ScriptLayer` renders behind `fontsSettled`, which resolves on a microtask,
 * and until it exists there is no document to scroll — the stage would report
 * nothing and every assertion here would pass for the wrong reason. Awaiting
 * the timers is what makes these tests about the wheel rather than about mount
 * ordering.
 */
async function mount() {
  const onexit = vi.fn();
  const onintent = vi.fn<(intent: StageIntent) => void>();
  const { container } = render(StageApp, {
    props: {
      embedded: {
        envelope: envelope(),
        alignment: null,
        transcript: '',
        voicePill: null,
        onexit,
        onintent,
      },
    } as never,
  });
  await vi.advanceTimersByTimeAsync(20);
  flushSync();
  const root = container.querySelector<HTMLElement>('.stage-root')!;
  if (!container.querySelector('.script-layer')) {
    throw new Error('the script layer never mounted; this test would prove nothing');
  }
  return { onintent, root };
}

function wheel(root: HTMLElement, deltaY: number) {
  root.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
}

const scrolls = (onintent: ReturnType<typeof vi.fn>) =>
  onintent.mock.calls
    .map(([intent]) => intent as StageIntent)
    .filter((intent) => intent.kind === 'manual_scroll');

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllTimers();
});

describe('one gesture, one report', () => {
  it('waits for the gesture to settle before saying anything', async () => {
    const { onintent, root } = await mount();

    wheel(root, 120);
    wheel(root, 120);
    wheel(root, 120);
    // Mid-gesture. A report here would be a claim about where the presenter
    // ended up, made while they are still moving.
    vi.advanceTimersByTime(150);
    expect(scrolls(onintent)).toHaveLength(0);

    vi.advanceTimersByTime(100);
    const reported = scrolls(onintent);
    expect(reported).toHaveLength(1);
    // One report for the three events, carrying the travel they produced
    // together — never more than was asked for, because the document clamps.
    const { deltaPx } = reported[0] as { deltaPx: number };
    expect(deltaPx).toBeGreaterThan(0);
    expect(deltaPx).toBeLessThanOrEqual(360);
  });

  it('reports each gesture separately when the presenter pauses between them', async () => {
    const { onintent, root } = await mount();

    wheel(root, 200);
    vi.advanceTimersByTime(400);
    wheel(root, -80);
    vi.advanceTimersByTime(400);

    const deltas = scrolls(onintent).map((intent) => (intent as { deltaPx: number }).deltaPx);
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toBeGreaterThan(0);
    expect(deltas[1]).toBeLessThan(0);
  });

  it('reports anyway when a gesture never stops', async () => {
    /*
     * Somebody holding a trackpad scroll is not going to produce a quiet
     * window, and the tracker should not have to wait for them to finish before
     * it learns they have gone somewhere else.
     */
    const { onintent, root } = await mount();
    for (let i = 0; i < 40; i++) {
      wheel(root, 40);
      vi.advanceTimersByTime(50);
    }
    expect(scrolls(onintent).length).toBeGreaterThan(0);
  });
});

describe('what the report claims', () => {
  it('claims no anchor when there is no geometry to claim one from', async () => {
    /*
     * The stage cannot say where the presenter is without a valid line map, and
     * a wrong anchor is worse than none: it re-seeds the tracker's cursor with
     * confidence, and the aligner then has to climb back out of it on evidence
     * alone. jsdom has no layout, so this is that case exactly.
     */
    const { onintent, root } = await mount();
    wheel(root, 900);
    vi.advanceTimersByTime(400);

    const reported = scrolls(onintent);
    expect(reported).toHaveLength(1);
    expect((reported[0] as { anchorToken: number | null }).anchorToken).toBeNull();
  });

  it('says nothing at all about a wheel that moved nothing', async () => {
    const { onintent, root } = await mount();
    wheel(root, 0);
    vi.advanceTimersByTime(400);
    expect(scrolls(onintent)).toHaveLength(0);
  });

  it('measures where the document ended up, not what the wheel added up to', async () => {
    /*
     * The document clamps at both ends; the wheel does not. Flick up at the top
     * of the script and straight back down, and the raw deltas sum to zero
     * while the page has genuinely moved a screen — so a summed-delta rule read
     * a real relocation as "nothing happened" and told the aligner nothing,
     * which is the one thing this report exists to prevent.
     */
    const { onintent, root } = await mount();
    wheel(root, -1000); // absorbed: already at the top
    wheel(root, 1000);
    vi.advanceTimersByTime(400);

    const reported = scrolls(onintent);
    expect(reported).toHaveLength(1);
    expect((reported[0] as { deltaPx: number }).deltaPx).toBeGreaterThan(0);
  });

  it('reports what the document could actually give, not what was asked for', async () => {
    // Scrolling harder than the script is long is a real gesture with a real,
    // smaller answer.
    const { onintent, root } = await mount();
    wheel(root, 5_000_000);
    vi.advanceTimersByTime(400);

    const [reported] = scrolls(onintent) as { deltaPx: number }[];
    expect(reported).toBeDefined();
    expect(reported!.deltaPx).toBeGreaterThan(0);
    expect(reported!.deltaPx).toBeLessThan(5_000_000);
  });
});

/**
 * A key, pressed the way a browser delivers it: on the window, where the stage
 * listens.
 */
function key(name: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }),
  );
}

const kinds = (onintent: ReturnType<typeof vi.fn>) =>
  onintent.mock.calls.map(([intent]) => (intent as StageIntent).kind);

describe('the arrow and Page keys report where they put the document (#282)', () => {
  /*
   * The keys used to send a DIRECTION — "one step forward" — which control
   * spent as exactly one sentence from wherever the aligner was. Page Down
   * moved the glass most of a screen and the answer for one sentence on then
   * dragged it back. The fix is that a key is a gesture like any other: the
   * stage says where the document went, and only the stage can.
   *
   * The token that report carries comes off the line map, which jsdom cannot
   * build, so the anchor itself is proved in the browser
   * (`tests/e2e/browser/keyboard-manual-scroll.spec.ts`). What this pins is the
   * shape: what is reported, how much, and how often.
   */
  it('Page Down reports the travel it made, once the keys go quiet', async () => {
    const { onintent } = await mount();

    key('PageDown');
    vi.advanceTimersByTime(150);
    expect(kinds(onintent)).toEqual([]);

    vi.advanceTimersByTime(100);
    // A position, never a step request: nothing else is sent for a key.
    expect(kinds(onintent)).toEqual(['manual_scroll']);
    const [down] = scrolls(onintent) as { deltaPx: number }[];
    expect(down!.deltaPx).toBeGreaterThan(0);

    // Page Up from there comes back exactly as far: the report is the
    // document's travel, so the two presses are the same distance.
    key('PageUp');
    vi.advanceTimersByTime(400);
    const reported = scrolls(onintent) as { deltaPx: number }[];
    expect(reported).toHaveLength(2);
    expect(reported[1]!.deltaPx).toBe(-down!.deltaPx);
  });

  it('a held Page Down is one gesture and one report', async () => {
    /*
     * A held key repeats every few tens of milliseconds. A report per repeat is
     * a race: the engine's answer to one press can arrive after the next has
     * landed, name a line the hand has already left, and pull the document
     * back a page.
     */
    const { onintent } = await mount();
    key('PageDown');
    vi.advanceTimersByTime(400);
    const [single] = scrolls(onintent) as { deltaPx: number }[];

    key('PageDown');
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(40);
      key('PageDown', { repeat: true });
    }
    vi.advanceTimersByTime(400);

    const reported = scrolls(onintent) as { deltaPx: number }[];
    expect(reported).toHaveLength(2);
    expect(reported[1]!.deltaPx).toBeCloseTo(4 * single!.deltaPx, 6);
  });

  it('the arrow keys report a line of travel the same way', async () => {
    const { onintent } = await mount();
    key('ArrowDown');
    vi.advanceTimersByTime(400);
    expect(kinds(onintent)).toEqual(['manual_scroll']);
    const [line] = scrolls(onintent) as { deltaPx: number }[];
    expect(line!.deltaPx).toBeGreaterThan(0);

    key('ArrowUp');
    vi.advanceTimersByTime(400);
    expect((scrolls(onintent)[1] as { deltaPx: number }).deltaPx).toBe(-line!.deltaPx);
  });

  it('says nothing for a key the document could not answer', async () => {
    // Already at the top: Page Up and the up arrow move nothing, and a key that
    // moved nothing must not re-anchor the tracker on the reading line.
    const { onintent } = await mount();
    key('ArrowUp');
    key('PageUp');
    vi.advanceTimersByTime(400);
    expect(kinds(onintent)).toEqual([]);
  });

  it('a wheel and a key in one breath are one gesture', async () => {
    // Two reports for one movement would also put two corrections in the
    // summary, and the first would be a claim the second immediately revises.
    const { onintent, root } = await mount();
    wheel(root, 100);
    vi.advanceTimersByTime(50);
    key('PageDown');
    vi.advanceTimersByTime(400);

    const reported = scrolls(onintent) as { deltaPx: number }[];
    expect(reported).toHaveLength(1);
    expect(reported[0]!.deltaPx).toBeGreaterThan(100);
  });
});
