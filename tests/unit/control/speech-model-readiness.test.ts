/**
 * The speech model's readiness follows the model, not the moment a script
 * opened (#301).
 *
 * The editor used to ask once and keep the answer, so an install that finished
 * while a script was open left Present warning "No speech model is installed"
 * over a model Settings showed as Installed — and a model removed in Settings
 * left Present launching with no warning at all. These pin the store that
 * replaced that answer: it listens, it reconciles a reply with what arrived
 * while the reply was in flight, and it never invents a warning it was not
 * given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import {
  ASSUMED_READY,
  createSpeechModelReadiness,
  type SpeechModelReadiness,
  type SpeechModelReadinessSources,
} from '../../../src/control/stores/speech-model-readiness';
import type { SpeechModelStatus } from '../../../src/control/services/speech-models';

const ENGLISH = 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05';
const OTHER = 'some-other-recogniser';

/** A status as Rust sends it: the SHORT catalogue id, the LONG recogniser name. */
function status(over: Partial<SpeechModelStatus> = {}): SpeechModelStatus {
  return {
    modelId: 'x-asr-480ms',
    modelName: ENGLISH,
    languages: ['en'],
    phase: 'installed',
    source: 'downloaded',
    installed: true,
    supported: true,
    downloadBytes: 133_895_136,
    installedBytes: 169_347_218,
    progressBytes: 0,
    progressTotal: 0,
    operationId: null,
    error: null,
    ...over,
  };
}

const NOT_INSTALLED = status({ phase: 'notInstalled', source: null, installed: false });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * A fake event bus and status command.
 *
 * `answers` is consulted per query, in order; an entry that is a deferred lets
 * a test hold the reply in flight.
 */
function harness(initial = ENGLISH) {
  const selected = writable(initial);
  let handler: ((s: SpeechModelStatus) => void) | null = null;
  const unlisten = vi.fn();
  const attach = deferred<() => void>();
  const answers: Array<SpeechModelStatus | ReturnType<typeof deferred<SpeechModelStatus>> | Error> =
    [];
  const query = vi.fn(async (_id: string): Promise<SpeechModelStatus> => {
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer queued');
    if (next instanceof Error) throw next;
    if ('promise' in next) return next.promise;
    return next;
  });
  const sources: SpeechModelReadinessSources = {
    query,
    listen: vi.fn(async (h) => {
      handler = h;
      return attach.promise;
    }),
  };
  const store = createSpeechModelReadiness(selected, sources);
  const seen: SpeechModelReadiness[] = [];
  return {
    selected,
    store,
    query,
    unlisten,
    answers,
    seen,
    /** Attach the listener (Tauri's `listen` resolving). */
    async attach(): Promise<void> {
      attach.resolve(unlisten);
      await settle();
    },
    failAttach(): void {
      attach.reject(new Error('no event bus'));
    },
    emit(s: SpeechModelStatus): void {
      handler?.(s);
    },
    subscribe(): () => void {
      return store.subscribe((value) => seen.push(value));
    },
  };
}

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

describe('speech model readiness', () => {
  it('assumes a working model until Rust has answered', () => {
    const h = harness();
    stop = h.subscribe();
    expect(get(h.store)).toEqual(ASSUMED_READY);
  });

  it('listens BEFORE it asks, and asks about the recogniser settings names', async () => {
    const h = harness();
    h.answers.push(NOT_INSTALLED);
    stop = h.subscribe();
    await settle();
    // Asking first would lose a terminal event landing between the reply and
    // the attach.
    expect(h.query).not.toHaveBeenCalled();

    await h.attach();
    expect(h.query).toHaveBeenCalledWith(ENGLISH);
    expect(get(h.store)).toMatchObject({ known: true, installed: false, damaged: false });
  });

  it('follows an install that finishes while it is open — the issue’s repro', async () => {
    const h = harness();
    h.answers.push(
      status({ phase: 'downloading', source: null, installed: false, operationId: 'op' }),
    );
    stop = h.subscribe();
    await h.attach();
    expect(get(h.store)).toMatchObject({ installed: false, installing: true });

    h.emit(status({ phase: 'validating', source: null, installed: false, operationId: 'op' }));
    expect(get(h.store)).toMatchObject({ installed: false, installing: true });

    h.emit(status());
    expect(get(h.store)).toEqual({
      known: true,
      installed: true,
      supported: true,
      damaged: false,
      installing: false,
    });
    // Followed by events alone: no second status request was needed.
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('follows a model removed in Settings', async () => {
    const h = harness();
    h.answers.push(status());
    stop = h.subscribe();
    await h.attach();
    expect(get(h.store).installed).toBe(true);

    // What `SpeechModelManager::delete` now announces.
    h.emit(NOT_INSTALLED);
    expect(get(h.store)).toMatchObject({ known: true, installed: false, damaged: false });
  });

  it('follows an install that fails', async () => {
    const h = harness();
    h.answers.push(status({ phase: 'downloading', source: null, installed: false }));
    stop = h.subscribe();
    await h.attach();

    h.emit(
      status({
        phase: 'failed',
        source: null,
        installed: false,
        error: { code: 'STT_MODEL_DOWNLOAD_FAILED', message: 'The download stopped.' },
      }),
    );
    expect(get(h.store)).toMatchObject({ installed: false, installing: false, damaged: false });
  });

  it('reports a damaged download as damaged, whatever the error code says', async () => {
    const h = harness();
    // A repair that itself failed reports its own error; the files are no less
    // damaged for it (`isDamaged`).
    h.answers.push(
      status({
        phase: 'failed',
        installed: false,
        error: { code: 'STT_MODEL_DOWNLOAD_FAILED', message: 'No space left.' },
      }),
    );
    stop = h.subscribe();
    await h.attach();
    expect(get(h.store)).toMatchObject({ installed: false, damaged: true });
  });

  it('reports a model this build cannot load', async () => {
    const h = harness();
    h.answers.push(status({ supported: false, installed: false, source: null }));
    stop = h.subscribe();
    await h.attach();
    expect(get(h.store)).toMatchObject({ known: true, supported: false });
  });

  it('ignores events about a different model', async () => {
    const h = harness();
    h.answers.push(status());
    stop = h.subscribe();
    await h.attach();

    h.emit(status({ modelId: 'other', modelName: OTHER, installed: false, source: null }));
    expect(get(h.store).installed).toBe(true);
  });

  it('matches on the recogniser name, never on the catalogue id', async () => {
    const h = harness();
    h.answers.push(status());
    stop = h.subscribe();
    await h.attach();

    // Settings holds the long recogniser id; an event's `modelId` is short.
    // An event that matched only on `modelId === selected` would never land.
    h.emit(NOT_INSTALLED);
    expect(get(h.store).installed).toBe(false);
  });

  it('drops a reply that an event overtook', async () => {
    const h = harness();
    const reply = deferred<SpeechModelStatus>();
    h.answers.push(reply);
    stop = h.subscribe();
    await h.attach();

    // The request was issued mid-install; the install finished and emitted...
    h.emit(status());
    // ...and then the older reply landed.
    reply.resolve(status({ phase: 'validating', source: null, installed: false }));
    await settle();

    expect(get(h.store)).toMatchObject({ installed: true, installing: false });
  });

  it('asks again when the configured model changes, and drops the old reply', async () => {
    const h = harness();
    const english = deferred<SpeechModelStatus>();
    h.answers.push(english);
    stop = h.subscribe();
    await h.attach();

    h.answers.push(status({ modelId: 'other', modelName: OTHER, installed: false, source: null }));
    h.selected.set(OTHER);
    await settle();
    expect(h.query).toHaveBeenLastCalledWith(OTHER);
    expect(get(h.store)).toMatchObject({ known: true, installed: false });

    // The first model's answer is no longer the selected model's.
    english.resolve(status());
    await settle();
    expect(get(h.store).installed).toBe(false);
  });

  it('does not carry one model’s answer over to the next', async () => {
    const h = harness();
    h.answers.push(NOT_INSTALLED);
    stop = h.subscribe();
    await h.attach();
    expect(get(h.store).installed).toBe(false);

    const other = deferred<SpeechModelStatus>();
    h.answers.push(other);
    h.selected.set(OTHER);
    // Unknown again, until this model is answered for.
    expect(get(h.store)).toEqual(ASSUMED_READY);
  });

  it('keeps assuming when the status cannot be read', async () => {
    const h = harness();
    h.answers.push(new Error('STT_MODEL_UNKNOWN'));
    stop = h.subscribe();
    await h.attach();
    expect(get(h.store)).toEqual(ASSUMED_READY);
  });

  it('still reads the status once when the event bus will not open', async () => {
    const h = harness();
    h.answers.push(NOT_INSTALLED);
    stop = h.subscribe();
    h.failAttach();
    await settle();
    expect(h.query).toHaveBeenCalledWith(ENGLISH);
    expect(get(h.store).installed).toBe(false);
  });

  it('publishes a change, not every progress tick', async () => {
    const h = harness();
    h.answers.push(status({ phase: 'downloading', source: null, installed: false }));
    stop = h.subscribe();
    await h.attach();
    const before = h.seen.length;

    for (let bytes = 1; bytes <= 50; bytes++) {
      h.emit(
        status({
          phase: 'downloading',
          source: null,
          installed: false,
          progressBytes: bytes,
          progressTotal: 50,
        }),
      );
    }
    expect(h.seen.length).toBe(before);
  });

  it('unlistens when the last subscriber leaves', async () => {
    const h = harness();
    h.answers.push(status());
    const leave = h.subscribe();
    await h.attach();
    leave();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it('unlistens a listener that attaches after the last subscriber left', async () => {
    const h = harness();
    const leave = h.subscribe();
    leave();
    await h.attach();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    // Nothing left to answer for.
    expect(h.query).not.toHaveBeenCalled();
  });

  it('asks afresh when a subscriber returns, since nothing listened meanwhile', async () => {
    const h = harness();
    h.answers.push(status());
    const leave = h.subscribe();
    await h.attach();
    leave();

    h.answers.push(NOT_INSTALLED);
    stop = h.subscribe();
    await h.attach();
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(get(h.store).installed).toBe(false);
  });
});
