/**
 * S5 — §61 frame-performance degradation, step 1.
 *
 * Detection was real and the engine already backed its own styling cadence off,
 * but `degraded` never left the engine: the renderer did not know, so no
 * nonessential effect was ever disabled, and the mount site was never told.
 *
 * These mount the real ScriptLayer over a fake engine — the fake exists only so
 * the test can SAY "degraded" without having to starve a jsdom of frames — and
 * check the two things the wire is supposed to produce: a flag on the layer,
 * and a callback to the mount site. The BOUNDARY of step 1 — what degradation
 * is not allowed to turn off — is asserted in tests/unit/stage/degradation.test.ts.
 *
 * The last test is the important one. §61 says "disable nonessential visual
 * effects", and the reading band, the past/future dimming and the current-phrase
 * underlay are not effects — they are how the presenter finds their place. A
 * degradation that took those away would be a worse failure than dropped frames.
 */
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import type { StageRenderDocument } from '../../src/shared/contracts';

/* ---- a fake engine whose only interesting property is `degraded` ---- */

const engineState = { degraded: false };

vi.mock('../../src/stage/motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/motion')>();
  return {
    ...actual,
    // Everything else in the module (measurement, the line map, the fingerprint)
    // stays real; only the engine is replaced, so the component under test is
    // the real one and the only thing being dictated is `degraded`.
    createStageMotionEngine: () => ({
      receiver: { setGate() {}, reset() {}, setProfile() {}, stats: {}, gate: {} },
      controller: { state: { q: 0 } },
      transitions: {},
      diagnostics: { get degraded() { return engineState.degraded; }, metrics: {} },
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
      frame: () => ({
        scrollPx: 0,
        velocityPxS: 0,
        accelerationPxS2: 0,
        targetPx: 0,
        activeLineId: null,
        lineProgress: 0,
        activeTokenIndex: null,
        source: 'hold',
        state: null,
        controllerState: 'hold',
        styleTick: false,
        ack: null,
        degraded: engineState.degraded,
        hitch: false,
        documentOpacity: 1,
      }),
    }),
  };
});

const { DEFAULT_SMOOTH_FOLLOW_PROFILE } = await import('../../src/shared/contracts');
const ScriptLayer = (await import('../../src/stage/renderer/ScriptLayer.svelte')).default;

/* ---- a jsdom that has a size and a frame clock we control ---- */

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
  // jsdom has no layout, so `bind:clientHeight` would report 0 and the frame
  // loop (`vh > 0`) would never start.
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
  engineState.degraded = false;
  frameQueue = [];
  now = 0;
});

afterEach(() => {
  frameQueue = [];
});

/** Run every callback queued for the next animation frame. */
function pumpFrame(): void {
  const batch = frameQueue;
  frameQueue = [];
  now += 16;
  for (const cb of batch) cb(now);
  // Svelte batches state writes into a microtask; the assertions here are
  // synchronous, so force the flush the browser would do before the next paint.
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

function mountLayer(ondegraded?: (degraded: boolean) => void) {
  const result = render(ScriptLayer, {
    props: {
      doc: doc(),
      settings: buildStageSettings(),
      followProfile: DEFAULT_SMOOTH_FOLLOW_PROFILE,
      ondegraded,
    },
  });
  const layer = () => result.container.querySelector('.script-layer') as HTMLElement;
  return { layer, result };
}

describe('§61 degradation reaches the renderer', () => {
  it('flags the script layer once the engine reports degraded', () => {
    const { layer } = mountLayer();
    pumpFrame();
    expect(layer().getAttribute('data-degraded')).toBe('false');

    engineState.degraded = true;
    pumpFrame();
    expect(layer().getAttribute('data-degraded')).toBe('true');
  });

  it('tells the mount site, which reports on degradation too', () => {
    const seen: boolean[] = [];
    mountLayer((degraded) => seen.push(degraded));
    pumpFrame();

    engineState.degraded = true;
    pumpFrame();
    expect(seen).toEqual([true]);

    // …and back again: degradation is recoverable, and a layer left in its
    // simplified mode for the rest of the take would be a silent downgrade.
    engineState.degraded = false;
    pumpFrame();
    expect(seen).toEqual([true, false]);
  });

  it('does NOT disable the reading-band treatment', () => {
    // The band geometry, the past/future opacities and the phrase underlay are
    // reading aids, not effects. Whatever else degradation turns off, the
    // values the presenter reads by must be untouched.
    const settings = buildStageSettings();
    const { layer } = mountLayer();
    engineState.degraded = true;
    pumpFrame();

    const style = layer().getAttribute('style') ?? '';
    expect(style).toContain(`--stage-past-opacity: ${settings.pastOpacity}`);
    expect(style).toContain(`--stage-future-opacity: ${settings.futureOpacity}`);

    // The words still carry their zoning class, and the scroll plane still
    // carries the padding the reading band is measured against.
    const plane = layer().querySelector('.scroll-plane') as HTMLElement;
    expect(plane.style.paddingTop).not.toBe('');
    expect(layer().querySelectorAll('.w').length).toBeGreaterThan(0);

    // What degradation actually changes is one custom property that governs
    // transition DURATIONS and nothing else; that is asserted against the
    // stylesheet itself in tests/unit/stage/degradation.test.ts.
  });
});
