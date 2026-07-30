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
  /* §64: the heartbeat compares what control sent against what the stage
     applied. `exists: false` means "no stage to compare with", which is the
     right answer for a mock that is not modelling a stage window. */
  getStageStatus: vi.fn(async () => ({ exists: false })),
  publishStageDirective: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

vi.mock('@tauri-apps/api/event', () => ({ emitTo: tauri.emitTo, listen: tauri.listen }));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../../src/control/services/stage-acks', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/stage-acks')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

/*
 * Warm the mocked event module. The store reaches it through a dynamic
 * `import()`, and under fake timers a cold module load is real I/O that
 * microtask flushing cannot wait for.
 */
await import('@tauri-apps/api/event');

const {
  clearSession,
  dismissStageWindowFault,
  session,
  startLiveSession,
  stopSession,
  toggleBlankStage,
} = await import('../../../src/control/stores/session');
const { smoothFollow } = await import('../../../src/control/stores/smooth-follow');
const { toasts } = await import('../../../src/control/stores/toasts');

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

/** The bridge registers five listeners; wait until it has asked for them. */
const BRIDGE_LISTENER_COUNT = 5;

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

beforeEach(async () => {
  vi.useFakeTimers();
  /*
   * Drain whatever the previous test left mid-registration BEFORE resetting.
   * `listen()` resolves behind a dynamic import, so a bridge belonging to a
   * finished test can settle after `reset()` and queue a DEAD session's
   * handlers into this test's registry — where they sort after the live ones
   * and make `find(...).at(-1)` return a handler bound to the wrong stage
   * generation. That is a harness race, not a product one, and it is worth
   * closing here rather than tolerating a flaky assertion.
   */
  for (let i = 0; i < 5; i += 1) {
    tauri.release();
    await flush();
  }
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

/*
 * §16.9's first-press notice is for a SECOND person watching the control
 * window — a display the stage is not covering. On one display the stage is
 * frameless, sized to the monitor and always-on-top, so control sits behind
 * it on the exact same screen: nobody can be looking at control who is not
 * also looking at the stage's own on-screen hint. A solo presenter got the
 * toast anyway, every single press, on top of the on-stage hint saying the
 * same thing.
 */
describe('the first-press notice reflects whether a second display exists', () => {
  it('does not toast a solo, single-display setup', async () => {
    stage.listDisplays.mockResolvedValueOnce([{ fingerprint: 'display-0' }]);
    start(7);
    await completeBridge();

    const before = get(toasts).length;
    find(STAGE_EVENT.escapeRequested).at(-1)?.handler({ payload: { stageGeneration: 7, presses: 1 } });
    expect(get(toasts).length).toBe(before);
  });

  it('still toasts when a second display is present', async () => {
    stage.listDisplays.mockResolvedValueOnce([
      { fingerprint: 'display-0' },
      { fingerprint: 'display-1' },
    ]);
    start(7);
    await completeBridge();

    const before = get(toasts).length;
    find(STAGE_EVENT.escapeRequested).at(-1)?.handler({ payload: { stageGeneration: 7, presses: 1 } });
    expect(get(toasts).length).toBe(before + 1);
  });

  it('says nothing about the stop either, on a setup where nobody else saw it', async () => {
    /*
     * This used to announce the stop even solo, on the theory that control is
     * where the summary appears next. It is — which is the point: the F.17
     * summary is already there, saying it better. The toast added a second
     * announcement of an action the presenter had just taken deliberately, on
     * the screen the stage had been covering a moment earlier.
     */
    stage.listDisplays.mockResolvedValueOnce([{ fingerprint: 'display-0' }]);
    start(7);
    await completeBridge();

    const before = get(toasts).length;
    find(STAGE_EVENT.escapeRequested).at(-1)?.handler({ payload: { stageGeneration: 7, presses: 2 } });
    expect(get(toasts).length).toBe(before);
  });

  it('does announce the stop when an operator at a second display did not press it', async () => {
    // They watched the stage go dark without touching anything; this is the
    // line that says why.
    stage.listDisplays.mockResolvedValueOnce([
      { fingerprint: 'display-0' },
      { fingerprint: 'display-1' },
    ]);
    start(7);
    await completeBridge();

    const before = get(toasts).length;
    find(STAGE_EVENT.escapeRequested).at(-1)?.handler({ payload: { stageGeneration: 7, presses: 2 } });
    expect(get(toasts).length).toBe(before + 1);
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

    stage.publishStageDirective.mockClear();
    find(CONTROL_EVENT.stageClosed).at(-1)?.handler({ payload: { stageGeneration: 7 } });
    expect(get(session).stageAlive).toBe(false);

    /*
     * Settle BEFORE the baseline. Each heartbeat emits behind a dynamic
     * import, so one already in flight when the stage closed lands afterwards
     * — which is not the heartbeat still running, and clearing the spy first
     * recorded it as though it were.
     */
    await flush();
    tauri.emitTo.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    /*
     * The heartbeat specifically, not "nothing was emitted at all". A take now
     * starts prompting the moment it starts, so the driver is producing motion
     * frames on its own timer over these five seconds — which is the aligner
     * working, not the heartbeat failing to stop. Asserting on every `emitTo`
     * conflated the two.
     */
    const heartbeats = tauri.emitTo.mock.calls.filter(
      (call) => (call as unknown as [string, string])[1] === STAGE_EVENT.heartbeat,
    );
    expect(heartbeats).toEqual([]);

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

/*
 * §16.6 the `blank` directive, asserted on the PAYLOAD rather than the call.
 *
 * This used to live in tests/unit/control/listener-blank-directive.test.ts,
 * which was really two tests wearing one name: the Listener's `keepListener`
 * flag, and the plain blank/unblank pair underneath it. The Listener half went
 * with the feature (§106); this half did not, and every other blank assertion
 * in this file checks only that `publishStageDirective` was CALLED — which a
 * producer emitting the wrong kind, or the wrong `blanked` value, would still
 * satisfy.
 */
describe('the blank directive (§16.6)', () => {
  function blankDirectives(): unknown[] {
    return stage.publishStageDirective.mock.calls.map((call) => (call as unknown[])[2]);
  }

  it('sends the toggled state, and the unblank agrees with the blank', async () => {
    start(7);
    await completeBridge();
    stage.publishStageDirective.mockClear();

    toggleBlankStage();
    expect(get(session).stageBlanked).toBe(true);
    toggleBlankStage();
    expect(get(session).stageBlanked).toBe(false);

    // No `keepListener` — the flag left with the feature, and a directive that
    // still carried it would mean the stage contract had not actually changed.
    expect(blankDirectives()).toEqual([
      { kind: 'blank', blanked: true },
      { kind: 'blank', blanked: false },
    ]);
  });

  /*
   * §108: single-window presentation runs at stage generation 0, where
   * `sendDirective` intentionally no-ops (there is no separate stage window's
   * IPC to reach). `toggleBlankStage` must still flip `stageBlanked`
   * unconditionally — the embedded `StageApp` reads it off this store value
   * as a bridge prop instead of waiting for a directive that will never
   * arrive.
   */
  it('still flips stageBlanked at generation 0, where no directive can be sent', () => {
    start(0);
    stage.publishStageDirective.mockClear();

    toggleBlankStage();
    expect(get(session).stageBlanked).toBe(true);
    toggleBlankStage();
    expect(get(session).stageBlanked).toBe(false);

    expect(stage.publishStageDirective).not.toHaveBeenCalled();
  });
});

/*
 * S6 — §62 recoverable stage layout error.
 *
 * The stage held its motion when line measurement stayed unusable after the
 * bounded rebuild, and told nobody but its own on-glass diagnostics overlay:
 * there was no layout-error member in STAGE_EVENT at all, and control could
 * only learn about it by finding the substring `map_unresolved` inside a motion
 * ack's `controllerState`. The operator — who is at THIS window — had no way to
 * see it and no way to act on it.
 *
 * These drive the real store handler with the payload Rust relays.
 */
describe('stage layout failures (§62)', () => {
  async function startWithLiveBridge(): Promise<void> {
    start(7);
    await completeBridge();
  }

  function layoutEvent(payload: Record<string, unknown>): number {
    const handlers = find(STAGE_EVENT.layoutFailed);
    for (const handler of handlers) handler.handler({ payload });
    return handlers.length;
  }

  it('reaches control on its own event, not by sniffing another one', async () => {
    await startWithLiveBridge();
    expect(get(smoothFollow).lineMap.valid).toBe(true);

    layoutEvent({
      stageGeneration: 7,
      issues: ['map_unresolved', 'non_monotonic_baselines'],
      layoutGeneration: 4,
      atMs: 1000,
    });

    const state = get(smoothFollow);
    expect(state.lineMap.valid).toBe(false);
    expect(state.lineMap.detail).toContain('map_unresolved');
    // §62 wants a RECOVERABLE error: the operator is offered the rebuild.
    const notice = state.notices.find((n) => n.id === 'invalid_line_map');
    expect(notice?.action?.id).toBe('rebuild_layout');
  });

  it('arrives exactly once', async () => {
    await startWithLiveBridge();
    // The stage emits under `stage://layout-error` and Rust relays under
    // `stage://layout-failed`, because a webview emit is a broadcast that would
    // otherwise reach control twice — once ungated. Control registers exactly
    // one handler, for the relayed name only.
    expect(find(STAGE_EVENT.layoutError)).toHaveLength(0);
    expect(layoutEvent({ stageGeneration: 7, issues: ['x'], layoutGeneration: 1 })).toBe(1);

    const timeline = get(smoothFollow).timeline.filter((e) =>
      e.summary.toLowerCase().includes('line map invalid'),
    );
    expect(timeline).toHaveLength(1);
  });

  it('ignores a failure from a stage generation that is already gone', async () => {
    await startWithLiveBridge();
    layoutEvent({ stageGeneration: 3, issues: ['x'], layoutGeneration: 1 });
    expect(get(smoothFollow).lineMap.valid).toBe(true);
  });

  it('clears when the stage rebuilds itself', async () => {
    await startWithLiveBridge();
    layoutEvent({ stageGeneration: 7, issues: ['map_unresolved'], layoutGeneration: 4 });
    expect(get(smoothFollow).lineMap.valid).toBe(false);

    // An empty issue list is the recovery. Without it the most serious notice
    // the Live screen can show would stay up for a problem that is over.
    layoutEvent({ stageGeneration: 7, issues: [], layoutGeneration: 5 });
    const state = get(smoothFollow);
    expect(state.lineMap.valid).toBe(true);
    expect(state.lineMap.generation).toBe(5);
    expect(state.notices.find((n) => n.id === 'invalid_line_map')).toBeUndefined();
  });
});

/*
 * §52.7 window-layer failures on `stage://error`.
 *
 * S7. `stage://error` carries `windows/mod.rs` reporting on the stage WINDOW.
 * The only window-layer code emitted today is `STAGE_DISPLAY_MISMATCH` — the
 * stage opened on a monitor other than the one that was picked — and control
 * discarded it, because the handler routed on `status` and returned on anything
 * without one.
 *
 * The consequence is the worst kind: nothing looks broken. The script prompts
 * perfectly, at the wrong wall, and the operator finds out by looking at the
 * wrong wall.
 *
 * These drive the REAL store handler with the REAL payload `windows/mod.rs`
 * builds (`serde_json::json!({ stageGeneration, code, message,
 * requestedFingerprint, actualFingerprint })`).
 */
describe('stage window failures (§52.7)', () => {
  async function startWithLiveBridge(): Promise<void> {
    start(7);
    await completeBridge();
  }

  function dispatchStageError(payload: Record<string, unknown>): number {
    const handlers = find(CONTROL_EVENT.stageError);
    for (const handler of handlers) handler.handler({ payload });
    return handlers.length;
  }

  /** Verbatim shape of the `windows/mod.rs` display-mismatch payload. */
  function displayMismatch(overrides: Record<string, unknown> = {}): number {
    return dispatchStageError({
      stageGeneration: 7,
      code: 'STAGE_DISPLAY_MISMATCH',
      message: 'The stage opened on a different display than the one selected.',
      requestedFingerprint: 'dsp-prompter|3840x2160',
      actualFingerprint: 'dsp-builtin|3024x1964',
      ...overrides,
    });
  }

  it('surfaces a display mismatch instead of discarding it', async () => {
    await startWithLiveBridge();
    expect(get(session).stageWindowFault).toBeNull();

    expect(displayMismatch()).toBeGreaterThan(0);

    const fault = get(session).stageWindowFault;
    expect(
      fault,
      'the stage is prompting on the wrong physical display and control was told; ' +
        'dropping it leaves the operator with no signal at all',
    ).not.toBeNull();
    expect(fault?.code).toBe('STAGE_DISPLAY_MISMATCH');
    expect(fault?.message).toContain('different display');
    expect(fault?.requestedFingerprint).toBe('dsp-prompter|3840x2160');
    expect(fault?.actualFingerprint).toBe('dsp-builtin|3024x1964');
  });

  it('does not mistake a window error for a tracking emergency', async () => {
    await startWithLiveBridge();
    displayMismatch();
    // A window on the wrong monitor is not a §62 tracking emergency: the
    // script is prompting perfectly, just at the wrong wall. Motion is fine.
    expect(get(smoothFollow).lineMap.valid).toBe(true);
  });

  it('ignores a window error from a stage generation that is already gone', async () => {
    await startWithLiveBridge();
    displayMismatch({ stageGeneration: 3 });
    expect(get(session).stageWindowFault).toBeNull();
  });

  /*
   * The reason this handler has now been wrong twice is that it decided what it
   * did NOT handle and returned. A code this build has never heard of must
   * still reach the operator.
   */
  it('surfaces a window-layer code it has never seen', async () => {
    await startWithLiveBridge();
    dispatchStageError({
      stageGeneration: 7,
      code: 'STAGE_SOMETHING_NEW',
      message: 'A future window-layer failure.',
    });
    const fault = get(session).stageWindowFault;
    expect(fault?.code).toBe('STAGE_SOMETHING_NEW');
    expect(fault?.message).toBe('A future window-layer failure.');
    expect(fault?.requestedFingerprint).toBeNull();
  });

  it('still surfaces a window error that carries no code at all', async () => {
    await startWithLiveBridge();
    dispatchStageError({ stageGeneration: 7, message: 'Something went wrong on the stage.' });
    expect(get(session).stageWindowFault?.code).toBe('STAGE_WINDOW_ERROR');
    expect(get(session).stageWindowFault?.message).toBe('Something went wrong on the stage.');
  });

  it('is dismissable — it is a notice, not a modal', async () => {
    await startWithLiveBridge();
    displayMismatch();
    expect(get(session).stageWindowFault).not.toBeNull();
    dismissStageWindowFault();
    expect(get(session).stageWindowFault).toBeNull();
  });

  it('does not leak into the next session', async () => {
    await startWithLiveBridge();
    displayMismatch();
    expect(get(session).stageWindowFault).not.toBeNull();
    stopSession();
    start(9);
    expect(get(session).stageWindowFault).toBeNull();
  });
});
