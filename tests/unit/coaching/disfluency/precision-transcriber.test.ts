/**
 * §29 — the bounded precision-transcription queue.
 *
 * The load-bearing test here is `stops growing under sustained latency`: it
 * drives the real queue with a real (deferred) client that never answers, and
 * asserts both that the bound holds and that the *documented* policy is the
 * one that produced the drops. Asserting only "length stayed small" would pass
 * for a queue that dropped everything, so every bound test also asserts what
 * survived.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PrecisionTranscriptionQueue,
  type PermanentTranscriptionError,
} from '../../../../src/shared/coaching/disfluency/precision-transcriber';
import type {
  PrecisionChunkRequest,
  PrecisionDropRecord,
  PrecisionTranscriptResult,
} from '../../../../src/shared/coaching/disfluency/types';

/** A client whose every response is resolved by the test, never by a timer. */
function deferredClient() {
  const pending = new Map<
    string,
    { resolve: (result: PrecisionTranscriptResult) => void; reject: (error: unknown) => void }
  >();
  const seen: string[] = [];
  return {
    seen,
    pending,
    client: {
      transcribe(request: PrecisionChunkRequest): Promise<PrecisionTranscriptResult> {
        seen.push(request.chunkId);
        return new Promise((resolve, reject) => {
          pending.set(request.chunkId, { resolve, reject });
        });
      },
    },
    complete(chunkId: string, text: string): void {
      const entry = pending.get(chunkId);
      if (!entry) throw new Error(`no in-flight chunk ${chunkId}`);
      pending.delete(chunkId);
      entry.resolve({
        chunkId,
        // Deliberately wrong interval: the queue must overwrite it with the
        // request's own interval (§5.4).
        audioStartMs: 999_999,
        audioEndMs: 999_999,
        takePassId: 'wrong-take',
        trackingEpoch: -1,
        commitSequence: -1,
        text,
      });
    },
    fail(chunkId: string, error: unknown): void {
      const entry = pending.get(chunkId);
      if (!entry) throw new Error(`no in-flight chunk ${chunkId}`);
      pending.delete(chunkId);
      entry.reject(error);
    },
  };
}

function chunk(
  chunkId: string,
  startMs: number,
  durationMs: number,
  priority: PrecisionChunkRequest['priority'] = 'ordinary',
): PrecisionChunkRequest {
  return {
    chunkId,
    audioStartMs: startMs,
    audioEndMs: startMs + durationMs,
    priority,
    takePassId: 'take-1',
    trackingEpoch: 3,
    commitSequence: 1,
    scriptDictionary: ['Ndlovu'],
  };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('queue bound under sustained latency (§29.1)', () => {
  it('stops growing, and drops exactly the chunks the policy says it should', async () => {
    const transport = deferredClient();
    const drops: PrecisionDropRecord[] = [];
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxPendingAudioMs: 45_000,
      maxConcurrent: 1,
      maxChunkMs: 12_000,
      // Long enough that the in-flight chunk stays stuck for this whole test.
      maxInFlightMs: 10_000_000,
      onDrop: (record) => drops.push(record),
    });

    // 40 ten-second chunks: 400 s of audio offered into a 45 s bound while the
    // API answers nothing at all.
    for (let i = 0; i < 40; i++) {
      queue.enqueue(chunk(`c${i}`, i * 10_000, 10_000), i * 10_000);
      await flush();
      expect(queue.pendingAudioMs()).toBeLessThanOrEqual(45_000);
    }

    const diagnostics = queue.diagnostics();
    expect(diagnostics.pendingAudioMs).toBeLessThanOrEqual(45_000);
    expect(diagnostics.peakPendingAudioMs).toBeLessThanOrEqual(45_000);
    // One request went out and never came back; the rest are the sliding window.
    expect(diagnostics.inFlight).toBe(1);
    expect(transport.seen).toEqual(['c0']);

    // The documented policy is oldest-evicted-first within a tier, so the
    // survivors are the *newest* chunks, not an arbitrary subset.
    // 10 s stuck in flight + 3 × 10 s queued = 40 s; a fourth would breach 45 s.
    expect(queue.pendingChunkIds()).toEqual(['c37', 'c38', 'c39']);
    expect(drops.every((record) => record.reason === 'evicted_lower_value')).toBe(true);
    expect(drops.map((record) => record.chunkId)).toEqual(
      Array.from({ length: 36 }, (_, i) => `c${i + 1}`),
    );
  });

  it('never evicts a candidate-triggered chunk to make room for an ordinary one', async () => {
    const transport = deferredClient();
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxPendingAudioMs: 30_000,
      maxConcurrent: 1,
      maxInFlightMs: 10_000_000,
    });

    queue.enqueue(chunk('inflight', 0, 10_000), 0);
    await flush();
    queue.enqueue(chunk('candidate', 10_000, 10_000, 'candidate'), 10_000);
    queue.enqueue(chunk('ordinary', 20_000, 10_000), 20_000);
    // Bound is full: 10 in flight + 20 queued.
    const outcome = queue.enqueue(chunk('newcomer', 30_000, 10_000), 30_000);

    expect(outcome.accepted).toBe(true);
    expect(queue.pendingChunkIds()).toEqual(['candidate', 'newcomer']);
    expect(queue.pendingAudioMs()).toBe(30_000);
  });

  it('rejects the incoming chunk when only higher-value work is queued', async () => {
    const transport = deferredClient();
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxPendingAudioMs: 20_000,
      maxConcurrent: 1,
      maxInFlightMs: 10_000_000,
    });
    queue.enqueue(chunk('inflight', 0, 10_000, 'candidate'), 0);
    await flush();
    queue.enqueue(chunk('queued-candidate', 10_000, 10_000, 'candidate'), 10_000);

    const outcome = queue.enqueue(chunk('ordinary', 20_000, 10_000), 20_000);
    expect(outcome.accepted).toBe(false);
    expect(outcome.dropped.map((record) => record.reason)).toEqual(['queue_full']);
    expect(queue.pendingChunkIds()).toEqual(['queued-candidate']);
  });

  it('keeps the take tail even when the queue is full of it', async () => {
    const transport = deferredClient();
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxPendingAudioMs: 20_000,
      maxConcurrent: 1,
      maxInFlightMs: 10_000_000,
      alwaysProcessTakeTail: true,
    });
    queue.enqueue(chunk('inflight', 0, 10_000), 0);
    await flush();
    queue.enqueue(chunk('tail', 10_000, 10_000, 'take_tail'), 10_000);
    const outcome = queue.enqueue(chunk('later-tail', 20_000, 10_000, 'take_tail'), 20_000);

    expect(outcome.accepted).toBe(false);
    expect(queue.pendingChunkIds()).toEqual(['tail']);
  });

  it('releases the bound when a request hangs past its deadline', async () => {
    const transport = deferredClient();
    const drops: PrecisionDropRecord[] = [];
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxPendingAudioMs: 12_000,
      maxConcurrent: 1,
      maxInFlightMs: 20_000,
      onDrop: (record) => drops.push(record),
    });

    queue.enqueue(chunk('stuck', 0, 12_000), 0);
    await flush();
    expect(queue.pendingAudioMs()).toBe(12_000);

    // Without an in-flight deadline this chunk pins the entire bound forever:
    // the queue would be "bounded" and permanently unable to accept anything.
    const blocked = queue.enqueue(chunk('blocked', 12_000, 12_000), 12_000);
    expect(blocked.accepted).toBe(false);

    queue.tick(25_000);
    expect(drops.map((record) => record.reason)).toContain('in_flight_timeout');
    expect(queue.pendingAudioMs()).toBe(0);

    const admitted = queue.enqueue(chunk('after', 25_000, 12_000), 25_000);
    expect(admitted.accepted).toBe(true);

    // A very late answer for the abandoned chunk must not be applied.
    const onResult = vi.fn();
    transport.complete('stuck', 'um');
    await flush();
    expect(onResult).not.toHaveBeenCalled();
    expect(queue.diagnostics().completed).toBe(0);
  });
});

describe('admission rules', () => {
  it('rejects an oversized chunk instead of silently truncating it', () => {
    const transport = deferredClient();
    const queue = new PrecisionTranscriptionQueue({ client: transport.client, mode: 'full_precision' });
    const outcome = queue.enqueue(chunk('huge', 0, 20_000), 0);
    expect(outcome.accepted).toBe(false);
    expect(outcome.dropped[0]?.reason).toBe('oversized_chunk');
  });

  it('honours the cost mode (§29.3)', () => {
    const transport = deferredClient();
    const queue = new PrecisionTranscriptionQueue({ client: transport.client, mode: 'on_candidates' });
    expect(queue.enqueue(chunk('a', 0, 5_000, 'ordinary'), 0).accepted).toBe(false);
    expect(queue.enqueue(chunk('b', 0, 5_000, 'candidate'), 0).accepted).toBe(true);

    queue.setMode('off');
    expect(queue.enqueue(chunk('c', 0, 5_000, 'candidate'), 0).accepted).toBe(false);

    queue.setMode('review_only');
    expect(queue.enqueue(chunk('d', 0, 5_000, 'candidate'), 0).accepted).toBe(false);
    expect(queue.enqueue(chunk('e', 0, 5_000, 'take_tail'), 0).accepted).toBe(true);
  });

  it('drops queued work from a superseded take pass', async () => {
    const transport = deferredClient();
    const drops: PrecisionDropRecord[] = [];
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxConcurrent: 0,
      onDrop: (record) => drops.push(record),
    });
    queue.enqueue(chunk('old', 0, 5_000), 0);
    queue.setTakePass('take-2', 10_000);
    expect(queue.pendingChunkIds()).toEqual([]);
    expect(drops.map((record) => record.reason)).toEqual(['stale_take_pass']);
    expect(queue.enqueue(chunk('older', 0, 5_000), 10_000).accepted).toBe(false);
  });
});

describe('dispatch order and delivery', () => {
  it('processes candidate chunks before older ordinary ones, oldest-first inside a tier', async () => {
    const transport = deferredClient();
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxConcurrent: 1,
      maxInFlightMs: 10_000_000,
    });
    queue.enqueue(chunk('blocker', 0, 1_000), 0);
    await flush();
    queue.enqueue(chunk('old-ordinary', 1_000, 1_000), 1_000);
    queue.enqueue(chunk('late-candidate', 5_000, 1_000, 'candidate'), 5_000);
    queue.enqueue(chunk('early-candidate', 3_000, 1_000, 'candidate'), 5_000);

    transport.complete('blocker', 'hello');
    await flush();
    expect(transport.seen).toEqual(['blocker', 'early-candidate']);
    transport.complete('early-candidate', 'um');
    await flush();
    expect(transport.seen).toEqual(['blocker', 'early-candidate', 'late-candidate']);
  });

  it('maps a delayed result back onto the interval it describes (§5.4)', async () => {
    const transport = deferredClient();
    const results: PrecisionTranscriptResult[] = [];
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      onResult: (result) => results.push(result),
    });
    queue.enqueue(chunk('c1', 8_000, 4_000), 8_000);
    await flush();
    // The fake transport answers with a nonsense interval and take pass; the
    // queue must replace them with the request's own.
    transport.complete('c1', 'so um yes');
    await flush();

    expect(results).toHaveLength(1);
    expect(results[0]?.audioStartMs).toBe(8_000);
    expect(results[0]?.audioEndMs).toBe(12_000);
    expect(results[0]?.takePassId).toBe('take-1');
    expect(results[0]?.trackingEpoch).toBe(3);
    expect(results[0]?.text).toBe('so um yes');
  });
});

describe('failure behaviour (§29.4)', () => {
  it('retries a transient failure exactly once, then abandons it', async () => {
    const transport = deferredClient();
    const drops: PrecisionDropRecord[] = [];
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxInFlightMs: 10_000_000,
      onDrop: (record) => drops.push(record),
    });
    queue.enqueue(chunk('c1', 0, 4_000), 0);
    await flush();

    transport.fail('c1', new Error('socket hang up'));
    await flush();
    expect(transport.seen).toEqual(['c1', 'c1']);

    transport.fail('c1', new Error('socket hang up'));
    await flush();
    expect(transport.seen).toEqual(['c1', 'c1']);
    expect(drops.map((record) => record.reason)).toEqual(['transport_failed']);
    expect(queue.diagnostics().failed).toBe(1);
    expect(queue.pendingAudioMs()).toBe(0);
  });

  it('does not retry a permanent failure', async () => {
    const transport = deferredClient();
    const queue = new PrecisionTranscriptionQueue({
      client: transport.client,
      mode: 'full_precision',
      maxInFlightMs: 10_000_000,
    });
    queue.enqueue(chunk('c1', 0, 4_000), 0);
    await flush();

    const error: PermanentTranscriptionError = Object.assign(new Error('invalid api key'), {
      permanent: true,
    });
    transport.fail('c1', error);
    await flush();
    expect(transport.seen).toEqual(['c1']);
    expect(queue.diagnostics().failed).toBe(1);
  });
});
