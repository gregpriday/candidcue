/**
 * The transport's end report, as the renderer makes it (#276).
 *
 * Control reads where a take ended off this report when the transport carried
 * it, because auto-scroll pauses following and the aligner publishes nothing
 * while the script rolls. So the report has to say WHICH end it was: a
 * document that ran off the bottom is a place in the script, and a document
 * with nowhere to go moved nothing at all and must not be credited as read.
 *
 * Only the nowhere-to-go end is reachable here. jsdom measures every rect as
 * zero, so no line map is ever built and the transport never takes a real
 * step — which is exactly the state an empty document is in on real glass, and
 * the one this file can therefore drive honestly. The document-end branch sits
 * behind a line map; it is typed by the same callback, and its consequences for
 * the take are pinned in `tests/unit/control/take-part-bounds.test.ts`.
 */
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  type StageAutoScrollPayload,
  type StageRenderDocument,
} from '../../src/shared/contracts';

const ScriptLayer = (await import('../../src/stage/renderer/ScriptLayer.svelte')).default;

/** A faithful rAF queue: ids are handed out, and cancelling really cancels. */
let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
let now = 0;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[], self: unknown) => void) {}
    observe(target: Element): void {
      this.cb([{ target }], this);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  // A real viewport: the transport does nothing at all before it has one.
  for (const [prop, value] of [
    ['clientWidth', 1200],
    ['clientHeight', 800],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frameQueue.set(id, cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    frameQueue.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;
});

beforeEach(() => {
  frameQueue = new Map();
  nextFrameId = 1;
  now = 0;
});

afterEach(() => {
  frameQueue.clear();
});

function pumpFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    const batch = [...frameQueue.values()];
    frameQueue.clear();
    now += 16;
    for (const cb of batch) cb(now);
    flushSync();
  }
}

/** A script with no words: padding makes it taller than the glass, and empty. */
function emptyDoc(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Empty',
    blocks: [],
    tokenToNode: [],
    assets: {},
    sentences: [],
  };
}

const RUNNING: StageAutoScrollPayload = { running: true, wordsPerMinute: 140 };
const STOPPED: StageAutoScrollPayload = { running: false, wordsPerMinute: 140 };

function mountLayer() {
  const onautoscrollend = vi.fn();
  const result = render(ScriptLayer, {
    props: {
      doc: emptyDoc(),
      settings: buildStageSettings(),
      followProfile: DEFAULT_SMOOTH_FOLLOW_PROFILE,
      autoScroll: STOPPED,
      onautoscrollend,
    },
  });
  return { onautoscrollend, result };
}

describe('the transport reports which end it reached', () => {
  it('reports a document with nowhere to go as nowhere_to_go, on the first frame, once', async () => {
    const { onautoscrollend, result } = mountLayer();
    // Settle the layout first, so the report can be pinned to a frame.
    pumpFrames(3);
    expect(onautoscrollend).not.toHaveBeenCalled();

    await result.rerender({ autoScroll: RUNNING });
    pumpFrames(1);
    expect(onautoscrollend).toHaveBeenCalledTimes(1);
    expect(onautoscrollend).toHaveBeenCalledWith('nowhere_to_go');

    // Once, not once per frame: a report every frame would stand down a
    // transport control has already stood down, sixty times a second.
    pumpFrames(5);
    expect(onautoscrollend).toHaveBeenCalledTimes(1);
    result.unmount();
  });

  it('reports again when the transport is started again', async () => {
    /*
     * The latch used to be released only on the path that clears a seeded
     * target, and a run with nowhere to go never seeds one — so the second
     * press of the key ran a transport that could never announce its end, and
     * following stayed paused for a take with nothing to roll.
     */
    const { onautoscrollend, result } = mountLayer();
    pumpFrames(3);
    await result.rerender({ autoScroll: RUNNING });
    pumpFrames(3);
    expect(onautoscrollend).toHaveBeenCalledTimes(1);

    // Control stands the transport down on the report, as it does in a take,
    // and a stood-down transport reports nothing.
    await result.rerender({ autoScroll: STOPPED });
    pumpFrames(3);
    expect(onautoscrollend).toHaveBeenCalledTimes(1);

    await result.rerender({ autoScroll: RUNNING });
    pumpFrames(1);
    expect(onautoscrollend).toHaveBeenCalledTimes(2);
    expect(onautoscrollend).toHaveBeenLastCalledWith('nowhere_to_go');
    result.unmount();
  });
});
