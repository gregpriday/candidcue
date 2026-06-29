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
  getProject?: () => Promise<unknown>;
}

function makeController(overrides: DepOverrides): AppController {
  return new AppController({
    repository: {
      getProject: overrides.getProject ?? (async () => null),
      getLatestPlan: async () => null,
    } as never,
    credentials: { hasKey: overrides.hasKey ?? (() => false) } as never,
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
    const plan = { id: 'plan-1', status: 'ready', sourceHash: 'hash-1' };
    const aggregate = { project: { sourceHash: 'hash-1' }, activePlan: plan };
    const state = await makeController({
      isDisplayConnected: () => false,
      hasKey: () => true,
      getProject: async () => aggregate,
    }).prepareSession(input('display-9'));

    // Every prerequisite is green so the disconnected display is the sole blocker.
    expect(check(state, 'openai')?.status).toBe('passed');
    expect(check(state, 'inworld')?.status).toBe('passed');
    expect(check(state, 'manifest')?.status).toBe('passed');

    expect(check(state, 'display')?.status).toBe('failed');
    expect(check(state, 'display')?.detail).toMatch(/no longer connected/i);
    expect(state.canBegin).toBe(false);
  });

  it('only emits checks declared by the narrowed contract', async () => {
    const state = await makeController({ isDisplayConnected: () => true }).prepareSession(input('display-9'));
    for (const c of state.checks) {
      expect(ALLOWED_CHECK_IDS.has(c.id)).toBe(true);
    }
  });
});
