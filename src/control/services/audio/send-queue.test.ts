/**
 * The renderer's audio queue against a push that stalls (#288).
 *
 * The sink is a fake IPC call that settles only when a test says so, and the
 * clock is a number the test advances, so a stall of any length is a few lines
 * and no real time. What this proves is the queue's bookkeeping: one call in
 * flight, a bounded backlog, every loss counted and reported, and recovery onto
 * the newest audio. It cannot say anything about how a real WKWebView bridge
 * stalls, or how the recogniser and the cursor cope with the gap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const traces = vi.hoisted(() => [] as Array<[string, string]>);

vi.mock('../audio-trace', () => ({
  trace: (step: string, detail = '') => {
    traces.push([step, detail]);
  },
}));

import {
  AUDIO_SEND_MAX_WAIT_MS,
  AUDIO_SEND_QUEUE_FRAMES,
  AudioSendQueue,
  type AudioSendQueueOptions,
} from './send-queue';

interface Push {
  chunk: string;
  settle(): void;
  refuse(): void;
}

function harness(options: Partial<AudioSendQueueOptions> = {}) {
  const h = {
    clock: 0,
    /** Every push issued, settled or not. */
    pushes: [] as Push[],
    delivered: [] as string[],
    dropped: [] as number[],
    /** The clock at each report, to check how often the presenter is told. */
    reportedAt: [] as number[],
    acknowledged: 0,
    /** While set, pushes stay pending until settled by hand. */
    stalled: false,
    queue: null as unknown as AudioSendQueue,
    /** The one push still outstanding, if any. */
    open(): Push[] {
      return h.pushes.filter((push) => !settled.has(push));
    },
  };
  const settled = new Set<Push>();
  h.queue = new AudioSendQueue({
    send: (chunk) =>
      new Promise<void>((resolve, reject) => {
        const push: Push = {
          chunk,
          settle: () => {
            settled.add(push);
            h.delivered.push(chunk);
            resolve();
          },
          refuse: () => {
            settled.add(push);
            reject(new Error('IPC_REFUSED'));
          },
        };
        h.pushes.push(push);
        if (!h.stalled) push.settle();
      }),
    onDelivered: () => {
      h.acknowledged += 1;
    },
    onDropped: (frames) => {
      h.dropped.push(frames);
      h.reportedAt.push(h.clock);
    },
    now: () => h.clock,
    ...options,
  });
  return h;
}

/** Let every settled push's continuation run. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One frame every 100 ms, like the capture graph. */
function speak(h: ReturnType<typeof harness>, from: number, count: number): void {
  for (let i = from; i < from + count; i += 1) {
    h.clock += 100;
    h.queue.enqueue(`frame-${i}`);
  }
}

function frames(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, i) => `frame-${from + i}`);
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

beforeEach(() => {
  traces.length = 0;
});

describe('at the capture cadence', () => {
  it('sends one frame at a time, in order, and loses nothing', async () => {
    const h = harness();
    h.stalled = true;
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    h.queue.enqueue('c');
    // Never two calls at once: Tauri would deliver them in any order.
    expect(h.pushes.map((push) => push.chunk)).toEqual(['a']);

    h.stalled = false;
    h.open()[0]!.settle();
    await drain();
    expect(h.delivered).toEqual(['a', 'b', 'c']);
    expect(h.dropped).toEqual([]);
    expect(h.acknowledged).toBe(3);
  });

  it('takes a whole pre-roll burst without shedding any of it', async () => {
    const h = harness();
    // One in flight and a full queue behind it, all in the same instant: the
    // opening words released the moment a cold recogniser finishes loading.
    for (let i = 0; i <= AUDIO_SEND_QUEUE_FRAMES; i += 1) h.queue.enqueue(`frame-${i}`);
    await drain();
    expect(h.delivered).toEqual(frames(0, AUDIO_SEND_QUEUE_FRAMES + 1));
    expect(h.dropped).toEqual([]);
  });
});

describe('a push that stalls for longer than the frame cadence', () => {
  it('holds a bounded backlog behind exactly one outstanding call', () => {
    const h = harness();
    h.stalled = true;
    speak(h, 0, 1);
    speak(h, 1, AUDIO_SEND_QUEUE_FRAMES * 3);

    expect(h.pushes, 'nothing is sent past a call that has not come back').toHaveLength(1);
    expect(h.queue.inFlight).toBe(true);
    expect(h.queue.depth).toBeLessThanOrEqual(AUDIO_SEND_QUEUE_FRAMES);
    expect(h.acknowledged, 'a frame queued is not a frame delivered').toBe(0);
  });

  it('reports the first loss at once, while the call is still stuck', () => {
    const h = harness();
    h.stalled = true;
    speak(h, 0, 1 + AUDIO_SEND_QUEUE_FRAMES);
    expect(h.dropped, 'a full queue has lost nothing yet').toEqual([]);

    speak(h, 1 + AUDIO_SEND_QUEUE_FRAMES, 1);
    // Not deferred to recovery: a call that never settles has no recovery.
    expect(h.dropped).toEqual([1]);
    expect(traces.find(([step]) => step === 'audio-dropped')?.[1]).toContain('overflow 1');
  });

  it('keeps reporting a long stall, but no more than once a second', () => {
    const h = harness();
    h.stalled = true;
    speak(h, 0, 1 + AUDIO_SEND_QUEUE_FRAMES);
    // Ten more seconds of speech into a queue that is already full.
    speak(h, 1 + AUDIO_SEND_QUEUE_FRAMES, 100);

    // A frame a tick is lost; the presenter hears about it once a second.
    expect(h.reportedAt).toHaveLength(10);
    const gaps = h.reportedAt.slice(1).map((at, i) => at - h.reportedAt[i]!);
    expect(gaps.every((gap) => gap === 1_000), `reports at ${h.reportedAt.join(', ')}`).toBe(
      true,
    );
    // What the throttle holds back is held, not lost: the last nine frames
    // fall after the tenth report and wait for the stall to end.
    expect(sum(h.dropped)).toBe(91);
  });

  it('resumes on the newest audio once the call comes back, and accounts for the rest', async () => {
    const h = harness();
    h.stalled = true;
    speak(h, 0, 1);
    const lost = 25;
    speak(h, 1, AUDIO_SEND_QUEUE_FRAMES + lost);

    h.stalled = false;
    h.open()[0]!.settle();
    await drain();
    // The stuck frame, then the newest that fit — the oldest are what went.
    expect(h.delivered).toEqual([
      'frame-0',
      ...frames(1 + lost, 1 + lost + AUDIO_SEND_QUEUE_FRAMES),
    ]);
    // Every frame that never reached the sink was reported, exactly once.
    expect(sum(h.dropped)).toBe(lost);

    speak(h, 1 + lost + AUDIO_SEND_QUEUE_FRAMES, 2);
    await drain();
    expect(h.delivered.slice(-2)).toEqual(
      frames(1 + lost + AUDIO_SEND_QUEUE_FRAMES, 3 + lost + AUDIO_SEND_QUEUE_FRAMES),
    );
    expect(sum(h.dropped), 'and nothing is lost once it has recovered').toBe(lost);
  });

  it('does not send frames that waited past the budget, even with capture stopped', async () => {
    const h = harness();
    h.stalled = true;
    speak(h, 0, 6);
    // Capture goes quiet — a device swap mid-stall — and the backlog ages.
    h.clock += AUDIO_SEND_MAX_WAIT_MS + 1;

    h.stalled = false;
    h.open()[0]!.settle();
    await drain();
    expect(h.delivered).toEqual(['frame-0']);
    expect(h.dropped, 'reported together, not one frame now and the rest later').toEqual([5]);
    expect(traces.find(([step]) => step === 'audio-dropped')?.[1]).toContain('expired 5');
  });
});

describe('a push that fails', () => {
  it('counts a refused push as lost and carries on with the next frame', async () => {
    const h = harness();
    h.stalled = true;
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    h.open()[0]!.refuse();
    await drain();
    expect(h.dropped).toEqual([1]);
    expect(traces.find(([step]) => step === 'audio-dropped')?.[1]).toContain('rejected 1');

    h.open()[0]!.settle();
    await drain();
    expect(h.delivered).toEqual(['b']);
  });

  it('counts a push that throws instead of throwing into the audio callback', async () => {
    const sent: string[] = [];
    const dropped: number[] = [];
    const queue = new AudioSendQueue({
      send: async (chunk) => {
        if (chunk === 'a') throw new Error('IPC_UNAVAILABLE');
        sent.push(chunk);
      },
      onDropped: (frames) => dropped.push(frames),
      now: () => 0,
    });
    const throwing = new AudioSendQueue({
      send: () => {
        throw new Error('IPC_UNAVAILABLE');
      },
      now: () => 0,
    });
    expect(() => throwing.enqueue('a'), 'a synchronous throw is contained').not.toThrow();

    queue.enqueue('a');
    queue.enqueue('b');
    await drain();
    expect(dropped).toEqual([1]);
    expect(sent, 'the frame behind it still goes').toEqual(['b']);
  });

  it('reports every refusal once the queue runs dry, throttle or not', async () => {
    const h = harness();
    h.stalled = true;
    // Three frames in one instant, all refused: two of the losses land inside
    // the throttle window, and no push will ever come back to flush them.
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    h.queue.enqueue('c');
    for (let i = 0; i < 3; i += 1) {
      h.open()[0]!.refuse();
      await drain();
    }
    expect(sum(h.dropped)).toBe(3);
    expect(h.queue.depth).toBe(0);
  });

  it('reports a backlog that expired behind a push that was then refused', async () => {
    const h = harness();
    h.stalled = true;
    speak(h, 0, 4);
    h.clock += AUDIO_SEND_MAX_WAIT_MS + 1;
    h.open()[0]!.refuse();
    await drain();
    // One refused and three too old to send, with nothing after them to wait
    // for: all four are reported now, not when the next push comes back.
    expect(sum(h.dropped)).toBe(4);
    expect(h.pushes).toHaveLength(1);
  });
});

describe('callbacks that throw', () => {
  it('cannot stall the queue or throw into the audio callback', async () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent: string[] = [];
    const queue = new AudioSendQueue({
      send: async (chunk) => {
        sent.push(chunk);
      },
      onDelivered: () => {
        throw new Error('listener broke');
      },
      onDropped: () => {
        throw new Error('listener broke');
      },
      now: () => 0,
      capacity: 1,
    });
    // Over capacity in one instant, so `onDropped` throws inside `enqueue`.
    expect(() => {
      queue.enqueue('a');
      queue.enqueue('b');
      queue.enqueue('c');
    }).not.toThrow();
    await drain();
    // `onDelivered` threw after every push, and the next one still went.
    expect(sent).toEqual(['a', 'c']);
    expect(failures).toHaveBeenCalled();
    failures.mockRestore();
  });
});

describe('disposal', () => {
  it('sends, acknowledges and reports nothing once disposed', async () => {
    const h = harness();
    h.stalled = true;
    speak(h, 0, 1 + AUDIO_SEND_QUEUE_FRAMES + 3);
    const reported = [...h.dropped];

    h.queue.dispose();
    h.queue.enqueue('late');
    h.stalled = false;
    h.open()[0]!.settle();
    await drain();

    expect(h.pushes, 'the backlog belonged to a session that has closed').toHaveLength(1);
    expect(h.acknowledged).toBe(0);
    // The take is over: what was lost is traced, not raised as a notice.
    expect(h.dropped).toEqual(reported);
    expect(traces.at(-1)?.[1]).toContain(`${AUDIO_SEND_QUEUE_FRAMES} still waiting`);
  });

  it('shrugs off a call that is refused after the queue has gone', async () => {
    const h = harness();
    h.stalled = true;
    h.queue.enqueue('a');
    h.queue.dispose();
    h.open()[0]!.refuse();
    await drain();
    expect(h.dropped).toEqual([]);
  });

  it('is idempotent', () => {
    const h = harness();
    h.queue.dispose();
    expect(() => h.queue.dispose()).not.toThrow();
  });
});
