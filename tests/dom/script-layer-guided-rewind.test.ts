/**
 * §30.5 — the renderer half of a guided rewind.
 *
 * The engine decides that an accepted retake is a visible backward walk and
 * produces the position trace for it (tests/unit/stage/guided-rewind.test.ts).
 * What it cannot decide on its own is what reaches the glass. A renderer that
 * rounded the fractional offset, or handed `.scroll-plane` a CSS transition, or
 * dimmed the document out of habit, would leave every engine assertion true and
 * the presenter still unable to keep their eye on the text.
 *
 * So this mounts the real ScriptLayer over a scripted engine — a rewind's worth
 * of small backward steps at full opacity — and reads the actual element after
 * each frame. The claim under test is the visibility one: the transform changes
 * a little at a time, and it does it while the document is fully readable.
 *
 * The frame clock is injected, so nothing here depends on wall-clock timing.
 */
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import type { StageRenderDocument } from '../../src/shared/contracts';

/**
 * A guided rewind from 2000 px to 400 px at the shipped ceiling.
 *
 * Deliberately computed from the ceiling rather than written out, because the
 * number that matters here is the per-frame STEP: three rendered lines a second
 * at a ~64 px pitch is 192 px/s, which is 3.2 px in a 16 ms frame — a twentieth
 * of a line, and the thing a rounding renderer destroys.
 */
const START_PX = 2000;
const END_PX = 400;
const STEP_PX = 192 / 60;
const FRAMES = Math.ceil((START_PX - END_PX) / STEP_PX) + 20;

function scripted(nowMs: number): { scrollPx: number; controllerState: string } {
  const index = Math.max(0, Math.round(nowMs / 16) - 1);
  const scrollPx = Math.max(END_PX, START_PX - index * STEP_PX);
  return {
    scrollPx,
    controllerState:
      scrollPx > END_PX ? 'alignment:following:rewind:guided_rewind' : 'alignment:following',
  };
}

vi.mock('../../src/stage/motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/motion')>();
  return {
    ...actual,
    createStageMotionEngine: () => ({
      receiver: { setGate() {}, reset() {}, setProfile() {}, stats: {}, gate: {} },
      controller: { state: { q: START_PX } },
      transitions: {},
      diagnostics: { degraded: false, metrics: {} },
      map: null,
      profile: { id: 'default-v1', version: 1 },
      lastPrediction: null,
      lastDisplayToken: null,
      unitAxis: {},
      targetRegressions: 0,
      latchReanchors: 0,
      deferredPlantOverwrites: 0,
      reanchorFades: 0,
      catchUpCapExpiries: 0,
      guidedRewindStarts: 1,
      guidedRewindCompletes: 0,
      guidedRewindCancels: 0,
      guidedRewindTimeouts: 0,
      guidedRewindBudgetExtensions: 0,
      awaitingManualEvidence: false,
      configureSession() {},
      setProfile() {},
      setLineMap() {},
      setBounds() {},
      setReducedMotion() {},
      setPaused() {},
      receiveFrame: () => false,
      receiveSnapshot: () => false,
      releaseAlignment() {},
      setFallbackTarget() {},
      manualOverride() {},
      layoutRecovery() {},
      visibilityRestored() {},
      reset() {},
      frame: (nowMs: number) => {
        const at = scripted(nowMs);
        return {
          scrollPx: at.scrollPx,
          velocityPxS: at.scrollPx > END_PX ? -192 : 0,
          accelerationPxS2: 0,
          targetPx: END_PX,
          activeLineId: null,
          lineProgress: 0,
          activeTokenIndex: null,
          source: 'alignment',
          state: 'following',
          suggestionToken: null,
          controllerState: at.controllerState,
          styleTick: false,
          ack: null,
          degraded: false,
          hitch: false,
          // The whole point: a guided rewind is never obscured.
          documentOpacity: 1,
        };
      },
    }),
  };
});

const { DEFAULT_SMOOTH_FOLLOW_PROFILE } = await import('../../src/shared/contracts');
const ScriptLayer = (await import('../../src/stage/renderer/ScriptLayer.svelte')).default;

let frameQueue: FrameRequestCallback[] = [];
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
  for (const [prop, value] of [
    ['clientWidth', 1200],
    ['clientHeight', 800],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frameQueue.push(cb);
    return frameQueue.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});

beforeEach(() => {
  frameQueue = [];
  now = 0;
});

afterEach(() => {
  frameQueue = [];
});

function pumpFrame(): void {
  const batch = frameQueue;
  frameQueue = [];
  now += 16;
  for (const cb of batch) cb(now);
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

function mountLayer(overrides: Partial<ReturnType<typeof buildStageSettings>> = {}) {
  const result = render(ScriptLayer, {
    props: {
      doc: doc(),
      settings: { ...buildStageSettings(), ...overrides },
      followProfile: DEFAULT_SMOOTH_FOLLOW_PROFILE,
    },
  });
  const layer = () => result.container.querySelector('.script-layer') as HTMLElement;
  const plane = () => layer().querySelector('.scroll-plane') as HTMLElement;
  return { layer, plane, result };
}

/** The translate the plane is currently painted at, in document pixels. */
function translateY(plane: HTMLElement): number {
  const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(plane.style.transform);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

function sampleRewind(plane: () => HTMLElement) {
  const seen: { y: number; opacity: string; reanchoring: string }[] = [];
  for (let i = 0; i < FRAMES; i++) {
    pumpFrame();
    const el = plane();
    seen.push({
      y: translateY(el),
      opacity: el.style.opacity,
      reanchoring: el.getAttribute('data-reanchoring') ?? '',
    });
  }
  return seen;
}

describe('§30.5 — a rewind reaches the glass as a visible walk', () => {
  it('moves a fraction of a line per frame instead of jumping the gap', () => {
    const { plane } = mountLayer();
    const seen = sampleRewind(plane);

    let moves = 0;
    let biggestStep = 0;
    for (let i = 1; i < seen.length; i++) {
      const before = seen[i - 1];
      const after = seen[i];
      if (!before || !after) continue;
      const step = Math.abs(after.y - before.y);
      if (step > 0.01) moves++;
      biggestStep = Math.max(biggestStep, step);
    }
    // Hundreds of small moves, and not one of them anything like the whole gap.
    expect(moves).toBeGreaterThan(200);
    expect(biggestStep).toBeLessThan(STEP_PX * 1.5);
    expect(biggestStep).toBeLessThan((START_PX - END_PX) * 0.01);
    // And it got where it was going.
    expect(Math.abs((seen[seen.length - 1]?.y ?? 0) - (seen[0]?.y ?? 0))).toBeGreaterThan(
      (START_PX - END_PX) * 0.9,
    );
  });

  it('keeps the sub-pixel offset while it moves, so the walk is not a stair', () => {
    /*
     * The renderer quantises the painted offset to the device pixel grid when
     * the plant reads as at rest, which is right for a stationary document and
     * ruinous for a slow one: at 3.2 px a frame a rounded transform is a visible
     * 1 px step several times a second, and on a 1024x600 panel there is no
     * spare resolution to hide that in.
     */
    const { plane } = mountLayer();
    const seen = sampleRewind(plane);
    const moving = seen.slice(1, -20);
    expect(moving.some((f) => !Number.isInteger(f.y))).toBe(true);
  });

  it('never dims the document and never claims to be re-anchoring', () => {
    const { plane } = mountLayer();
    const seen = sampleRewind(plane);
    expect(seen.every((f) => f.opacity === '1')).toBe(true);
    expect(seen.every((f) => f.reanchoring === 'false')).toBe(true);
  });

  it('paints the controller position itself, with no easing of its own', () => {
    /*
     * A second animation system — a CSS transition on `.scroll-plane`, a Svelte
     * tween, an interpolation on the renderer's own clock — would fight the one
     * persistent jerk-limited follower for the same property, and the symptom
     * would be a painted step that is not the step the engine produced.
     *
     * So the assertion is on the DELTAS: the element moves by exactly the
     * scripted `STEP_PX` every frame while the walk is running. jsdom resolves
     * no stylesheets, so reading `style.transition` here proves nothing either
     * way; this does.
     */
    const { plane } = mountLayer();
    const seen = sampleRewind(plane);
    const moving = seen.slice(2, -25);
    expect(moving.length).toBeGreaterThan(200);
    for (let i = 1; i < moving.length; i++) {
      const delta = Math.abs((moving[i]?.y ?? 0) - (moving[i - 1]?.y ?? 0));
      expect(delta).toBeCloseTo(STEP_PX, 6);
    }
  });

  it('walks the same way under vertical mirror', () => {
    const { plane } = mountLayer({ mirrorY: true });
    const seen = sampleRewind(plane);
    expect(seen.every((f) => f.opacity === '1')).toBe(true);
    let biggestStep = 0;
    for (let i = 1; i < seen.length; i++) {
      biggestStep = Math.max(biggestStep, Math.abs((seen[i]?.y ?? 0) - (seen[i - 1]?.y ?? 0)));
    }
    expect(biggestStep).toBeLessThan(STEP_PX * 1.5);
  });
});
