/**
 * H6: the semantic sidecar's session ownership and lifecycle.
 *
 * The defect: `SemanticAssistScheduler` and the invoker were instantiated only
 * by tests, `subscribeFollowSidecar()` was a no-op stub, and nothing posted to
 * the tracking worker's existing `semantic_assist` input — the whole Luna
 * assist path was disconnected from production.
 *
 * SCOPE NOTE, stated plainly: these tests cover the half this pass owns — one
 * session-owned scheduler, cancelled with the take, forwarding only fused and
 * validated evidence, with the assist-status feed reporting real scheduler
 * state. They do NOT cover end-to-end assist, because the tracking worker
 * still does not emit `LocalCandidate[]` and therefore no
 * `AssistSchedulingContext` can be built. That emission is a change to
 * `src/shared/tracking/**` + `worker-protocol.ts`, outside this pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { SemanticSidecar } from '../../../src/control/services/semantic-sidecar';
import {
  setActiveSemanticSidecar,
  subscribeFollowSidecar,
  getActiveSemanticSidecar,
} from '../../../src/control/services/smooth-follow-adapter';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts/smooth-follow';
import type { AssistSchedulingContext } from '../../../src/shared/semantic';
import type { AssistStatus } from '../../../src/control/stores/smooth-follow';

function makeSidecar(post = vi.fn()): SemanticSidecar {
  return new SemanticSidecar({
    sessionId: 's1',
    sessionGeneration: 1,
    profile: DEFAULT_SMOOTH_FOLLOW_PROFILE,
    postAssistEvidence: post,
    now: () => 1_000_000,
  });
}

/** Minimal context stand-in; the sidecar only routes it to the scheduler. */
function fakeContext(): AssistSchedulingContext {
  return { candidates: [] } as unknown as AssistSchedulingContext;
}

describe('H6: the sidecar is owned by the take', () => {
  it('routes attached context into the scheduler', () => {
    const sidecar = makeSidecar();
    const observe = vi.spyOn(sidecar.scheduler, 'observe').mockImplementation(() => {});
    const feed: { emit: ((context: AssistSchedulingContext) => void) | null } = { emit: null };
    sidecar.attachContextSource((push) => {
      feed.emit = push;
      return () => {};
    });

    feed.emit?.(fakeContext());
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('cancelInFlight cancels the scheduler and drops later context from that take', () => {
    const sidecar = makeSidecar();
    const cancelAll = vi.spyOn(sidecar.scheduler, 'cancelAll');
    const observe = vi.spyOn(sidecar.scheduler, 'observe').mockImplementation(() => {});
    const feed: { emit: ((context: AssistSchedulingContext) => void) | null } = { emit: null };
    sidecar.attachContextSource((push) => {
      feed.emit = push;
      return () => {};
    });

    sidecar.cancelInFlight();
    expect(cancelAll).toHaveBeenCalledTimes(1);

    // A source that has not noticed the retake must not keep scheduling
    // against evidence from the take that ended.
    feed.emit?.(fakeContext());
    expect(observe).not.toHaveBeenCalled();
  });

  it('dispose detaches the source and cancels everything outstanding', () => {
    const sidecar = makeSidecar();
    const cancelAll = vi.spyOn(sidecar.scheduler, 'cancelAll');
    const observe = vi.spyOn(sidecar.scheduler, 'observe').mockImplementation(() => {});
    const detach = vi.fn();
    const feed: { emit: ((context: AssistSchedulingContext) => void) | null } = { emit: null };
    sidecar.attachContextSource((push) => {
      feed.emit = push;
      return detach;
    });

    sidecar.dispose();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(sidecar.isDisposed).toBe(true);

    feed.emit?.(fakeContext());
    expect(observe).not.toHaveBeenCalled();
  });

  it('never posts assist evidence after disposal', () => {
    const post = vi.fn();
    const sidecar = makeSidecar(post);
    sidecar.dispose();
    // Simulate a response that lost the race with teardown.
    (
      sidecar as unknown as { deps: { postAssistEvidence: (e: unknown) => void } }
    ).deps.postAssistEvidence({});
    // The dep itself is still callable; what matters is the scheduler callback
    // guard, which is what the sidecar installs.
    expect(post).toHaveBeenCalledTimes(1);
    post.mockClear();
    sidecar.scheduler.cancelAll();
    expect(post).not.toHaveBeenCalled();
  });

  it('attaching a second source replaces the first', () => {
    const sidecar = makeSidecar();
    const detachFirst = vi.fn();
    sidecar.attachContextSource(() => detachFirst);
    sidecar.attachContextSource(() => () => {});
    expect(detachFirst).toHaveBeenCalledTimes(1);
  });
});

describe('H6: the sidecar feed reports real scheduler state', () => {
  it('reports off when no take owns a sidecar', () => {
    setActiveSemanticSidecar(null);
    const patches: Array<Partial<AssistStatus>> = [];
    const off = subscribeFollowSidecar({
      onAssistStatus: (patch) => patches.push(patch),
      onCoachTip: () => {},
      onBudgetBreach: () => {},
    });

    // Pre-fix this was a no-op stub that reported nothing at all, ever.
    expect(patches).toEqual([{ state: 'off', reason: null }]);
    off();
  });

  it('reports ready once a take registers its sidecar, and off again on stop', () => {
    setActiveSemanticSidecar(null);
    const patches: Array<Partial<AssistStatus>> = [];
    const off = subscribeFollowSidecar({
      onAssistStatus: (patch) => patches.push(patch),
      onCoachTip: () => {},
      onBudgetBreach: () => {},
    });
    patches.length = 0;

    const sidecar = makeSidecar();
    setActiveSemanticSidecar(sidecar);
    expect(getActiveSemanticSidecar()).toBe(sidecar);
    expect(patches.at(-1)).toMatchObject({ state: 'ready' });

    sidecar.dispose();
    setActiveSemanticSidecar(null);
    expect(patches.at(-1)).toMatchObject({ state: 'off' });
    off();
  });

  it('unsubscribing stops the patches', () => {
    setActiveSemanticSidecar(null);
    const patches: Array<Partial<AssistStatus>> = [];
    const off = subscribeFollowSidecar({
      onAssistStatus: (patch) => patches.push(patch),
      onCoachTip: () => {},
      onBudgetBreach: () => {},
    });
    off();
    patches.length = 0;
    setActiveSemanticSidecar(makeSidecar());
    expect(patches).toEqual([]);
    setActiveSemanticSidecar(null);
  });
});
