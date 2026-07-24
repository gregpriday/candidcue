/**
 * `:::literal-command` end-to-end wiring (spec §33.5).
 *
 * The compiler has always derived `CompiledScript.literalCommandRanges`, and
 * both consumers (the tracking document and the command router) have always
 * accepted them — but nothing passed them across. Until then the ONLY
 * protection was heuristic collision scoring, which is exactly what the
 * directive exists to not depend on. These tests assert the wiring itself:
 * compile real Markdown, run it through the real session driver and the real
 * voice pipeline, and prove that reading a wake phrase aloud from inside a
 * literal block does not execute a command while the same words outside one
 * still do.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import {
  createWorkerTrackingDriver,
  setTrackingWorkerFactoryForTesting,
  type TrackingWorkerLike,
} from '../../../src/control/services/session';
import { VoiceSessionPipeline } from '../../../src/control/services/voice-session';
import type { TrackingWorkerInbound } from '../../../src/shared/tracking/worker-protocol';
import type { TranscriptionConfig, ValidatedCommand } from '../../../src/shared/contracts';

/**
 * The literal block deliberately does NOT contain the words of the command
 * that gets spoken. That is what makes this a test of the wiring rather than
 * of the collision heuristic: a block that quotes the command verbatim is
 * already suppressed by `scoreScriptCollision`, so it proves nothing about
 * whether `literalCommandRanges` reached the router. Here the phrase scores
 * near zero against the surrounding script, and the ONLY thing that can stop
 * it is the authored literal range.
 */
const SOURCE = `# Demo

Welcome to the walkthrough of the onboarding flow that our team rebuilt over
the winter, starting with the parts customers see first and working backwards
towards the plumbing underneath. The opening section covers the invitation
email, the landing page it points at, and the two questions we ask before
anyone is allowed to create a workspace. None of that changed much, but the
timing did, and the timing is what people actually noticed. After that we get
into the migration itself, which is where most of the interesting decisions
were made and where most of the arguments happened. The database cutover ran
on a Sunday morning and finished about an hour ahead of the window we had
booked with the hosting provider, which surprised absolutely everyone.

:::literal-command
Whenever the prompter should stop, you address it by name and then tell it
plainly what it is that you would like it to do next for you.
:::

Now let us talk about pricing and the numbers behind it, because the figures
tell a much better story than any of the marketing language ever could, and
the audience deserves the detail rather than a summary slide.
`;

const script = compile(SOURCE, { scriptId: 'literal-demo', wakePhrases: ['CandidCue'] });

/** Token index sitting inside the compiled literal-command range. */
function insideLiteral(): number {
  const range = script.literalCommandRanges[0];
  if (!range) throw new Error('fixture should produce a literal-command range');
  return Math.floor((range.startTokenIndex + range.endTokenIndex) / 2);
}

/**
 * Token index clear of every literal range AND of the ±80-token collision
 * window around it, so the "outside" case exercises the wiring rather than
 * the heuristic that fires when the literal text itself is nearby.
 */
function outsideLiteral(): number {
  const range = script.literalCommandRanges[0];
  if (!range) throw new Error('fixture should produce a literal-command range');
  if (range.startTokenIndex < 100) {
    throw new Error('fixture must put the literal block well past the opening cursor');
  }
  return 5;
}

class FakeWorker implements TrackingWorkerLike {
  posted: TrackingWorkerInbound[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message as TrackingWorkerInbound);
  }
  addEventListener(): void {}
  terminate(): void {}
}

const CONFIG: TranscriptionConfig = {
  model: 'gpt-realtime-whisper',
  language: 'en',
  delay: 'low',
  requestLogprobs: false,
};

function pipeline(cursorTokenIndex: number): {
  pipe: VoiceSessionPipeline;
  executed: ValidatedCommand[];
} {
  const executed: ValidatedCommand[] = [];
  const pipe = new VoiceSessionPipeline({
    sessionId: 'sess-1',
    sessionGeneration: 1,
    compiled: script,
    config: CONFIG,
    getCursorTokenIndex: () => cursorTokenIndex,
    getPosition: () => ({ blockId: 'b0', sentenceId: 's0', tokenIndex: cursorTokenIndex }),
    getScrollMode: () => 'voice',
    onTrackingEvent: () => {},
    onMaskItems: () => {},
    onCommandPending: () => {},
    executeCommand: (command) => executed.push(command),
    onUnknownCommand: () => {},
    onTranscriptLine: () => {},
    onConnectionState: () => {},
  });
  return { pipe, executed };
}

afterEach(() => {
  setTrackingWorkerFactoryForTesting(null);
});

describe(':::literal-command enforcement (§33.5)', () => {
  it('the compiler produces a literal-command range for the fixture', () => {
    expect(script.literalCommandRanges.length).toBeGreaterThan(0);
    const range = script.literalCommandRanges[0]!;
    expect(range.endTokenIndex).toBeGreaterThan(range.startTokenIndex);
  });

  it('the session driver hands the ranges to the tracking worker', () => {
    const worker = new FakeWorker();
    setTrackingWorkerFactoryForTesting(() => worker);
    createWorkerTrackingDriver({
      sessionId: 's',
      scriptId: script.scriptId,
      sentences: script.sentences,
      totalTokens: script.spokenTokens.length,
      compiled: script,
      onSnapshot: () => {},
      onTranscript: () => {},
    });
    const initialize = worker.posted.find((m) => m.type === 'initialize');
    expect(initialize?.type).toBe('initialize');
    if (initialize?.type !== 'initialize') throw new Error('no initialize message');
    expect(initialize.document.literalCommandRanges).toEqual(script.literalCommandRanges);
    expect(initialize.document.literalCommandRanges?.length).toBeGreaterThan(0);
  });

  it('does not execute a command spoken from inside a literal-command block', () => {
    const { pipe, executed } = pipeline(insideLiteral());
    pipe.ledger.setSessionGeneration(1);
    pipe.ledger.apply({
      type: 'completed',
      sessionGeneration: 1,
      itemId: 'item-inside',
      text: 'candid cue pause',
      receivedAtMs: 1000,
    });
    expect(pipe.router.observe(1, 1000).kind).toBe('none');
    expect(executed).toHaveLength(0);
  });

  it('still executes the same command spoken outside every literal range', () => {
    const { pipe } = pipeline(outsideLiteral());
    pipe.ledger.setSessionGeneration(1);
    pipe.ledger.apply({
      type: 'completed',
      sessionGeneration: 1,
      itemId: 'item-outside',
      text: 'candid cue pause',
      receivedAtMs: 1000,
    });
    const observation = pipe.router.observe(1, 1000);
    expect(observation.kind).toBe('command');
    if (observation.kind === 'command') {
      expect(observation.command.action).toEqual({ action: 'pause' });
    }
  });
});
