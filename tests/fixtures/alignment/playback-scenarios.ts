/**
 * Appendix D scenario traces, expressed as deterministic playback scenarios
 * (companion §66, Appendix D).
 *
 * Each builder returns a complete `PlaybackScenario`: an action stream with
 * fixed timestamps, hand labels for the §69.1 position-error metric, and the
 * golden expectations §66.1 asks for (permitted behaviors, forbidden
 * behaviors, legal section).
 *
 * Token landmarks in the shared demo script:
 *   Welcome              h0   0–61   "channel"=7 "listens"=18 "away"=26 "back"=61
 *   The Kaleidoscope Demo h1  62–116  "watch"=66 "time"=80 "similarity"=106
 *   Closing Thoughts      h2 117–146
 */
import type {
  PlaybackAction,
  PlaybackScenario,
} from '../../../src/shared/tracking/playback-harness';
import { demoDocument } from './fixture-script';
import { TranscriptScripter, type SpeechTurn } from '../transcript-events/builder';

interface TurnSpec extends SpeechTurn {
  /** Emit animation ticks after this turn to exercise prediction/settling. */
  tickForMs?: number;
  tickEveryMs?: number;
}

/**
 * Build an action stream from spoken turns, recording where each turn ends so
 * labels can be attached without hand-counting action indexes.
 */
function build(turns: readonly TurnSpec[]): {
  actions: PlaybackAction[];
  endOfTurn: number[];
} {
  const scripter = new TranscriptScripter(10_000, 1);
  const actions: PlaybackAction[] = [];
  const endOfTurn: number[] = [];
  for (const turn of turns) {
    for (const event of scripter.speak(turn)) actions.push({ kind: 'transcript', event });
    if (turn.tickForMs !== undefined) {
      const step = turn.tickEveryMs ?? 33;
      for (let t = step; t <= turn.tickForMs; t += step) {
        actions.push({ kind: 'tick', nowMs: scripter.clockMs + t });
      }
      scripter.advance(turn.tickForMs);
    }
    endOfTurn.push(actions.length - 1);
  }
  return { actions, endOfTurn };
}

/** D.1 — smooth linear read. */
export function scenarioSmoothRead(): PlaybackScenario {
  const { actions, endOfTurn } = build([
    { text: 'Hello everyone and welcome to the channel.', tickForMs: 400 },
    {
      text: 'Today we are talking about building a teleprompter that actually listens.',
      tickForMs: 400,
    },
    { text: "Let's get started with the basics right away.", tickForMs: 400 },
  ]);
  return {
    id: 'D.1',
    description: 'Smooth linear read: continuous motion, no jumps, no holds.',
    document: demoDocument(),
    actions,
    labels: [
      { afterAction: endOfTurn[0] ?? 0, intendedTokenIndex: 7, toleranceTokens: 3, sectionId: 'h0' },
      { afterAction: endOfTurn[1] ?? 0, intendedTokenIndex: 18, toleranceTokens: 3, sectionId: 'h0' },
      { afterAction: endOfTurn[2] ?? 0, intendedTokenIndex: 26, toleranceTokens: 3, sectionId: 'h0' },
    ],
    expectBehaviors: ['normal'],
    forbidBehaviors: ['retake', 'large_skip', 'lost'],
  };
}

/** D.2 — brief ad-lib: no script consumption during the example. */
export function scenarioBriefAdlib(): PlaybackScenario {
  const { actions, endOfTurn } = build([
    { text: 'Hello everyone and welcome to the channel.' },
    {
      text: 'Today we are talking about building a teleprompter that actually listens.',
      tickForMs: 300,
    },
    {
      text: "quick side note my dog jumped straight into the neighbor's swimming pool this morning it was absolutely chaotic honestly",
      // Long settle window: the coast → decelerate → hold schedule must run
      // to completion and stop (§19.2).
      tickForMs: 2500,
    },
    { text: "Let's get started with the basics right away.", tickForMs: 300 },
  ]);
  return {
    id: 'D.2',
    description: 'Brief ad-lib: bounded drift, then hold, then a smooth return.',
    document: demoDocument(),
    actions,
    labels: [
      { afterAction: endOfTurn[1] ?? 0, intendedTokenIndex: 18, toleranceTokens: 3, sectionId: 'h0' },
      // The cursor must NOT have consumed script during the ad-lib.
      { afterAction: endOfTurn[2] ?? 0, intendedTokenIndex: 18, toleranceTokens: 4, sectionId: 'h0' },
      { afterAction: endOfTurn[3] ?? 0, intendedTokenIndex: 26, toleranceTokens: 4, sectionId: 'h0' },
    ],
    expectBehaviors: ['adlib'],
    forbidBehaviors: ['retake', 'large_skip'],
  };
}

/**
 * D.3 — paraphrase resolved with sidecar help.
 *
 * There was no playback scenario for D.3 at all, so the whole
 * `applySemanticAssist → setSemanticAssist → semanticAdjustment` path was
 * never exercised end to end: the bounded-influence contract was unit-tested,
 * but nothing checked that advisory evidence reaches the beam through a real
 * engine, or — more importantly — that it stays advisory when it does.
 *
 * The presenter paraphrases a sentence rather than reading it, and the sidecar
 * returns a `paraphrase` opinion on a candidate the engine itself minted. The
 * assist may help the cursor settle; it may not move it on its own.
 */
export function scenarioParaphraseWithAssist(): PlaybackScenario {
  const scripter = new TranscriptScripter(10_000, 1);
  const actions: PlaybackAction[] = [];
  for (const text of [
    'Hello everyone and welcome to the channel.',
    'Today we are talking about building a teleprompter that actually listens.',
  ]) {
    for (const event of scripter.speak({ text })) actions.push({ kind: 'transcript', event });
  }
  const afterRead = actions.length - 1;

  // The sidecar answers about `continuity:26` — a candidate the local engine
  // minted for the sentence beginning "Let's get started…". Timestamped inside
  // the §40.4 lifetime and stamped with the current epoch and source items, so
  // it is genuinely accepted rather than silently discarded as stale.
  actions.push({
    kind: 'semantic_assist',
    evidence: {
      assistId: 'assist-d3',
      epoch: 0,
      requestRevision: 1,
      sourceItemIds: ['item-1-1', 'item-1-2'],
      receivedAtMs: scripter.clockMs,
      opinions: [{ candidateId: 'continuity:26', relation: 'paraphrase', confidence: 0.85 }],
    },
  });

  // A paraphrase rather than a reading of the authored sentence.
  for (const event of scripter.speak({ text: 'let us begin with the basics right away' })) {
    actions.push({ kind: 'transcript', event });
  }
  for (let t = 33; t <= 400; t += 33) {
    actions.push({ kind: 'tick', nowMs: scripter.clockMs + t });
  }
  scripter.advance(400);
  const afterParaphrase = actions.length - 1;

  return {
    id: 'D.3',
    description: 'Paraphrase with sidecar assist: advisory evidence, never authority.',
    document: demoDocument(),
    actions,
    labels: [
      { afterAction: afterRead, intendedTokenIndex: 18, toleranceTokens: 3, sectionId: 'h0' },
      // The assist may help it settle; it may not carry the cursor anywhere.
      { afterAction: afterParaphrase, intendedTokenIndex: 26, toleranceTokens: 6, sectionId: 'h0' },
    ],
    forbidBehaviors: ['large_skip', 'retake'],
  };
}

/** D.4 — distant phrase collision: zero remote section jump. */
export function scenarioDistantCollision(): PlaybackScenario {
  const { actions, endOfTurn } = build([
    { text: 'Hello everyone and welcome to the channel.' },
    {
      text: 'Today we are talking about building a teleprompter that actually listens.',
    },
    // Verbatim from the Kaleidoscope chapter — perfect lexical evidence for a
    // destination the section graph forbids.
    {
      text: 'Now watch the kaleidoscope demo carefully because the colors shift like a metronome keeping perfect time.',
      tickForMs: 500,
    },
  ]);
  return {
    id: 'D.4',
    description: 'Distant phrase collision: the remote candidate is ineligible.',
    document: demoDocument(),
    actions,
    labels: [
      // Must remain in Welcome, near where it was. The tolerance has to be
      // narrower than the section: Welcome is tokens 0–61, so ±45 accepted
      // positions already inside the *next* chapter and made
      // `correctPositionRate` meaningless for the flagship prohibited-jump
      // scenario.
      { afterAction: endOfTurn[2] ?? 0, intendedTokenIndex: 18, toleranceTokens: 12, sectionId: 'h0' },
    ],
    forbidBehaviors: ['large_skip'],
  };
}

/** D.5 — previous-sentence retake: one controlled reverse, no bounce. */
export function scenarioPreviousSentenceRetake(): PlaybackScenario {
  const { actions, endOfTurn } = build([
    { text: "Let's get started with the basics right away." },
    {
      text: 'The first principle is that the prompter follows you instead of forcing you to follow it.',
    },
    { text: 'When you pause the prompter pauses.', tickForMs: 300 },
    // A pause, then the previous sentence restarts.
    {
      gapMs: 1200,
      text: 'The first principle is that the prompter follows you instead of forcing you to follow it',
      tickForMs: 600,
    },
  ]);
  return {
    id: 'D.5',
    description: 'Previous-sentence retake: commits backward once and stays there.',
    document: demoDocument(),
    actions,
    labels: [
      { afterAction: endOfTurn[2] ?? 0, intendedTokenIndex: 43, toleranceTokens: 8, sectionId: 'h0' },
      { afterAction: endOfTurn[3] ?? 0, intendedTokenIndex: 43, toleranceTokens: 10, sectionId: 'h0' },
    ],
    expectBehaviors: ['retake'],
    retakeIsExpected: true,
    forbidBehaviors: ['large_skip'],
  };
}

/** D.6 — large within-section skip: re-anchor rather than race. */
export function scenarioLargeWithinSectionSkip(): PlaybackScenario {
  const { actions, endOfTurn } = build([
    { text: 'Hello everyone and welcome to the channel.' },
    {
      text: 'When you ad lib the prompter waits patiently for you to come back.',
      tickForMs: 500,
    },
  ]);
  return {
    id: 'D.6',
    description: 'Large within-section skip: eligible, final-gated, re-anchored.',
    document: demoDocument(),
    actions,
    labels: [
      { afterAction: endOfTurn[0] ?? 0, intendedTokenIndex: 7, toleranceTokens: 3, sectionId: 'h0' },
      // Welcome ends at 61: a tolerance of 4 already reaches into the next
      // chapter, so the section label is doing all the work. Keep it inside.
      { afterAction: endOfTurn[1] ?? 0, intendedTokenIndex: 61, toleranceTokens: 2, sectionId: 'h0' },
    ],
    skipIsExpected: true,
    forbidBehaviors: ['retake'],
  };
}

/** D.7 — wake-gated command to another chapter. */
export function scenarioCommandToOtherChapter(): PlaybackScenario {
  const scripter = new TranscriptScripter(10_000, 1);
  const actions: PlaybackAction[] = [];
  for (const event of scripter.speak({ text: 'Hello everyone and welcome to the channel.' })) {
    actions.push({ kind: 'transcript', event });
  }
  const afterRead = actions.length - 1;

  // The command router masks the command utterance before alignment sees it
  // (§51 step 3), then supplies the authoritative destination (§56.1).
  actions.push({ kind: 'command_pending', pending: true, nowMs: scripter.clockMs });
  for (const event of scripter.speak({ text: 'candid cue go to closing thoughts' })) {
    actions.push({ kind: 'transcript', event });
  }
  actions.push({ kind: 'mask', itemIds: ['item-1-1'] });
  actions.push({ kind: 'command_pending', pending: false, nowMs: scripter.clockMs });
  actions.push({ kind: 'move', tokenIndex: 121, movement: 'command', nowMs: scripter.clockMs });
  const afterCommand = actions.length - 1;

  for (const event of scripter.speak({
    text: 'Remember to subscribe and share this video with a friend.',
  })) {
    actions.push({ kind: 'transcript', event });
  }
  const afterResume = actions.length - 1;

  return {
    id: 'D.7',
    description: 'Voice command to another chapter: immediate, intentional, epoch-stamped.',
    document: demoDocument(),
    actions,
    labels: [
      { afterAction: afterRead, intendedTokenIndex: 7, toleranceTokens: 3, sectionId: 'h0' },
      { afterAction: afterCommand, intendedTokenIndex: 121, toleranceTokens: 1, sectionId: 'h2' },
      { afterAction: afterResume, intendedTokenIndex: 133, toleranceTokens: 5, sectionId: 'h2' },
    ],
    // The command lands mid-sentence and the presenter then reads the *next*
    // sentence, so the remainder of the first one is genuinely skipped. That
    // is intended here, and Closing Thoughts is only 30 tokens long, so the
    // section-scaled skip threshold correctly calls it a skip.
    skipIsExpected: true,
    expectBehaviors: ['command_navigation'],
  };
}

export function allPlaybackScenarios(): PlaybackScenario[] {
  return [
    scenarioSmoothRead(),
    scenarioBriefAdlib(),
    scenarioParaphraseWithAssist(),
    scenarioDistantCollision(),
    scenarioPreviousSentenceRetake(),
    scenarioLargeWithinSectionSkip(),
    scenarioCommandToOtherChapter(),
  ];
}
