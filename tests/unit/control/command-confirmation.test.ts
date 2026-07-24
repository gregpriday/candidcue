/**
 * H8 regression: Luna's `requires_confirmation` must be honoured.
 *
 * The defect this pins: `decideExecution()` implemented the whole §33.9
 * confirmation policy and had NO production caller. `voice-session.ts`
 * executed and acknowledged every validated command the instant it was
 * observed, including results Luna had explicitly marked as needing
 * confirmation. An ambiguous "go to the conclusion" jumped somewhere, and a
 * "stop" mid-take stopped the take, without ever asking.
 *
 * These tests drive the real `VoiceSessionPipeline.applyObservation` path via
 * its private surface, because the observation comes out of the real router
 * and the policy decision is what we care about here.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import { VoiceSessionPipeline } from '../../../src/control/services/voice-session';
import { decideExecution, type ExecutionState } from '../../../src/shared/commands/schema';
import type { TranscriptionConfig, ValidatedCommand } from '../../../src/shared/contracts';

const script = compile('# Demo\n\nOne two three four five six seven eight nine ten.\n', {
  scriptId: 'confirm-demo',
  wakePhrases: ['CandidCue'],
});

const CONFIG: TranscriptionConfig = {
  model: 'gpt-realtime-whisper',
  language: 'en',
  delay: 'low',
  requestLogprobs: false,
};

function command(overrides: Partial<ValidatedCommand> = {}): ValidatedCommand {
  return {
    action: { action: 'go_to_target', target: { kind: 'section', title: 'Conclusion' } },
    humanLabel: 'Go to Conclusion',
    requiresConfirmation: false,
    ...overrides,
  } as ValidatedCommand;
}

interface Harness {
  pipe: VoiceSessionPipeline;
  executed: ValidatedCommand[];
  rejected: Array<[string, string]>;
  confirmations: Array<[string, string]>;
  /** Drive the real execution-policy path. */
  run(cmd: ValidatedCommand): Promise<void>;
}

function harness(options: {
  executionState?: ExecutionState;
  confirmAnswer?: boolean | null;
}): Harness {
  const executed: ValidatedCommand[] = [];
  const rejected: Array<[string, string]> = [];
  const confirmations: Array<[string, string]> = [];

  const pipe = new VoiceSessionPipeline({
    sessionId: 'sess-1',
    sessionGeneration: 1,
    compiled: script,
    config: CONFIG,
    getCursorTokenIndex: () => 0,
    getPosition: () => ({ blockId: 'b0', sentenceId: 's0', tokenIndex: 0 }),
    getScrollMode: () => 'voice',
    onTrackingEvent: () => {},
    onMaskItems: () => {},
    onReleaseItems: () => {},
    onCommandPending: () => {},
    executeCommand: (cmd) => executed.push(cmd),
    onUnknownCommand: () => {},
    onTranscriptLine: () => {},
    onConnectionState: () => {},
    getExecutionState: () =>
      options.executionState ?? {
        hardPaused: false,
        takeInProgress: false,
        confirmStopDuringTake: true,
      },
    ...(options.confirmAnswer === null
      ? {}
      : {
          confirmCommand: (cmd: ValidatedCommand, reason: string) => {
            confirmations.push([cmd.humanLabel, reason]);
            return Promise.resolve(options.confirmAnswer ?? false);
          },
        }),
    onCommandRejected: (cmd: ValidatedCommand, reason: string) =>
      rejected.push([cmd.humanLabel, reason]),
  });

  const run = (cmd: ValidatedCommand): Promise<void> =>
    (pipe as unknown as { executeWithPolicy(c: ValidatedCommand): Promise<void> }).executeWithPolicy(
      cmd,
    );

  return { pipe, executed, rejected, confirmations, run };
}

describe('H8: requires_confirmation is honoured', () => {
  it('a command Luna marked as needing confirmation is NOT executed silently', async () => {
    const h = harness({ confirmAnswer: false });
    await h.run(command({ requiresConfirmation: true }));

    // Pre-fix: executed immediately and acknowledged.
    expect(h.executed).toEqual([]);
    expect(h.confirmations).toEqual([['Go to Conclusion', 'ambiguous_target']]);
    expect(h.rejected).toEqual([['Go to Conclusion', 'ambiguous_target']]);
  });

  it('executes only after the user confirms', async () => {
    const h = harness({ confirmAnswer: true });
    await h.run(command({ requiresConfirmation: true }));

    expect(h.confirmations).toHaveLength(1);
    expect(h.executed).toHaveLength(1);
  });

  it('a stop during a take asks first', async () => {
    const h = harness({
      confirmAnswer: false,
      executionState: { hardPaused: false, takeInProgress: true, confirmStopDuringTake: true },
    });
    await h.run(command({ action: { action: 'stop' }, humanLabel: 'Stop' }));

    // The one action a presenter cannot cheaply undo must never fire unasked.
    expect(h.executed).toEqual([]);
    expect(h.confirmations).toEqual([['Stop', 'stop_during_take']]);
  });

  it('a stop outside a take executes directly', async () => {
    const h = harness({
      confirmAnswer: false,
      executionState: { hardPaused: false, takeInProgress: false, confirmStopDuringTake: true },
    });
    await h.run(command({ action: { action: 'stop' }, humanLabel: 'Stop' }));
    expect(h.executed).toHaveLength(1);
    expect(h.confirmations).toEqual([]);
  });

  it('refuses rather than acts when no confirmation surface is wired', async () => {
    const h = harness({ confirmAnswer: null }); // no confirmCommand dep
    await h.run(command({ requiresConfirmation: true }));

    expect(h.executed).toEqual([]);
    expect(h.rejected).toEqual([['Go to Conclusion', 'ambiguous_target']]);
  });

  it('a voice resume during hard pause is rejected, not executed (§34.1)', async () => {
    const h = harness({
      confirmAnswer: true,
      executionState: { hardPaused: true, takeInProgress: false, confirmStopDuringTake: true },
    });
    await h.run(command({ action: { action: 'resume' }, humanLabel: 'Resume' }));

    // The microphone is closed — a voice command physically cannot reach us,
    // so acting on one means something else produced it.
    expect(h.executed).toEqual([]);
    expect(h.rejected).toEqual([['Resume', 'hard_paused']]);
    expect(h.confirmations).toEqual([]);
  });

  it('an unconfirmed command is never acknowledged as executed', async () => {
    const h = harness({ confirmAnswer: false });
    await h.run(command({ requiresConfirmation: true }));
    const log = h.pipe.router.commandLog();
    expect(log.some((entry) => entry.status === 'executed')).toBe(false);
    expect(log.some((entry) => entry.status === 'confirm_required')).toBe(true);
  });

  it('a plain command still executes with no ceremony', async () => {
    const h = harness({ confirmAnswer: false });
    await h.run(command());
    expect(h.executed).toHaveLength(1);
    expect(h.confirmations).toEqual([]);
  });
});

describe('H8: the policy itself is unchanged (it was always correct)', () => {
  it('decideExecution still implements the §33.9 table', () => {
    const base: ExecutionState = {
      hardPaused: false,
      takeInProgress: false,
      confirmStopDuringTake: true,
    };
    expect(decideExecution({ action: 'unknown' }, base, false)).toEqual({
      decision: 'reject',
      reason: 'unknown_action',
    });
    expect(decideExecution({ action: 'pause' }, base, true)).toEqual({
      decision: 'confirm',
      reason: 'ambiguous_target',
    });
    expect(decideExecution({ action: 'pause' }, base, false)).toEqual({ decision: 'execute' });
  });
});
