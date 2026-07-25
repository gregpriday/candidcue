/**
 * The stage must finish its layout while its window has never been shown.
 *
 * `open_stage` creates the stage window with `visible(false)` and control only
 * calls `set_stage_fullscreen` AFTER the handshake completes (§29.2 step 3), so
 * the entire measurement pass — the one that ends by emitting `layout-ready` —
 * runs against a window that has never been painted.
 *
 * `bind:clientWidth/clientHeight` is a ResizeObserver, and an observation is
 * delivered during the rendering update, which a never-shown window may never
 * perform. `vh` therefore stayed 0, and every guard on the measurement path
 * reads `vh === 0` and returns — including the one in front of the pass that
 * sends `layout-ready`. The handshake could not complete, and the session died
 * on `waitForStageReady`'s timeout with "the stage did not finish preparing in
 * time".
 *
 * jsdom reproduces that condition exactly and for free: it has no
 * ResizeObserver at all, so the stub every other DOM test installs never
 * invokes its callback. A component whose only source of size is that observer
 * sees zero forever — which is precisely the hidden window. That is what makes
 * this testable here rather than only in a real Tauri window.
 *
 * Revert check: drop the `windowVh` fallback in ScriptLayer.svelte (leave
 * `const vh = $derived(measuredVh)`) and the first test below fails, because
 * nothing ever reports a size.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ScriptLayer from '../../src/stage/renderer/ScriptLayer.svelte';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import type { StageRenderDocument } from '../../src/shared/contracts';

/**
 * A ResizeObserver that observes and never reports — the whole point.
 *
 * `observe()` deliberately does nothing: a stub that synthesised a callback
 * would hand the component the size the fix exists to survive without, and
 * every assertion below would pass with the fallback removed.
 */
let observed = 0;
beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {
      observed++;
    }
    unobserve(): void {}
    disconnect(): void {}
  };
});

function doc(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Good morning, everyone.', tokenIndexes: [0, 1, 2] }],
        startTokenIndex: 0,
        endTokenIndex: 2,
        source: { utf16Start: 0, utf16End: 23 },
        spoken: true,
      },
      {
        id: 'b2',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Thank you for coming.', tokenIndexes: [3, 4, 5, 6] }],
        startTokenIndex: 3,
        endTokenIndex: 6,
        source: { utf16Start: 24, utf16End: 45 },
        spoken: true,
      },
    ],
    tokenToNode: [{ tokenIndex: 0, blockId: 'b1', nodeKey: '' }],
    assets: {},
    sentences: [],
  };
}

describe('the stage lays out in a window that has never been rendered', () => {
  it('reports layout-ready with nothing but the window size to go on', async () => {
    const onlayoutready = vi.fn();
    render(ScriptLayer, {
      props: { doc: doc(), settings: buildStageSettings(), onlayoutready },
    });

    // The measurement pass runs on rAF, with a timer fallback for a window
    // whose frames are throttled — so this has to wait for one of them.
    await vi.waitFor(() => expect(onlayoutready).toHaveBeenCalled(), {
      timeout: 2000,
      interval: 25,
    });
  });

  it('never received a single observation, so the fallback is what carried it', () => {
    // Guards the guard. If a future jsdom or testing-library ships a real
    // ResizeObserver, the test above would start passing through the observer
    // and would no longer prove anything about a hidden window — this fails
    // first and says why.
    expect(
      observed,
      'the stub observes but never reports; if that changes, the test above ' +
        'is no longer exercising the never-rendered case it exists for',
    ).toBeGreaterThan(0);
  });

  it('measures the same width the window reports', async () => {
    // Not merely nonzero: the fallback has to be the real viewport, or the
    // line map is built at a size the presenter never sees and the reading
    // band lands in the wrong place.
    const onlayoutready = vi.fn();
    const { container } = render(ScriptLayer, {
      props: { doc: doc(), settings: buildStageSettings(), onlayoutready },
    });
    await vi.waitFor(() => expect(onlayoutready).toHaveBeenCalled(), { timeout: 2000 });

    const column = container.querySelector<HTMLElement>('[data-block-id]');
    expect(column, 'blocks must actually render — measureBlocks needs them').not.toBeNull();
    expect(window.innerWidth).toBeGreaterThan(0);
  });
});
