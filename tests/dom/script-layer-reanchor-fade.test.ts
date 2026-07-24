/**
 * §20.4 — the renderer half of the re-anchor transition.
 *
 * The engine decides WHEN the document may move and how dim it is while it
 * does (tests/unit/stage/reanchor-fade.test.ts). What it cannot decide on its
 * own is whether the two ever reach the glass together: opacity applied to a
 * different element, or handed to a CSS transition, or simply not bound, would
 * leave the engine's guarantee true and the presenter still watching the script
 * fly across the screen.
 *
 * So this mounts the real ScriptLayer over a scripted engine and reads the
 * actual `.scroll-plane` after each frame. The claim under test is the ordering
 * one: the frame on which `transform` changes is painted at `opacity: 0`.
 *
 * The frame clock is injected — `requestAnimationFrame` is a queue this file
 * pumps by hand — so nothing here depends on wall-clock timing.
 */
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import type { StageRenderDocument } from '../../src/shared/contracts';

/** One scripted engine frame: where the document is, and how visible it is. */
interface ScriptedFrame {
  scrollPx: number;
  documentOpacity: number;
}

/**
 * The sequence a re-anchor produces: hold at 2000 while the fade runs down,
 * move to 400 on the frame that reaches zero, hold there while it comes back
 * up. Deliberately written out rather than computed, so this file tests the
 * WIRING and the engine's own suite tests the sequence.
 */
const SCRIPT: ScriptedFrame[] = [
  { scrollPx: 2000, documentOpacity: 1 },
  { scrollPx: 2000, documentOpacity: 1 },
  { scrollPx: 2000, documentOpacity: 0.7 },
  { scrollPx: 2000, documentOpacity: 0.4 },
  { scrollPx: 2000, documentOpacity: 0.1 },
  // The obscured frame: this is the only one on which the document moves.
  { scrollPx: 400, documentOpacity: 0 },
  { scrollPx: 400, documentOpacity: 0.3 },
  { scrollPx: 400, documentOpacity: 0.6 },
  { scrollPx: 400, documentOpacity: 0.9 },
  { scrollPx: 400, documentOpacity: 1 },
];

/**
 * Keyed by the injected timestamp, not by a call counter: the real engine is
 * pure with respect to time, and the harness's stubbed `cancelAnimationFrame`
 * lets more than one rAF chain survive a remount. Anything counting calls would
 * be measuring the stub.
 */
function scripted(nowMs: number): ScriptedFrame {
  const index = Math.max(0, Math.min(Math.round(nowMs / 16) - 1, SCRIPT.length - 1));
  return SCRIPT[index] ?? { scrollPx: 0, documentOpacity: 1 };
}

vi.mock('../../src/stage/motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/motion')>();
  return {
    ...actual,
    createStageMotionEngine: () => ({
      receiver: { setGate() {}, reset() {}, setProfile() {}, stats: {}, gate: {} },
      controller: { state: { q: 0 } },
      transitions: {},
      diagnostics: { degraded: false, metrics: {} },
      map: null,
      profile: { id: 'default-v1', version: 1 },
      lastPrediction: null,
      unitAxis: {},
      targetRegressions: 0,
      latchReanchors: 0,
      deferredPlantOverwrites: 0,
      reanchorFades: 0,
      configureSession() {},
      setProfile() {},
      setLineMap() {},
      setBounds() {},
      setReducedMotion() {},
      setPaused() {},
      receiveFrame: () => false,
      setFallbackTarget() {},
      manualOverride() {},
      layoutRecovery() {},
      visibilityRestored() {},
      reset() {},
      frame: (nowMs: number) => {
        const at = scripted(nowMs);
        return {
          scrollPx: at.scrollPx,
          velocityPxS: 0,
          accelerationPxS2: 0,
          targetPx: at.scrollPx,
          activeLineId: null,
          lineProgress: 0,
          activeTokenIndex: null,
          source: 'semantic',
          state: 'following',
          controllerState: 'semantic:following',
          styleTick: false,
          ack: null,
          degraded: false,
          hitch: false,
          documentOpacity: at.documentOpacity,
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
  // Svelte batches state writes into a microtask. Flushing here is exactly what
  // the browser does before it paints, which is the only reason it is legitimate
  // to call the resulting DOM "one frame".
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

function mountLayer() {
  const result = render(ScriptLayer, {
    props: {
      doc: doc(),
      settings: buildStageSettings(),
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

describe('§20.4 — the fade and the transform land on the same element together', () => {
  it('changes the transform only on a frame painted at zero opacity', () => {
    const { plane } = mountLayer();
    const seen: { y: number; opacity: string }[] = [];
    for (let i = 0; i < SCRIPT.length + 1; i++) {
      pumpFrame();
      seen.push({ y: translateY(plane()), opacity: plane().style.opacity });
    }

    let moves = 0;
    for (let i = 1; i < seen.length; i++) {
      const before = seen[i - 1];
      const after = seen[i];
      if (!before || !after) continue;
      if (Math.abs(after.y - before.y) < 1) continue;
      moves++;
      // The whole specification, expressed against the real DOM: whatever else
      // is true, the element was carrying `opacity: 0` at the instant its
      // transform changed.
      expect(after.opacity, `moved to ${after.y} at opacity ${after.opacity}`).toBe('0');
    }
    expect(moves).toBe(1);
  });

  it('drives opacity per frame rather than handing it to a CSS transition', () => {
    const { plane } = mountLayer();
    const opacities: string[] = [];
    for (let i = 0; i < SCRIPT.length + 1; i++) {
      pumpFrame();
      opacities.push(plane().style.opacity);
    }
    // Every scripted value reached the element, in order — proof the renderer
    // is not interpolating on its own clock.
    expect(opacities.slice(0, SCRIPT.length)).toEqual(
      SCRIPT.map((f) => String(f.documentOpacity)),
    );
    // And the moving layer carries no transition of its own to race it (§31.2).
    expect(plane().style.transition).toBe('');
  });

  it('returns the plane to full opacity and marks the transition while it runs', () => {
    const { plane } = mountLayer();
    const flags: string[] = [];
    for (let i = 0; i < SCRIPT.length + 1; i++) {
      pumpFrame();
      flags.push(plane().getAttribute('data-reanchoring') ?? '');
    }
    expect(flags).toContain('true');
    expect(flags[flags.length - 1]).toBe('false');
    expect(plane().style.opacity).toBe('1');
  });

  it('keeps the reading treatment intact through the obscured frame', () => {
    const settings = buildStageSettings();
    const { layer, plane } = mountLayer();
    // Pump to the frame the document moves on.
    for (let i = 0; i < 6; i++) pumpFrame();
    expect(plane().style.opacity).toBe('0');

    // §22.4 / §61: the band geometry, the past and future ramps and the words'
    // own zoning are reading aids, not part of the transition. A re-anchor that
    // reset any of them would come back up looking like a different document.
    const style = layer().getAttribute('style') ?? '';
    expect(style).toContain(`--stage-past-opacity: ${settings.pastOpacity}`);
    expect(style).toContain(`--stage-future-opacity: ${settings.futureOpacity}`);
    expect(plane().style.paddingTop).not.toBe('');
    expect(plane().style.paddingBottom).not.toBe('');
    expect(layer().querySelectorAll('.w').length).toBeGreaterThan(0);

    // …and they are all still there once it has faded back up.
    for (let i = 0; i < 5; i++) pumpFrame();
    expect(plane().style.opacity).toBe('1');
    expect(layer().getAttribute('style') ?? '').toContain(
      `--stage-past-opacity: ${settings.pastOpacity}`,
    );
    expect(layer().querySelectorAll('.w').length).toBeGreaterThan(0);
  });
});
