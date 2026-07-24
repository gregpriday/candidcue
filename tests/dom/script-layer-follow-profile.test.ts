/**
 * B4, the seam that was actually missing (§47.1).
 *
 * `resolveFollowProfile` was correct, `createStageMotionEngine` accepted a
 * profile, and ScriptLayer called it with NO ARGUMENTS — so every Follow feel
 * produced identical motion. Testing either end proves nothing about that; this
 * mounts the real component and asks the engine inside it which profile it is
 * running on.
 *
 * Reverting the wire (`createStageMotionEngine()` with no options, or dropping
 * the `$effect` that keeps it in sync) turns these red.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it } from 'vitest';
import ScriptLayer from '../../src/stage/renderer/ScriptLayer.svelte';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import {
  defaultFollowingSettings,
  resolveFollowProfile,
} from '../../src/control/lib/follow-profiles';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  type SmoothFollowProfile,
  type StageRenderDocument,
} from '../../src/shared/contracts';

// Svelte 5's `bind:clientWidth` installs a ResizeObserver; jsdom has none.
beforeAll(() => {
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

function doc(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Hello', tokenIndexes: [0] }],
        startTokenIndex: 0,
        endTokenIndex: 0,
        source: { utf16Start: 0, utf16End: 5 },
        spoken: true,
      },
    ],
    tokenToNode: [{ tokenIndex: 0, blockId: 'b1', nodeKey: '' }],
    assets: {},
    sentences: [],
  };
}

function feel(which: 'calm' | 'balanced' | 'responsive'): SmoothFollowProfile {
  return resolveFollowProfile({ ...defaultFollowingSettings(), feel: which });
}

interface LayerExports {
  motionDiagnostics(): { profileId: string; profileVersion: number };
}

function mountLayer(followProfile?: SmoothFollowProfile) {
  const result = render(ScriptLayer, {
    props: { doc: doc(), settings: buildStageSettings(), followProfile },
  });
  const exports = result.component as unknown as LayerExports;
  return {
    profileId: () => exports.motionDiagnostics().profileId,
    rerender: result.rerender,
  };
}

describe('the resolved follow profile reaches the motion engine', () => {
  it('runs the engine on a non-default feel', () => {
    const responsive = feel('responsive');
    const layer = mountLayer(responsive);

    expect(layer.profileId()).toBe(responsive.id);
    // And that id is genuinely not the default — otherwise the assertion above
    // would also pass with the wire cut.
    expect(responsive.id).not.toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE.id);
  });

  it('keeps the engine default when no profile was sent', () => {
    expect(mountLayer(undefined).profileId()).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE.id);
  });

  it('adopts a profile that changes after mount', async () => {
    // The real ordering when a stage window is reused for a second take: the
    // component instance survives, the envelope does not. A construction-only
    // read would leave take two running take one's feel.
    const layer = mountLayer(feel('calm'));
    expect(layer.profileId()).toBe(feel('calm').id);

    const responsive = feel('responsive');
    await layer.rerender({ followProfile: responsive });

    expect(layer.profileId()).toBe(responsive.id);
  });
});
