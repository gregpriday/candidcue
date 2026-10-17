/**
 * #218 — `fidelityMode` and `semanticRequestLimit` are read by nothing, so the
 * following adapter neither maps them in nor sends them back.
 *
 * Rust still stores `fidelityMode` until its half of the removal lands, and its
 * `merge_json` keeps a key the patch omits, so not sending it changes nothing
 * there. These pin the pure adapter; `settings-retired-keys.test.ts` drives the
 * same path through the real service.
 */
import { describe, expect, it } from 'vitest';
import {
  followingFromRust,
  followingToRustPatch,
} from '../../../src/control/services/settings-following';
import {
  clampFollowing,
  defaultFollowingSettings,
} from '../../../src/control/lib/follow-profiles';

const SURVIVING = ['developerDiagnostics', 'feel', 'motionProfileId'];

describe('#218 the following adapter carries only what something reads', () => {
  it('a document carrying the retired fields reads exactly as one without them', () => {
    const current = { feel: 'calm', motionProfileId: 'default-v4', developerDiagnostics: true };
    const legacy = { ...current, fidelityMode: 'exact', semanticRequestLimit: 40 };

    const loaded = followingFromRust(legacy);
    expect(loaded).toStrictEqual(followingFromRust(current));
    expect(Object.keys(loaded).sort()).toEqual(SURVIVING);
    expect(loaded.feel).toBe('calm');
    expect(loaded.developerDiagnostics).toBe(true);
  });

  it('defaults and the clamp hold only the surviving fields', () => {
    expect(Object.keys(defaultFollowingSettings()).sort()).toEqual(SURVIVING);
    const clamped = clampFollowing({ fidelityMode: 'exact', semanticRequestLimit: 12 } as never);
    expect(clamped).toStrictEqual(defaultFollowingSettings());
  });

  it('a legacy-shaped patch sends neither retired field', () => {
    const patch = followingToRustPatch({
      feel: 'responsive',
      fidelityMode: 'conversational',
      semanticRequestLimit: 5,
    } as never);
    expect(patch).toEqual({ feel: 'responsive' });
  });

  it('a patch of nothing but retired fields sends nothing', () => {
    expect(followingToRustPatch({ fidelityMode: 'exact', semanticRequestLimit: null } as never)).toEqual(
      {},
    );
  });

  it('a whole-section save sends the surviving fields and nothing else', () => {
    const patch = followingToRustPatch({ ...defaultFollowingSettings(), feel: 'calm' });
    expect(Object.keys(patch).sort()).toEqual(SURVIVING);
    expect(patch.feel).toBe('calm');
  });
});
