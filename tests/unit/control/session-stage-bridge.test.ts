/**
 * Stage bridge lifecycle in the live session store.
 *
 * `startStageBridge` registers its Tauri listeners behind an `await`, so a
 * stop/restart that lands before those promises settle used to (a) leave four
 * handlers with no disposer and (b) leave them gated on the MODULE-LEVEL
 * `stageGeneration`, which by then belonged to the next session — a dead
 * session's `escapeRequested` handler could stop the live one.
 *
 * The `listen()` mock here is deliberately deferred so the test can hold the
 * bridge open across a stop, which is the only way to reach the race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { CONTROL_EVENT, STAGE_EVENT } from '../../../src/shared/contracts';

interface Registration {
  event: string;
  handler: (payload: unknown) => void;
}

const tauri = vi.hoisted(() => {
  const registered: Array<{ event: string; handler: (payload: unknown) => void }> = [];
  const unlistened: string[] = [];
  let pending: Array<() => void> = [];
  const emitTo = vi.fn(async () => {});
  const listen = (event: string, handler: (payload: unknown) => void) =>
    new Promise<() => void>((resolve) => {
      pending.push(() => {
        registered.push({ event, handler });
        resolve(() => unlistened.push(event));
      });
    });
  return {
    registered,
    unlistened,
    emitTo,
    listen,
    /** Settle every outstanding `listen()` call. */
    release(): void {
      const batch = pending;
      pending = [];
      for (const fn of batch) fn();
    },
    pendingCount: (): number => pending.length,
    reset(): void {
      registered.length = 0;
      unlistened.length = 0;
      pending = [];
      emitTo.mockClear();
    },
  };
});

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({ emitTo: tauri.emitTo, listen: tauri.listen }));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../../src/control/services/smooth-follow-adapter', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/smooth-follow-adapter')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

/*
 * Warm the mocked event module. The store reaches it through a dynamic
 * `import()`, and under fake timers a cold module load is real I/O that
 * microtask flushing cannot wait for.
 */
await import('@tauri-apps/api/event');

const { clearSession, session, startLiveSession, stopSession, toggleBlankStage } = await import(
  '../../../src/control/stores/session'
);

function start(stageGeneration: number): string {
  return startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'manual',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    stageGeneration,
  });
}

/**
 * Real macrotask yield. Captured before `vi.useFakeTimers()` replaces it, so
 * the store's dynamic `import()` (which fake timers cannot advance) gets actual
 * event-loop turns while the heartbeat interval stays under the fake clock.
 */
const realSetTimeout = globalThis.setTimeout;

/** Let the dynamic imports and `Promise.all` plumbing settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

function find(event: string): Registration[] {
  return tauri.registered.filter((r) => r.event === event);
}

/** The bridge registers four listeners; wait until it has asked for them. */
const BRIDGE_LISTENER_COUNT = 4;

async function awaitBridgeRequest(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (tauri.pendingCount() >= BRIDGE_LISTENER_COUNT) return;
    await flush();
  }
  throw new Error(`bridge only issued ${tauri.pendingCount()} listen() calls`);
}

/** Let the bridge finish registering (and settle the post-await bookkeeping). */
async function completeBridge(): Promise<void> {
  await awaitBridgeRequest();
  tauri.release();
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  stage.publishStageDirective.mockClear();
});

afterEach(() => {
  clearSession();
  vi.useRealTimers();
});

describe('stage bridge listener lifecycle', () => {
  it('disposes listeners that arrive after the session already stopped', async () => {
    start(7);
    await awaitBridgeRequest();
    expect(tauri.registered).toHaveLength(0); // still mid-registration

    stopSession();
    tauri.release(); // session A's listen() promises settle into a dead session
    await flush();

    expect(tauri.registered).toHaveLength(BRIDGE_LISTENER_COUNT);
    // Every late arrival is unlistened immediately — nothing is left running.
    expect(tauri.unlistened.length).toBe(tauri.registered.length);
  });

  it('never lets a dead session’s escape handler stop the next session', async () => {
    start(7);
    await awaitBridgeRequest();
    stopSession();
    tauri.release();
    await flush();

    const stale = find(STAGE_EVENT.escapeRequested).at(-1);
    expect(stale).toBeDefined();

    clearSession();
    start(9);
    await completeBridge();
    expect(find(STAGE_EVENT.escapeRequested)).toHaveLength(2);
    expect(get(session).active).toBe(true);

    // Session A's handler, replayed with session B's generation. It is bound to
    // the generation it was created for, so it must ignore this.
    stale?.handler({ payload: { stageGeneration: 9, presses: 2 } });
    expect(get(session).active).toBe(true);

    // ...while session B's own handler still works, so the guard is real and
    // not just "escape never stops anything".
    const live = find(STAGE_EVENT.escapeRequested).at(-1);
    expect(live).not.toBe(stale);
    live?.handler({ payload: { stageGeneration: 9, presses: 2 } });
    expect(get(session).active).toBe(false);
  });

  it('unlistens on a normal stop', async () => {
    start(7);
    await completeBridge();
    expect(tauri.unlistened).toHaveLength(0);

    stopSession();
    expect(tauri.unlistened.length).toBe(tauri.registered.length);
  });
});

describe('stage closed (§62)', () => {
  async function startWithLiveBridge(): Promise<void> {
    start(7);
    await completeBridge();
  }

  it('stops the heartbeat and the directive stream instead of only toasting', async () => {
    await startWithLiveBridge();
    expect(get(session).stageAlive).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    // The heartbeat emits behind a dynamic import, so poll rather than assume
    // a fixed number of event-loop turns.
    for (let i = 0; i < 40 && tauri.emitTo.mock.calls.length === 0; i += 1) await flush();
    expect(tauri.emitTo).toHaveBeenCalled(); // heartbeat is running

    // Directives reach the stage while it is alive.
    toggleBlankStage();
    expect(stage.publishStageDirective).toHaveBeenCalledTimes(1);
    expect(get(session).stageBlanked).toBe(true);

    tauri.emitTo.mockClear();
    stage.publishStageDirective.mockClear();
    find(CONTROL_EVENT.stageClosed).at(-1)?.handler({ payload: { stageGeneration: 7 } });

    expect(get(session).stageAlive).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(tauri.emitTo).not.toHaveBeenCalled(); // heartbeat stopped

    // The quick-control no longer publishes into the void, and the UI state
    // does not pretend the stage changed.
    toggleBlankStage();
    expect(stage.publishStageDirective).not.toHaveBeenCalled();
    expect(get(session).stageBlanked).toBe(true);
  });

  it('ignores a close belonging to a different stage generation', async () => {
    await startWithLiveBridge();
    find(CONTROL_EVENT.stageClosed).at(-1)?.handler({ payload: { stageGeneration: 3 } });
    expect(get(session).stageAlive).toBe(true);
  });

  it('resets stageAlive for the next session', async () => {
    await startWithLiveBridge();
    find(CONTROL_EVENT.stageClosed).at(-1)?.handler({ payload: { stageGeneration: 7 } });
    expect(get(session).stageAlive).toBe(false);
    stopSession();
    start(9);
    expect(get(session).stageAlive).toBe(true);
  });
});
