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
  // Typed arguments so the §40.5 assertions can read the directive that was
  // published, not just the call count.
  publishListenerState: vi.fn(
    async (_sessionId: string, _stageGeneration: number, _directive: unknown) => {},
  ),
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

const {
  chooseAnotherListenerClip,
  clearSession,
  retryListenerMedia,
  session,
  startLiveSession,
  stopSession,
  toggleBlankStage,
  toggleListenerVisible,
  turnOffListenerForSession,
  useListenerPoster,
} = await import('../../../src/control/stores/session');
const { smoothFollow } = await import('../../../src/control/stores/smooth-follow');

type ListenerSelection = NonNullable<
  Parameters<typeof startLiveSession>[0]['listener']
>;

/** Two clips, so "choose another" has something to choose. */
function listenerSelection(): ListenerSelection {
  return {
    packId: 'mira',
    version: '1.0.0',
    variant: '1080p',
    geometry: {
      anchorX: 0.5,
      anchorY: 0.5,
      scale: 1,
      cropX: 0,
      cropY: 0,
      cropZoom: 1,
      opacity: 0.6,
      blurPx: 0,
      saturation: 1,
      mirrorVideo: false,
    },
    clipUrls: [
      { id: 'clip_a', url: 'a.mp4', mime: 'video/mp4', durationMs: 7000, posterUrl: 'a.jpg' },
      { id: 'clip_b', url: 'b.mp4', mime: 'video/mp4', durationMs: 9000, posterUrl: 'b.jpg' },
    ],
    placement: 'background',
  };
}

function start(stageGeneration: number, listener: ListenerSelection | null = null): string {
  return startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'manual',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    stageGeneration,
    listener,
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
  stage.publishListenerState.mockClear();
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

/*
 * §40.5 Listener media failure containment.
 *
 * These drive the REAL store handler with the REAL payload the stage emits.
 * The stage's `onListenerHealth` builds `{ stageGeneration, status, code?,
 * clipId? }` and Rust relays that object VERBATIM onto `stage://error`
 * (app.rs: `emit_to(CONTROL_LABEL, events::STAGE_ERROR, value)`), so that is
 * exactly what is fed in here. Building the state the handler would have
 * produced would have proved nothing — the bug WAS the handler.
 */
describe('listener media failures (§40.5)', () => {
  /**
   * Deliver to every registered handler, which is what Tauri does: an emit is
   * a broadcast, and each handler is gated on the stage generation it was
   * created for.
   */
  function dispatchStageError(payload: Record<string, unknown>): void {
    const handlers = find(CONTROL_EVENT.stageError);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) handler.handler({ payload });
  }

  /** Verbatim shape of `StageListenerHealthPayload` off the wire. */
  function mediaError(
    overrides: {
      stageGeneration?: number;
      status?: string;
      code?: string;
      clipId?: string;
    } = {},
  ): void {
    dispatchStageError({
      stageGeneration: 7,
      status: 'poster_fallback',
      code: 'decode_failure',
      clipId: 'clip_a',
      ...overrides,
    });
  }

  async function startWithListener(): Promise<void> {
    start(7, listenerSelection());
    await completeBridge();
    stage.publishListenerState.mockClear();
  }

  it('surfaces a media failure instead of discarding it', async () => {
    await startWithListener();
    expect(get(session).listenerFault).toBeNull();

    mediaError();

    const fault = get(session).listenerFault;
    expect(fault).not.toBeNull();
    expect(fault?.status).toBe('poster_fallback');
    expect(fault?.code).toBe('decode_failure');
    expect(fault?.clipId).toBe('clip_a');
    expect(fault?.resolution).toBe('unresolved');
    // One clip failed; the other is still a candidate for "Choose another".
    expect(fault?.alternativeClips).toBe(1);
  });

  it('reports a failure the stage could not attribute (no code)', async () => {
    await startWithListener();
    mediaError({ code: undefined });
    expect(get(session).listenerFault?.code).toBeNull();
    expect(get(session).listenerFault?.resolution).toBe('unresolved');
  });

  it('does not treat a media failure as a line-map failure', async () => {
    await startWithListener();
    mediaError();
    // The §62 tracking-emergency path must not fire for a cosmetic failure.
    expect(get(smoothFollow).lineMap.valid).toBe(true);
  });

  /*
   * S6: layout failures no longer travel this channel at all — they have their
   * own event (below). This asserts the split holds from the other side: a
   * media payload is a media payload, whatever words happen to be in it.
   */
  it('does not route a media failure into the line-map path', async () => {
    await startWithListener();
    mediaError({ code: 'source_unavailable' });
    expect(get(smoothFollow).lineMap.valid).toBe(true);
    expect(get(session).listenerFault).not.toBeNull();
  });

  it('ignores a media failure from a different stage generation', async () => {
    await startWithListener();
    mediaError({ stageGeneration: 3 });
    expect(get(session).listenerFault).toBeNull();
  });

  it('leaves the reading position, the scroll and the tracking cursor alone', async () => {
    await startWithListener();
    const before = get(session);
    mediaError();
    retryListenerMedia();
    await flush();
    useListenerPoster();
    turnOffListenerForSession();

    const after = get(session);
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.counts).toEqual(before.counts);
    expect(after.prompting).toBe(before.prompting);
    expect(after.paused).toBe(before.paused);
    expect(after.voiceFollow).toBe(before.voiceFollow);
    // Nothing was republished to the stage except Listener state.
    expect(stage.publishStageSnapshot).not.toHaveBeenCalled();
    expect(stage.publishStageDirective).not.toHaveBeenCalled();
  });

  it('Retry remounts the Listener: unmount first, then the same selection', async () => {
    await startWithListener();
    mediaError();
    retryListenerMedia();
    expect(get(session).listenerFault?.resolution).toBe('retrying');
    await flush();

    expect(stage.publishListenerState).toHaveBeenCalledTimes(2);
    // Re-sending the same selection alone would only update a prop on a layer
    // that is already in poster mode, so the unmount is load-bearing.
    expect(stage.publishListenerState.mock.calls[0]?.[2]).toEqual({
      kind: 'listener',
      listener: null,
    });
    const remounted = stage.publishListenerState.mock.calls[1]?.[2] as {
      listener: ListenerSelection;
    };
    expect(remounted.listener.clipUrls.map((c) => c.id)).toEqual(['clip_a', 'clip_b']);
  });

  it('Use poster settles for the still image without touching the stage', async () => {
    await startWithListener();
    mediaError();
    useListenerPoster();
    await flush();
    expect(get(session).listenerFault?.resolution).toBe('poster');
    // The stage is ALREADY showing the poster; re-publishing would restart a
    // decode that just failed.
    expect(stage.publishListenerState).not.toHaveBeenCalled();
  });

  it('Choose another drops the clip that failed and replays the rest', async () => {
    await startWithListener();
    mediaError();
    expect(chooseAnotherListenerClip()).toBe(true);
    await flush();

    const remounted = stage.publishListenerState.mock.calls.at(-1)?.[2] as {
      listener: ListenerSelection;
    };
    expect(remounted.listener.clipUrls.map((c) => c.id)).toEqual(['clip_b']);

    // The replacement fails too: nothing is left to choose.
    mediaError({ clipId: 'clip_b' });
    expect(get(session).listenerFault?.alternativeClips).toBe(0);
    expect(chooseAnotherListenerClip()).toBe(false);
  });

  it('Turn off retires the Listener for the rest of the session', async () => {
    await startWithListener();
    mediaError();
    turnOffListenerForSession();

    expect(get(session).listenerFault?.resolution).toBe('off');
    expect(stage.publishListenerState).toHaveBeenCalledTimes(1);
    expect(stage.publishListenerState.mock.calls[0]?.[2]).toEqual({
      kind: 'listener',
      listener: null,
    });

    // Nothing brings it back: not the quick control...
    stage.publishListenerState.mockClear();
    expect(toggleListenerVisible()).toBe(false);
    expect(stage.publishListenerState).not.toHaveBeenCalled();
    // ...not a retry...
    retryListenerMedia();
    await flush();
    expect(stage.publishListenerState).not.toHaveBeenCalled();
    // ...and a further failure report does not re-open the choice.
    mediaError();
    expect(get(session).listenerFault?.resolution).toBe('off');
  });

  it('re-arms the Listener for the next session', async () => {
    await startWithListener();
    mediaError();
    turnOffListenerForSession();
    stopSession();
    clearSession();

    start(9, listenerSelection());
    await completeBridge();
    expect(get(session).listenerFault).toBeNull();
    expect(toggleListenerVisible()).toBe(false); // it starts visible; this turns it off
    expect(toggleListenerVisible()).toBe(true); // ...and this turns it back on
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

  it('does not touch the Listener state', async () => {
    await startWithLiveBridge();
    layoutEvent({ stageGeneration: 7, issues: ['map_unresolved'], layoutGeneration: 4 });
    expect(get(session).listenerFault).toBeNull();
  });
});
