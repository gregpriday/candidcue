/**
 * B1 regression: the §33.4 release path had no production caller.
 *
 * `CommandObservation.none` carries `releaseItemIds` whenever the router
 * decides a wake-like phrase was authored script after all (cursor inside a
 * literal block, a literal-range match, or a collision score at or above
 * `scriptCollisionThreshold`). `TrackingDriver.releaseItems` and the worker's
 * `release_items` case both existed and were both correct — but nothing in
 * `voice-session.ts` ever read `releaseItemIds`, so the ONLY caller of the whole
 * path in the repo was the playback harness.
 *
 * The consequence in production: a spurious wake masks the sentence the
 * presenter is reading, the router then correctly rules it authored script, and
 * the aligner never gets the sentence back — `maskedItemIds` grows monotonically
 * for the life of the session and the presenter's own words stop counting.
 *
 * These tests drive the real pipeline, the real router, the real worker-backed
 * driver, and the real alignment engine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import { VoiceSessionPipeline } from '../../../src/control/services/voice-session';
import {
  createWorkerTrackingDriver,
  setTrackingWorkerFactoryForTesting,
  type TrackingWorkerLike,
} from '../../../src/control/services/session';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { buildTrackingDocument } from '../../../src/shared/tracking/types';
import type { TrackingWorkerInbound } from '../../../src/shared/tracking/worker-protocol';
import type { TranscriptionConfig } from '../../../src/shared/contracts';
import type { TranscriptEvent as TrackingEvent } from '../../../src/shared/tracking/types';

/**
 * The script *says the wake phrase out loud*, which is the whole scenario:
 * reading this paragraph aloud trips the wake gate, the phrase is collected and
 * masked while it is still provisional, and only the finalized item scores high
 * enough against the surrounding script for the router to rule it authored text.
 */
const SOURCE = `# Demo

Before we begin let me show you how the prompter is driven by voice while the
camera is rolling and the lights are already set for the wide shot.

If you want it to wait for you, you simply say CandidCue pause the prompter and
it stops moving until you pick the thread back up again in your own time.

That is the whole trick, and it works the same way for every other instruction
you might reasonably want to give it while you are on camera.
`;

const script = compile(SOURCE, { scriptId: 'release-demo', wakePhrases: ['CandidCue'] });

const CONFIG: TranscriptionConfig = {
  model: 'gpt-realtime-whisper',
  language: 'en',
  delay: 'low',
  requestLogprobs: false,
};

/** Cursor sitting on the authored wake phrase, where the presenter is reading. */
function wakeTokenIndex(): number {
  const index = script.spokenTokens.findIndex((t) => t.normalized.includes('candid'));
  if (index < 0) throw new Error('fixture must contain the wake phrase in the script text');
  return index;
}

/** The words the presenter reads aloud, in two turns: partial, then final. */
const PARTIAL = 'you simply say candid cue';
const FINAL = 'you simply say candid cue pause the prompter and it stops moving until you pick';

class FakeWorker implements TrackingWorkerLike {
  posted: TrackingWorkerInbound[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message as TrackingWorkerInbound);
  }
  addEventListener(): void {}
  terminate(): void {}
}

interface Harness {
  pipe: VoiceSessionPipeline;
  masked: string[][];
  released: string[][];
  pending: boolean[];
  /** Feed the pipeline exactly as the transport would. */
  transport(event: unknown): void;
}

function harness(bind?: { mask?(ids: string[]): void; release?(ids: string[]): void }): Harness {
  const masked: string[][] = [];
  const released: string[][] = [];
  const pending: boolean[] = [];
  let clock = 1000;
  const pipe = new VoiceSessionPipeline({
    sessionId: 'sess-release',
    sessionGeneration: 1,
    compiled: script,
    config: CONFIG,
    getCursorTokenIndex: () => wakeTokenIndex(),
    getPosition: () => ({ blockId: 'b0', sentenceId: 's0', tokenIndex: wakeTokenIndex() }),
    getScrollMode: () => 'voice',
    onTrackingEvent: () => {},
    onMaskItems: (ids) => {
      masked.push([...ids]);
      bind?.mask?.(ids);
    },
    onReleaseItems: (ids) => {
      released.push([...ids]);
      bind?.release?.(ids);
    },
    onCommandPending: (value) => pending.push(value),
    executeCommand: () => {},
    onUnknownCommand: () => {},
    onTranscriptLine: () => {},
    onConnectionState: () => {},
    now: () => (clock += 100),
  });
  const transport = (event: unknown): void => {
    (pipe as unknown as { handleTransportEvent(e: unknown): void }).handleTransportEvent(event);
  };
  return { pipe, masked, released, pending, transport };
}

/** Read the authored wake sentence aloud: one provisional turn, then the final. */
function readTheWakeSentenceAloud(h: Harness): void {
  h.transport({ type: 'item_started', itemId: 'item-1', commitSequence: 1 });
  h.transport({ type: 'delta', itemId: 'item-1', text: PARTIAL, receivedAtMs: 0 });
  h.transport({ type: 'completed', itemId: 'item-1', text: FINAL });
}

afterEach(() => {
  setTrackingWorkerFactoryForTesting(null);
});

describe('§33.4 release path (B1)', () => {
  it('the router does produce a release for authored script (fixture sanity)', () => {
    const h = harness();
    h.transport({ type: 'item_started', itemId: 'item-1', commitSequence: 1 });
    h.transport({ type: 'delta', itemId: 'item-1', text: PARTIAL, receivedAtMs: 0 });
    // Provisional and not a complete grammar → the aligner is frozen and the
    // items are masked out of alignment.
    expect(h.masked).toEqual([['item-1']]);
    expect(h.pending).toEqual([true]);
  });

  it('hands the masked items back to alignment once the phrase reads as script', () => {
    const h = harness();
    readTheWakeSentenceAloud(h);

    // Pre-fix this was `[]`: `case 'none'` dropped `releaseItemIds` on the floor.
    expect(h.released).toEqual([['item-1']]);
    expect(h.pending).toEqual([true, false]);
  });

  it('reaches the tracking worker as a release_items message', () => {
    const worker = new FakeWorker();
    setTrackingWorkerFactoryForTesting(() => worker);
    const driver = createWorkerTrackingDriver({
      sessionId: 'sess-release',
      scriptId: script.scriptId,
      sentences: script.sentences,
      totalTokens: script.spokenTokens.length,
      compiled: script,
      onSnapshot: () => {},
      onTranscript: () => {},
    });
    // Exactly the binding the session store makes.
    const h = harness({
      mask: (ids) => driver.maskItems(ids),
      release: (ids) => driver.releaseItems(ids),
    });
    readTheWakeSentenceAloud(h);

    const release = worker.posted.filter((m) => m.type === 'release_items');
    expect(release).toEqual([{ type: 'release_items', itemIds: ['item-1'] }]);
    const mask = worker.posted.filter((m) => m.type === 'mask_items');
    expect(mask).toEqual([{ type: 'mask_items', itemIds: ['item-1'] }]);
  });
});

describe('§33.4 release path reaches the aligner (B1)', () => {
  function engine(): AlignmentEngine {
    return new AlignmentEngine(buildTrackingDocument(script, script.literalCommandRanges), {
      sessionId: 'sess-release',
      sessionGeneration: 1,
      stageGeneration: 1,
    });
  }

  const item = (text: string, itemId: string, atMs: number): TrackingEvent => ({
    type: 'completed',
    sessionGeneration: 1,
    itemId,
    text,
    receivedAtMs: atMs,
  });

  it('a released item is consumed by alignment again; a masked one never is', () => {
    const withRelease = engine();
    withRelease.maskItems(['item-1']);
    withRelease.handleTranscriptEvent(item(FINAL, 'item-1', 1000));
    expect(withRelease.maskedItemCount).toBe(1);
    const beforeRelease = withRelease.cursor.committedTokenIndex;

    withRelease.releaseItems(['item-1']);
    expect(withRelease.maskedItemCount).toBe(0);
    // A later turn re-runs alignment over a tail that now contains item-1.
    withRelease.handleTranscriptEvent(item('the thread back up again', 'item-2', 2000));

    const withoutRelease = engine();
    withoutRelease.maskItems(['item-1']);
    withoutRelease.handleTranscriptEvent(item(FINAL, 'item-1', 1000));
    withoutRelease.handleTranscriptEvent(item('the thread back up again', 'item-2', 2000));

    // The released run has strictly more evidence and lands further along the
    // authored sentence; the permanently-masked run is missing the whole turn.
    expect(beforeRelease).toBe(0);
    expect(withRelease.cursor.committedTokenIndex).toBeGreaterThan(
      withoutRelease.cursor.committedTokenIndex,
    );
    expect(withRelease.maskedItemCount).toBe(0);
    expect(withoutRelease.maskedItemCount).toBe(1);
  });
});
