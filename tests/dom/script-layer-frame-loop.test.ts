/**
 * The frame loop must survive its own output.
 *
 * `ScriptLayer` runs one rAF loop for the life of the session and writes the
 * position it produces into `scrollY`, a `$state` rune. The loop is started and
 * stopped from an effect — and an effect that READS a rune it also (indirectly)
 * causes to be written re-runs on every write.
 *
 * That is not a tidiness problem. Tearing the loop down and rebuilding it runs
 * `engine.visibilityRestored()`, which is an AUTHORIZED PLANT OVERWRITE: it
 * re-anchors the controller to wherever the document currently is and zeroes
 * its velocity and acceleration. Doing that once per displayed frame leaves a
 * jerk-limited plant permanently inside its own jerk ramp — measured in the
 * browser preview, the document moved at about 1 px/s while the reading
 * position advanced at 35. The script highlighted the right words, the
 * presenter walked off the bottom of the glass, and the page never scrolled.
 * A teleprompter that does not prompt.
 *
 * So these tests count AUTHORITY, not pixels: how many times the renderer
 * claimed the right to overwrite the plant, and how many times it pumped the
 * engine. The stub engine's only real job is to report a position that CHANGES
 * every frame — that is the input which used to feed the loop back into itself.
 */
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import type { StageRenderDocument } from '../../src/shared/contracts';
import type { StageMotionEngine, StageMotionFrameResult } from '../../src/stage/motion';

/** Every plant-overwrite entry point the renderer can reach, plus the pump. */
const calls = {
  visibilityRestored: 0,
  layoutRecovery: 0,
  manualOverride: 0,
  reset: 0,
  frame: 0,
};

vi.mock('../../src/stage/motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/motion')>();
  return {
    ...actual,
    /*
     * The stub is DERIVED from a real engine rather than written out by hand.
     *
     * A hand-written literal is a copy of the interface that nothing keeps in
     * step — the sibling `script-layer-reanchor-fade.test.ts` still stubs
     * `receiveFrame` and `lastPrediction`, neither of which has existed on
     * `StageMotionEngine` for some time, and no test failed when they went. By
     * starting from `createStageMotionEngine()` and shadowing only the handful
     * of methods this file needs, everything else — including the live getters
     * `profile`, `map` and `lastDisplayToken` — stays real, and the
     * `StageMotionEngine` annotation makes `tsc` the guard when the interface
     * moves.
     */
    createStageMotionEngine: (
      ...args: Parameters<typeof actual.createStageMotionEngine>
    ): StageMotionEngine => {
      const real = actual.createStageMotionEngine(...args);
      // `Object.create`, not a spread: a spread would evaluate the engine's
      // getters once and freeze them at their initial values.
      const stub: StageMotionEngine = Object.create(real);
      return Object.assign(stub, {
        manualOverride(positionPx: number, nowMs: number) {
          calls.manualOverride++;
          real.manualOverride(positionPx, nowMs);
        },
        layoutRecovery(request: Parameters<StageMotionEngine['layoutRecovery']>[0]) {
          calls.layoutRecovery++;
          real.layoutRecovery(request);
        },
        visibilityRestored(positionPx: number, nowMs: number) {
          calls.visibilityRestored++;
          real.visibilityRestored(positionPx, nowMs);
        },
        reset(positionPx: number) {
          calls.reset++;
          real.reset(positionPx);
        },
        /*
         * A position that MOVES. The real engine holds at zero in jsdom (no
         * layout means no valid line map, so §62 makes it refuse to guess), and
         * a stub returning a constant would write the same value to `scrollY`
         * every frame — Svelte would coalesce it to no change at all and the
         * feedback loop this file exists to catch would be invisible.
         */
        frame(nowMs: number): StageMotionFrameResult {
          calls.frame++;
          return {
            scrollPx: nowMs,
            velocityPxS: 60,
            accelerationPxS2: 0,
            targetPx: nowMs + 100,
            activeLineId: null,
            lineProgress: 0,
            activeTokenIndex: null,
            source: 'alignment',
            state: 'following',
            suggestionToken: null,
            controllerState: 'alignment:following',
            styleTick: false,
            ack: null,
            degraded: false,
            hitch: false,
            documentOpacity: 1,
            reanchored: false,
          };
        },
      });
    },
  };
});

const { DEFAULT_SMOOTH_FOLLOW_PROFILE } = await import('../../src/shared/contracts');
const ScriptLayer = (await import('../../src/stage/renderer/ScriptLayer.svelte')).default;

/** A faithful rAF queue: ids are handed out, and cancelling really cancels. */
let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
let now = 0;
let documentHidden = false;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[], self: unknown) => void) {}
    observe(target: Element): void {
      this.cb([{ target }], this);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  for (const [prop, value] of [
    ['clientWidth', 1200],
    ['clientHeight', 800],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
  // jsdom's `document.hidden` is read-only and always false; the loop's
  // visibility branch is unreachable without this.
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => documentHidden,
  });
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
  documentHidden = false;
  calls.visibilityRestored = 0;
  calls.layoutRecovery = 0;
  calls.manualOverride = 0;
  calls.reset = 0;
  calls.frame = 0;
});

afterEach(() => {
  frameQueue.clear();
});

function pumpFrame(): void {
  const batch = [...frameQueue.values()];
  frameQueue.clear();
  now += 16;
  for (const cb of batch) cb(now);
  // Svelte batches state writes into a microtask; the browser flushes them
  // before it paints. Flushing here is what makes this "one frame".
  flushSync();
}

function doc(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Hello there', tokenIndexes: [0, 1] }],
        startTokenIndex: 0,
        endTokenIndex: 1,
        source: { utf16Start: 0, utf16End: 11 },
        spoken: true,
      },
    ],
    tokenToNode: [{ tokenIndex: 0, blockId: 'b1', nodeKey: '' }],
    assets: {},
    sentences: [],
  };
}

function mountLayer(props: { frozen?: boolean } = {}) {
  const result = render(ScriptLayer, {
    props: {
      doc: doc(),
      settings: buildStageSettings(),
      followProfile: DEFAULT_SMOOTH_FOLLOW_PROFILE,
      ...props,
    },
  });
  const plane = () =>
    result.container.querySelector('.script-layer .scroll-plane') as HTMLElement;
  return { plane, result };
}

/** The translate the plane is currently painted at, in document pixels. */
function translateY(plane: HTMLElement): number {
  const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(plane.style.transform);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

const FRAMES = 30;

describe('the frame loop is not restarted by its own scroll output', () => {
  it('claims no plant authority at all while it is simply running', () => {
    mountLayer();
    // Whatever starting the loop cost is the baseline; the invariant is about
    // what running it costs, which is nothing.
    const atStart = { ...calls };
    for (let i = 0; i < FRAMES; i++) pumpFrame();

    expect(calls.visibilityRestored - atStart.visibilityRestored).toBe(0);
    expect(calls.layoutRecovery - atStart.layoutRecovery).toBe(0);
    expect(calls.manualOverride - atStart.manualOverride).toBe(0);
    expect(calls.reset - atStart.reset).toBe(0);
  });

  it('re-anchors exactly once, when the loop starts', () => {
    mountLayer();
    for (let i = 0; i < FRAMES; i++) pumpFrame();
    // Thirty-one would mean the plant is reset on every displayed frame and can
    // never build speed — the shipped bug.
    expect(calls.visibilityRestored).toBe(1);
  });

  it('pumps the engine exactly once per frame — one loop, not several', () => {
    mountLayer();
    for (let i = 0; i < FRAMES; i++) pumpFrame();
    // A loop torn down and rebuilt leaves more than one live chain, and the
    // engine is pumped once per chain per frame.
    expect(calls.frame).toBe(FRAMES);
    expect(frameQueue.size).toBe(1);
  });

  it('paints every position the engine produced', () => {
    const { plane } = mountLayer();
    const seen: number[] = [];
    for (let i = 0; i < FRAMES; i++) {
      pumpFrame();
      seen.push(translateY(plane()));
    }

    // The stub advances 16 px a frame, so the document has to have travelled the
    // whole distance — the outcome the re-anchor loop destroyed.
    expect(seen[0]).toBe(-16);
    expect(seen[seen.length - 1]).toBe(-16 * FRAMES);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThan(seen[i - 1]!);
    }
  });
});

describe('the loop stops and restarts exactly once per lifecycle transition', () => {
  it('freezes and unfreezes with one re-anchor each way', async () => {
    const { plane, result } = mountLayer();
    for (let i = 0; i < 5; i++) pumpFrame();
    const frozenAt = translateY(plane());

    // §16.6 freeze: the loop stops, and a stopped loop cannot move the document
    // however many frames the browser offers it.
    await result.rerender({ frozen: true });
    for (let i = 0; i < 5; i++) pumpFrame();
    expect(translateY(plane())).toBe(frozenAt);
    expect(calls.visibilityRestored).toBe(1);

    // Unfreeze re-anchors once — to where the document actually is, which is the
    // whole reason the call exists — and motion resumes.
    await result.rerender({ frozen: false });
    for (let i = 0; i < 5; i++) pumpFrame();
    expect(calls.visibilityRestored).toBe(2);
    expect(translateY(plane())).toBeLessThan(frozenAt);
  });

  it('re-anchors once, not twice, when the window becomes visible again', () => {
    mountLayer();
    for (let i = 0; i < 5; i++) pumpFrame();
    expect(calls.visibilityRestored).toBe(1);

    documentHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    flushSync();
    const pumpedWhileHidden = calls.frame;
    for (let i = 0; i < 5; i++) pumpFrame();
    expect(calls.frame, 'a hidden window must not be pumped').toBe(pumpedWhileHidden);

    documentHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    flushSync();
    // Restoring visibility is ONE plant overwrite. It used to be two — the
    // handler re-anchored and then `startLoop()` re-anchored again — which is
    // harmless but leaves two places owning one decision.
    expect(calls.visibilityRestored).toBe(2);
    for (let i = 0; i < 5; i++) pumpFrame();
    expect(calls.frame).toBeGreaterThan(pumpedWhileHidden);
    expect(frameQueue.size).toBe(1);
  });

  it('leaves nothing scheduled after unmount', () => {
    const { result } = mountLayer();
    for (let i = 0; i < 5; i++) pumpFrame();
    result.unmount();
    flushSync();
    expect(frameQueue.size).toBe(0);
  });
});
