/**
 * §60 low transcript confidence — detection and the notice it produces.
 *
 * Two halves, and the second one is the point:
 *
 *  - the watcher fires on a SUSTAINED degradation, and (the assertion that stops
 *    this feature becoming an irritant) does NOT fire on one hard word, one bad
 *    utterance, or a short burst;
 *  - the session store actually calls `reportTranscriptStatus('low_confidence')`,
 *    which nothing in the app did before — the status member and the notice copy
 *    both existed with no producer between them.
 *
 * On revert: the first half cannot compile (the module is gone) and the second
 * half sees `notices` stay empty, because `onTrackingEvent` went back to
 * forwarding straight to the driver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { CompiledScript, TokenLogprob } from '../../../src/shared/contracts';
import {
  DEFAULT_TRANSCRIPT_CONFIDENCE_THRESHOLDS as T,
  TranscriptConfidenceWatch,
  type TranscriptConfidenceInput,
} from '../../../src/control/lib/transcript-confidence-watch';

/* ------------------------------------------------------------------ fixtures */

/**
 * Build a finalized item whose provider pieces reconstruct its own text, so
 * `tokenConfidencesFromLogprobs` can attribute them. The word boundary rides on
 * a leading space, exactly as the provider emits it.
 */
function item(
  itemId: string,
  words: ReadonlyArray<readonly [string, number]>,
  atMs: number,
): TranscriptConfidenceInput {
  const text = words.map(([w]) => w).join(' ');
  const logprobs: TokenLogprob[] = words.map(([w, confidence], i) => ({
    token: i === 0 ? w : ` ${w}`,
    logprob: Math.log(confidence),
  }));
  return { itemId, text, logprobs, receivedAtMs: atMs };
}

/** `count` words all at the same confidence. */
function evenItem(
  itemId: string,
  count: number,
  confidence: number,
  atMs: number,
): TranscriptConfidenceInput {
  const words: Array<readonly [string, number]> = [];
  for (let i = 0; i < count; i++) words.push([`word${i}`, confidence] as const);
  return item(itemId, words, atMs);
}

describe('TranscriptConfidenceWatch (§60 detection)', () => {
  it('attributes provider log probabilities to words', () => {
    const watch = new TranscriptConfidenceWatch();
    watch.observe(evenItem('a', 30, 0.9, 0));
    expect(watch.windowSize).toBe(30);
    expect(watch.mean).toBeCloseTo(0.9, 5);
  });

  it('raises the notice on a sustained degradation', () => {
    const watch = new TranscriptConfidenceWatch();
    // Three commits, ten weak words each, spread over six seconds: every gate
    // (window, tokens, items, span, mean) is satisfied by the third.
    expect(watch.observe(evenItem('a', 10, 0.35, 0))).toBeNull();
    expect(watch.observe(evenItem('b', 10, 0.35, 3_000))).toBeNull();
    const verdict = watch.observe(evenItem('c', 10, 0.35, 6_000));
    expect(verdict?.status).toBe('low_confidence');
    expect(watch.degraded).toBe(true);
  });

  /* ---- the assertions that keep the notice from becoming an irritant ---- */

  it('does NOT fire on a single hard word in otherwise clean speech', () => {
    const watch = new TranscriptConfidenceWatch();
    const verdicts = [
      watch.observe(evenItem('a', 10, 0.94, 0)),
      watch.observe(evenItem('b', 10, 0.94, 3_000)),
      // One proper noun the model has never seen, in an otherwise clean commit.
      watch.observe(
        item(
          'c',
          [
            ['candidcue', 0.02],
            ['is', 0.95],
            ['following', 0.93],
            ['my', 0.96],
            ['voice', 0.94],
            ['right', 0.95],
            ['now', 0.94],
            ['across', 0.92],
            ['the', 0.97],
            ['room', 0.93],
          ],
          6_000,
        ),
      ),
      watch.observe(evenItem('d', 10, 0.94, 9_000)),
    ];
    expect(verdicts.every((v) => v === null)).toBe(true);
    expect(watch.degraded).toBe(false);
  });

  it('does NOT fire on one bad utterance among good ones', () => {
    const watch = new TranscriptConfidenceWatch();
    watch.observe(evenItem('a', 14, 0.93, 0));
    // A whole mangled commit — a cough over a sentence — and still not enough.
    watch.observe(evenItem('b', 14, 0.2, 3_000));
    watch.observe(evenItem('c', 14, 0.93, 6_000));
    expect(watch.degraded).toBe(false);
  });

  it('does NOT fire before the minimum token count, however weak', () => {
    const watch = new TranscriptConfidenceWatch();
    watch.observe(evenItem('a', 5, 0.05, 0));
    watch.observe(evenItem('b', 5, 0.05, 3_000));
    watch.observe(evenItem('c', 5, 0.05, 6_000));
    expect(watch.windowSize).toBeLessThan(T.minTokens);
    expect(watch.degraded).toBe(false);
  });

  it('does NOT fire on weak speech compressed into a moment', () => {
    const watch = new TranscriptConfidenceWatch();
    // Same evidence as the sustained case, delivered inside one second.
    watch.observe(evenItem('a', 10, 0.35, 0));
    watch.observe(evenItem('b', 10, 0.35, 400));
    watch.observe(evenItem('c', 10, 0.35, 800));
    expect(watch.degraded).toBe(false);
  });

  it('does NOT fire from two long commits alone (minItems)', () => {
    const watch = new TranscriptConfidenceWatch();
    watch.observe(evenItem('a', 18, 0.3, 0));
    watch.observe(evenItem('b', 18, 0.3, 8_000));
    expect(watch.windowSize).toBeGreaterThanOrEqual(T.minTokens);
    expect(watch.degraded).toBe(false);
  });

  /* -------------------------------------------------- hysteresis + recovery */

  it('holds through the dead band rather than flapping', () => {
    const watch = new TranscriptConfidenceWatch();
    watch.observe(evenItem('a', 10, 0.35, 0));
    watch.observe(evenItem('b', 10, 0.35, 3_000));
    expect(watch.observe(evenItem('c', 10, 0.35, 6_000))?.status).toBe('low_confidence');
    // Between enterMean and exitMean: better, but not proven recovered.
    const between = (T.enterMean + T.exitMean) / 2;
    watch.observe(evenItem('d', 40, between, 9_000));
    expect(watch.degraded).toBe(true);
  });

  it('clears once the recogniser is clearly back', () => {
    const watch = new TranscriptConfidenceWatch();
    watch.observe(evenItem('a', 10, 0.35, 0));
    watch.observe(evenItem('b', 10, 0.35, 3_000));
    watch.observe(evenItem('c', 10, 0.35, 6_000));
    const recovered = watch.observe(evenItem('d', 40, 0.93, 9_000));
    expect(recovered?.status).toBe('recovered');
    expect(watch.degraded).toBe(false);
  });

  /* --------------------------------------------------------- missing evidence */

  it('treats unattributable transcript as no evidence, not bad evidence', () => {
    const watch = new TranscriptConfidenceWatch();
    for (let i = 0; i < 10; i++) {
      // No logprobs at all: a provider or a model that does not return them.
      expect(
        watch.observe({ itemId: `x${i}`, text: 'one two three four', receivedAtMs: i * 3_000 }),
      ).toBeNull();
    }
    expect(watch.windowSize).toBe(0);
    expect(watch.degraded).toBe(false);
  });

  it('retracts command-channel items from the window (§33.4)', () => {
    const watch = new TranscriptConfidenceWatch();
    watch.observe(evenItem('a', 10, 0.35, 0));
    watch.observe(evenItem('wake', 10, 0.35, 3_000));
    watch.forget(['wake']);
    // The third real commit is now only the second contributor, so `minItems`
    // is unmet and the notice must not appear.
    expect(watch.observe(evenItem('c', 10, 0.35, 6_000))).toBeNull();
    expect(watch.degraded).toBe(false);
  });
});

/* ==========================================================================
 * Store wiring — the half that did not exist.
 * ======================================================================== */

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  appendSessionTranscript: vi.fn(async () => 0),
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
  // §36.3 take history — part of the same module the store imports.
  recordSessionTake: vi.fn(async () => null),
  listSessionTakes: vi.fn(async () => []),
}));

const pipeline = vi.hoisted(() => {
  const captured: { deps: Record<string, (...args: never[]) => unknown> | null } = { deps: null };
  class FakePipeline {
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  }
  return { captured, FakePipeline };
});

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: pipeline.FakePipeline,
  COMMAND_TICK_INTERVAL_MS: 250,
}));
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../../src/control/services/smooth-follow-adapter', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/smooth-follow-adapter')>();
  return { ...actual, subscribeStageMotionAcks: () => () => {} };
});

const { clearSession, startLiveSession, stopSession } = await import(
  '../../../src/control/stores/session'
);
const { smoothFollow } = await import('../../../src/control/stores/smooth-follow');

function compiledStub(): CompiledScript {
  return {
    scriptId: 'script-1',
    sourceHash: 'hash-abc',
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
    ],
    navigationTargets: [],
    spokenTokens: [],
    literalCommandRanges: [],
    outline: [],
  } as unknown as CompiledScript;
}

function startVoiceSession(): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: '11111111-1111-4111-8111-111111111111',
    compiled: compiledStub(),
    sessionGeneration: 4,
    stageGeneration: 2,
  });
}

/** Feed one finalized item through the pipeline's tracking-event callback. */
function feed(entry: TranscriptConfidenceInput): void {
  const deps = pipeline.captured.deps;
  if (!deps) throw new Error('pipeline was never constructed');
  (deps.onTrackingEvent as (event: unknown) => void)({
    type: 'completed',
    sessionGeneration: 4,
    itemId: entry.itemId,
    text: entry.text,
    ...(entry.logprobs ? { logprobs: entry.logprobs } : {}),
    receivedAtMs: entry.receivedAtMs,
  });
}

function noticeIds(): string[] {
  return get(smoothFollow).notices.map((n) => n.id);
}

describe('§60 notice reaches the control window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pipeline.captured.deps = null;
    startVoiceSession();
  });

  afterEach(() => {
    stopSession();
    clearSession();
    vi.useRealTimers();
  });

  it('surfaces low_transcript_confidence after sustained weak transcript', () => {
    expect(noticeIds()).not.toContain('low_transcript_confidence');
    feed(evenItem('a', 10, 0.35, 0));
    feed(evenItem('b', 10, 0.35, 3_000));
    expect(noticeIds()).not.toContain('low_transcript_confidence');
    feed(evenItem('c', 10, 0.35, 6_000));

    expect(get(smoothFollow).transcript.status).toBe('low_confidence');
    expect(noticeIds()).toContain('low_transcript_confidence');
  });

  it('stays silent through a single hard word', () => {
    feed(evenItem('a', 10, 0.94, 0));
    feed(evenItem('b', 10, 0.94, 3_000));
    feed(
      item(
        'c',
        [
          ['candidcue', 0.02],
          ['is', 0.95],
          ['following', 0.93],
          ['my', 0.96],
          ['voice', 0.94],
          ['right', 0.95],
          ['now', 0.94],
          ['across', 0.92],
          ['the', 0.97],
          ['room', 0.93],
        ],
        6_000,
      ),
    );
    feed(evenItem('d', 10, 0.94, 9_000));

    expect(get(smoothFollow).transcript.status).toBe('live');
    expect(noticeIds()).not.toContain('low_transcript_confidence');
  });

  it('clears the notice when the recogniser recovers', () => {
    feed(evenItem('a', 10, 0.35, 0));
    feed(evenItem('b', 10, 0.35, 3_000));
    feed(evenItem('c', 10, 0.35, 6_000));
    expect(noticeIds()).toContain('low_transcript_confidence');

    feed(evenItem('d', 40, 0.93, 9_000));
    expect(get(smoothFollow).transcript.status).toBe('live');
    expect(noticeIds()).not.toContain('low_transcript_confidence');
  });
});
