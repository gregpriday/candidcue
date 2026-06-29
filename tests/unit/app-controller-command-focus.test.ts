import { describe, it, expect, vi } from 'vitest';

import { AppController } from '@main/app-controller';
import { NOOP_LOGGER } from '@main/interview/ports';
import type { SessionCommand } from '@shared/domain/runtime';

// Issue #58: the stage renderer registers its keyboard shortcuts on its own
// `window`, so they are dead until the stage window holds OS focus. command()
// must transfer focus to the stage when a session begins — and do so BEFORE
// awaiting begin(), because begin() only resolves after first-turn playback and
// the shortcuts must already work during that opening turn.

// A fake orchestrator exposing every method command() can dispatch to. begin()
// is injectable so a test can hold it pending and prove focus fires first.
function makeOrchestrator(begin: () => Promise<void>) {
  return {
    begin: vi.fn(begin),
    commitUserTurn: vi.fn(async () => {}),
    pause: vi.fn(() => {}),
    resume: vi.fn(async () => {}),
    repeatQuestion: vi.fn(async () => {}),
    skipQuestion: vi.fn(async () => {}),
    endAfterTurn: vi.fn(() => {}),
    endNow: vi.fn(async () => {}),
    retryRecovery: vi.fn(() => {}),
    getState: vi.fn(() => ({ phase: 'live' })),
  };
}

function makeController(focusStageWindow: () => void, orchestrator: ReturnType<typeof makeOrchestrator>) {
  const controller = new AppController({
    repository: {} as never,
    credentials: {} as never,
    logger: NOOP_LOGGER,
    videosRoot: '',
    getControl: () => null,
    getStage: () => null,
    ensureStageWindow: () => {
      throw new Error('not used');
    },
    isDisplayConnected: () => true,
    focusStageWindow,
  });
  // command() rejects every non-PREPARE command without an active session, so
  // inject a fake active to let BEGIN_SESSION (and the others) reach the switch.
  (controller as unknown as { active: { orchestrator: unknown } }).active = { orchestrator };
  return controller;
}

describe('AppController.command stage focus (#58)', () => {
  it('focuses the stage window exactly once when a session begins', async () => {
    const focus = vi.fn();
    const orch = makeOrchestrator(async () => {});
    const controller = makeController(focus, orch);

    const result = await controller.command({ type: 'BEGIN_SESSION' });

    expect(result.ok).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(orch.begin).toHaveBeenCalledTimes(1);
  });

  it('focuses the stage before begin() resolves, so shortcuts work during the opening turn', async () => {
    let resolveBegin: () => void = () => {};
    const beginGate = new Promise<void>((resolve) => {
      resolveBegin = resolve;
    });
    const focus = vi.fn();
    const orch = makeOrchestrator(() => beginGate);
    const controller = makeController(focus, orch);

    const pending = controller.command({ type: 'BEGIN_SESSION' });
    // begin() is still in flight (its gate is unresolved) yet focus already fired.
    await Promise.resolve();
    expect(orch.begin).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);

    resolveBegin();
    await pending;
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not focus the stage for any non-begin command', async () => {
    const focus = vi.fn();
    const orch = makeOrchestrator(async () => {});
    const controller = makeController(focus, orch);

    const others: SessionCommand[] = [
      { type: 'COMMIT_USER_TURN', reason: 'manual' },
      { type: 'PAUSE_SESSION' },
      { type: 'RESUME_SESSION' },
      { type: 'REPEAT_QUESTION' },
      { type: 'SKIP_QUESTION' },
      { type: 'END_AFTER_TURN' },
      { type: 'END_NOW' },
      { type: 'RETRY_RECOVERY' },
    ];
    for (const cmd of others) {
      await controller.command(cmd);
    }

    expect(focus).not.toHaveBeenCalled();
  });

  it('begins without throwing when no focusStageWindow dep is wired (optional dep)', async () => {
    const orch = makeOrchestrator(async () => {});
    // Construct without focusStageWindow to mirror existing test constructors.
    const controller = new AppController({
      repository: {} as never,
      credentials: {} as never,
      logger: NOOP_LOGGER,
      videosRoot: '',
      getControl: () => null,
      getStage: () => null,
      ensureStageWindow: () => {
        throw new Error('not used');
      },
      isDisplayConnected: () => true,
    });
    (controller as unknown as { active: { orchestrator: unknown } }).active = { orchestrator: orch };

    const result = await controller.command({ type: 'BEGIN_SESSION' });
    expect(result.ok).toBe(true);
    expect(orch.begin).toHaveBeenCalledTimes(1);
  });
});
