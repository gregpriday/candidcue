/**
 * The control window's update flow (`src/control/stores/updates.ts`).
 *
 * What is proved here is WHEN the window asks and WHAT it shows — the schedule,
 * the switch, "Later", the manual answer, the install's progress and its
 * failures, and the never-during-a-take rules this side owns (hold the notice,
 * drop a toast, stand an install down). What is NOT proved here is what is safe:
 * Rust refuses an automatic check when the switch is off and an install during
 * a take, and verifies the signature (`src-tauri/src/updater.rs` tests that).
 */
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheckResult, UpdateProgress } from '../../../src/shared/contracts/updates';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  createUpdateController,
  type UpdateControllerDeps,
} from '../../../src/control/stores/updates';

const NEWER: UpdateCheckResult = {
  available: true,
  currentVersion: '0.1.0',
  version: '0.2.0',
  canInstall: true,
};
const NONE: UpdateCheckResult = { available: false, currentVersion: '0.1.0' };

function appError(code: string, userMessage = 'Rust said no.') {
  return {
    code,
    category: 'validation',
    userMessage,
    recoverable: true,
    correlationId: 'test',
  };
}

function harness(overrides: Partial<UpdateControllerDeps> = {}) {
  let progressListener: ((progress: UpdateProgress) => void) | null = null;
  const state = { takeActive: false, automatic: true };
  const deps = {
    check: vi.fn(async (_options: { automatic: boolean }): Promise<UpdateCheckResult> => NONE),
    install: vi.fn(async () => {}),
    listenForProgress: vi.fn((listener: (progress: UpdateProgress) => void) => {
      progressListener = listener;
      return () => {
        progressListener = null;
      };
    }),
    takeActive: vi.fn(() => state.takeActive),
    automaticChecksEnabled: vi.fn(() => state.automatic),
    prepareToQuit: vi.fn(async () => {}),
    report: vi.fn(),
    openDownloadPage: vi.fn(async () => {}),
    bringToFront: vi.fn(),
    ...overrides,
  };
  const controller = createUpdateController(deps);
  return {
    deps,
    state,
    controller,
    notice: () => get(controller.notice),
    emitProgress: (progress: UpdateProgress) => progressListener?.(progress),
  };
}

describe('the automatic schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks once shortly after launch, then every six hours', async () => {
    const { deps, controller } = harness();
    const stop = controller.start();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(deps.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(deps.check).toHaveBeenLastCalledWith({ automatic: true });

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(deps.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(deps.check).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(deps.check).toHaveBeenCalledTimes(3);
  });

  it('reads the switch at every tick, so turning it off stops the next check', async () => {
    const { deps, state, controller } = harness();
    state.automatic = false;
    controller.start();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(deps.check, 'off at launch: no request at all').not.toHaveBeenCalled();

    state.automatic = true;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(deps.check, 'on again: the next tick runs').toHaveBeenCalledTimes(1);
  });

  it('says nothing when an automatic check fails, and tries again later', async () => {
    const check = vi.fn(async () => {
      throw appError('UPDATE_CHECK_FAILED');
    });
    const { deps, controller, notice } = harness({ check });
    controller.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(deps.report).not.toHaveBeenCalled();
    expect(notice()).toEqual({ kind: 'hidden' });

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('offers an update it finds — and HOLDS it through a take rather than dropping it', async () => {
    const check = vi.fn(async () => NEWER);
    const { state, controller, notice, deps } = harness({ check });
    state.takeActive = true;
    controller.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);

    // The state is there; `UpdateNotice` draws nothing while the take is on.
    expect(notice()).toEqual({
      kind: 'available',
      version: '0.2.0',
      currentVersion: '0.1.0',
      canInstall: true,
    });
    expect(deps.bringToFront, 'an automatic find never raises the window').not.toHaveBeenCalled();
    expect(deps.report, 'and never toasts onto the glass').not.toHaveBeenCalled();
  });

  it('respects "Later" for that version until the next launch', async () => {
    const check = vi.fn(async () => NEWER);
    const { controller, notice } = harness({ check });
    controller.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(notice().kind).toBe('available');

    controller.later();
    expect(notice()).toEqual({ kind: 'hidden' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(notice(), 'the same version stays dismissed').toEqual({ kind: 'hidden' });

    check.mockResolvedValue({ ...NEWER, version: '0.3.0' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(notice(), 'a newer one is offered').toMatchObject({ kind: 'available', version: '0.3.0' });
  });
});

describe('Help › Check for Updates…', () => {
  it('says the app is up to date, naming the version, and brings the window forward', async () => {
    const { deps, controller } = harness();
    await controller.checkNow();
    expect(deps.check).toHaveBeenCalledWith({ automatic: false });
    expect(deps.report).toHaveBeenCalledWith('CandidCue is up to date (0.1.0).', 'success');
    expect(deps.bringToFront).toHaveBeenCalled();
  });

  it('offers an update even after "Later" dismissed it', async () => {
    const check = vi.fn(async () => NEWER);
    const { controller, notice, deps } = harness({ check });
    await controller.checkNow();
    controller.later();
    expect(notice().kind).toBe('hidden');

    await controller.checkNow();
    expect(notice()).toMatchObject({ kind: 'available', version: '0.2.0' });
    expect(deps.report, 'the notice is the answer; no toast as well').not.toHaveBeenCalled();
  });

  it('says what failed, in the copy registry’s words', async () => {
    const check = vi.fn(async () => {
      throw appError('UPDATE_CHECK_FAILED');
    });
    const { deps, controller } = harness({ check });
    await controller.checkNow();
    expect(deps.report).toHaveBeenCalledWith(
      expect.stringMatching(/could not reach the update server/i),
      'danger',
    );
  });

  it('drops its toast if a take started while it ran — a toast would be on the glass', async () => {
    let finish!: (result: UpdateCheckResult) => void;
    const check = vi.fn(
      () =>
        new Promise<UpdateCheckResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { deps, state, controller } = harness({ check });
    const pending = controller.checkNow();
    state.takeActive = true;
    finish(NONE);
    await pending;
    expect(deps.report).not.toHaveBeenCalled();
    expect(deps.bringToFront).not.toHaveBeenCalled();
  });
});

describe('Install and Restart', () => {
  async function offered(overrides: Partial<UpdateControllerDeps> = {}) {
    const h = harness({ check: vi.fn(async () => NEWER), ...overrides });
    await h.controller.checkNow();
    expect(h.notice().kind).toBe('available');
    return h;
  }

  it('flushes first, then installs, drawing Rust’s progress as it goes', async () => {
    let release!: () => void;
    const install = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const h = await offered({ install });
    const running = h.controller.install();
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(h.deps.prepareToQuit, 'the editor is flushed before anything is fetched').toHaveBeenCalled();
    expect(vi.mocked(h.deps.prepareToQuit).mock.invocationCallOrder[0]).toBeLessThan(
      install.mock.invocationCallOrder[0]!,
    );

    h.emitProgress({ phase: 'downloading', downloaded: 25, total: 100 });
    expect(h.notice()).toEqual({ kind: 'downloading', version: '0.2.0', fraction: 0.25 });
    h.emitProgress({ phase: 'downloading', downloaded: 10, total: null });
    expect(h.notice()).toEqual({ kind: 'downloading', version: '0.2.0', fraction: null });
    h.emitProgress({ phase: 'installing' });
    expect(h.notice()).toEqual({ kind: 'installing', version: '0.2.0' });

    release();
    await running;
    expect(h.notice()).toEqual({ kind: 'restarting', version: '0.2.0' });
  });

  it('installs nothing when a script could not be saved', async () => {
    const prepareToQuit = vi.fn(async () => {
      throw new Error('Your script has changes that could not be saved.');
    });
    const h = await offered({ prepareToQuit });
    await h.controller.install();
    expect(h.deps.install).not.toHaveBeenCalled();
    expect(h.notice()).toMatchObject({
      kind: 'failed',
      version: '0.2.0',
      message: 'Your script has changes that could not be saved.',
    });
  });

  it('stands down during a take — the notice is not even drawn then', async () => {
    const h = await offered();
    h.state.takeActive = true;
    await h.controller.install();
    expect(h.deps.prepareToQuit).not.toHaveBeenCalled();
    expect(h.deps.install).not.toHaveBeenCalled();
    expect(h.notice().kind).toBe('available');
  });

  it('goes back to offering the update when Rust refuses because a take began', async () => {
    const install = vi.fn(async () => {
      throw appError('UPDATE_BLOCKED_BY_TAKE');
    });
    const h = await offered({ install });
    await h.controller.install();
    expect(h.notice()).toEqual({
      kind: 'available',
      version: '0.2.0',
      currentVersion: '0.1.0',
      canInstall: true,
    });
  });

  it('reports any other failure on the notice, with a way to try again', async () => {
    const install = vi.fn(async (): Promise<void> => {
      throw appError('UPDATE_SIGNATURE_INVALID');
    });
    const h = await offered({ install });
    await h.controller.install();
    expect(h.notice()).toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/signature check/i),
    });

    /*
     * Try Again asks the server again before installing: Rust installs what
     * its last check found, so retrying without one would replay the same
     * bad answer even after the server had been put right.
     */
    const checksBefore = vi.mocked(h.deps.check).mock.calls.length;
    install.mockResolvedValueOnce(undefined);
    await h.controller.install();
    expect(vi.mocked(h.deps.check).mock.calls.length).toBe(checksBefore + 1);
    expect(h.deps.check).toHaveBeenLastCalledWith({ automatic: false });
    expect(install).toHaveBeenCalledTimes(2);
    expect(h.notice().kind).toBe('restarting');
  });

  it('a retry that finds nothing newer any more says so instead of installing', async () => {
    const install = vi.fn(async (): Promise<void> => {
      throw appError('UPDATE_DOWNLOAD_FAILED');
    });
    const h = await offered({ install });
    await h.controller.install();
    expect(h.notice().kind).toBe('failed');

    vi.mocked(h.deps.check).mockResolvedValue(NONE);
    await h.controller.install();
    expect(install).toHaveBeenCalledTimes(1);
    expect(h.notice()).toEqual({ kind: 'hidden' });
    expect(h.deps.report).toHaveBeenCalledWith('CandidCue is up to date (0.1.0).', 'success');
  });

  it('sends a copy that cannot replace itself to the download page instead', async () => {
    const h = await offered({ check: vi.fn(async () => ({ ...NEWER, canInstall: false })) });
    await h.controller.install();
    expect(h.deps.install).not.toHaveBeenCalled();
    expect(h.deps.openDownloadPage).toHaveBeenCalled();
    expect(h.notice()).toEqual({ kind: 'hidden' });
  });
});
