import { describe, it, expect, vi } from 'vitest';

import { AppController } from '@main/app-controller';
import { NOOP_LOGGER } from '@main/interview/ports';
import type { PrepareSessionInput, PreflightState } from '@shared/contracts';

// The preflight contract only declares checks the main process actually runs.
// The `display` check validates that a previously-selected teleprompter display
// is still connected before a session may begin (issue #21).
const ALLOWED_CHECK_IDS = new Set(['openai', 'inworld', 'manifest', 'display', 'opening']);

interface DepOverrides {
  isDisplayConnected: (displayId: string | null) => boolean;
  hasKey?: () => boolean;
  getKey?: () => string | null;
  getProject?: () => Promise<unknown>;
  getLatestPlan?: () => Promise<unknown>;
}

function makeController(overrides: DepOverrides): AppController {
  return new AppController({
    repository: {
      getProject: overrides.getProject ?? (async () => null),
      getLatestPlan: overrides.getLatestPlan ?? (async () => null),
    } as never,
    credentials: {
      hasKey: overrides.hasKey ?? (() => false),
      getKey: overrides.getKey ?? (() => null),
    } as never,
    logger: NOOP_LOGGER,
    videosRoot: '',
    getControl: () => null,
    getStage: () => null,
    ensureStageWindow: () => {
      throw new Error('stage window must not be opened while a preflight check is failing');
    },
    isDisplayConnected: overrides.isDisplayConnected,
  });
}

function input(selectedDisplayId: string | null): PrepareSessionInput {
  return {
    projectId: 'project-1',
    config: {
      endpointMode: 'manual',
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedDisplayId,
      captionsEnabled: true,
      mirrorStage: false,
      zoom: 1,
      verticalOffsetPercent: 0,
    },
  };
}

function check(state: PreflightState, id: string) {
  return state.checks.find((c) => c.id === id);
}

describe('runPrepareSession display check', () => {
  it('treats a null display id as the primary display and passes without enumerating', async () => {
    // null means "use primary", which is always available, so the connectivity
    // probe must be short-circuited rather than consulted (it returns false for null).
    const isDisplayConnected = vi.fn(() => false);
    const state = await makeController({ isDisplayConnected }).prepareSession(input(null));

    expect(check(state, 'display')?.status).toBe('passed');
    expect(isDisplayConnected).not.toHaveBeenCalled();
  });

  it('passes when the selected display is still connected', async () => {
    const isDisplayConnected = vi.fn(() => true);
    const state = await makeController({ isDisplayConnected }).prepareSession(input('display-9'));

    expect(check(state, 'display')?.status).toBe('passed');
    expect(isDisplayConnected).toHaveBeenCalledWith('display-9');
  });

  it('fails the display check and blocks begin when the selected display is gone, even with every other check green', async () => {
    const plan = { id: 'plan-1', status: 'ready', sourceHash: 'hash-1', promptVersion: '1.1.0' };
    const aggregate = { project: { sourceHash: 'hash-1' }, activePlan: plan };
    // getKey is consulted only inside startOrchestrator (which the canBegin gate
    // guards). A valid key means that if `&& displayOk` were ever dropped from
    // the gate, the orchestrator path would actually be entered — so asserting
    // getKey is never called proves the display failure short-circuited the gate
    // rather than some downstream stub throw incidentally leaving canBegin false.
    const getKey = vi.fn(() => 'sk-test');
    const state = await makeController({
      isDisplayConnected: () => false,
      hasKey: () => true,
      getKey,
      getProject: async () => aggregate,
    }).prepareSession(input('display-9'));

    // Every prerequisite is green so the disconnected display is the sole blocker.
    expect(check(state, 'openai')?.status).toBe('passed');
    expect(check(state, 'inworld')?.status).toBe('passed');
    expect(check(state, 'manifest')?.status).toBe('passed');

    expect(check(state, 'display')?.status).toBe('failed');
    expect(check(state, 'display')?.detail).toMatch(/no longer connected/i);
    expect(state.canBegin).toBe(false);
    // The gate blocked before the orchestrator branch: opening carries the gate's
    // own message (not a downstream error) and no credentials were read.
    expect(check(state, 'opening')?.detail).toBe('Resolve the checks above first.');
    expect(getKey).not.toHaveBeenCalled();
  });

  it('fails the manifest check when the plan predates the current prompt version, even with a matching source hash', async () => {
    // A plan can be 'ready' with an up-to-date sourceHash yet have been prepared
    // under an older preparation prompt (e.g. before the launch-video coverage
    // beats landed, issue #64). The promptVersion gate must flag it stale so the
    // user re-prepares rather than starting on a plan missing the seeded beats.
    const plan = { id: 'plan-1', status: 'ready', sourceHash: 'hash-1', promptVersion: '1.0.0' };
    const aggregate = { project: { sourceHash: 'hash-1' }, activePlan: plan };
    const state = await makeController({
      isDisplayConnected: () => true,
      hasKey: () => true,
      getKey: () => 'sk-test',
      getProject: async () => aggregate,
    }).prepareSession(input('display-9'));

    // Source hash matches and the display is connected, so the stale prompt
    // version is the sole reason the plan is not ready.
    expect(check(state, 'display')?.status).toBe('passed');
    expect(check(state, 'manifest')?.status).toBe('failed');
    expect(check(state, 'manifest')?.detail).toMatch(/prepare/i);
    expect(state.canBegin).toBe(false);
  });

  it('passes the manifest check via the getLatestPlan fallback when no plan is active', async () => {
    // The gate resolves the plan as `aggregate.activePlan ?? getLatestPlan()`.
    // With no active plan, a current (1.1.0) latest plan whose source hash still
    // matches must satisfy the manifest check through that fallback branch.
    const aggregate = { project: { sourceHash: 'hash-1' }, activePlan: null };
    const latest = { id: 'plan-2', status: 'ready', sourceHash: 'hash-1', promptVersion: '1.1.0' };
    const state = await makeController({
      isDisplayConnected: () => true,
      getProject: async () => aggregate,
      getLatestPlan: async () => latest,
    }).prepareSession(input('display-9'));

    expect(check(state, 'manifest')?.status).toBe('passed');
  });

  it('emits exactly the checks declared by the narrowed contract, in order', async () => {
    const state = await makeController({ isDisplayConnected: () => true }).prepareSession(input('display-9'));
    expect(state.checks.map((c) => c.id)).toEqual(['openai', 'inworld', 'manifest', 'display', 'opening']);
    for (const c of state.checks) {
      expect(ALLOWED_CHECK_IDS.has(c.id)).toBe(true);
    }
  });
});
