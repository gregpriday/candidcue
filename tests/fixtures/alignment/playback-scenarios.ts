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
import type { OutlineNode } from '../../../src/shared/contracts/compiler';
import type { TrackingDocument } from '../../../src/shared/tracking/types';
import {
  demoDocument,
  nestedPartsDocument,
  preambleDocument,
  refrainDocument,
  shortSectionsDocument,
} from './fixture-script';
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

/* ---------------------------------------------------------------------------
 * Liveness scenarios (the property the suite had no assertion for)
 *
 * Every existing section-graph property is one-sided: "no illegal jump ever
 * happens". Replace the gate with a function that returns *always ineligible*
 * and all of them still pass, because a gate that refuses everything never
 * jumps anywhere. These scenarios assert the other half — a presenter who
 * reads the script correctly reaches the end of it — so a refuse-everything
 * gate fails, and both properties have to hold at once.
 * ------------------------------------------------------------------------- */

/** Blocks that are headings; presenters do not read these aloud. */
function headingBlockIds(document: TrackingDocument): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      ids.add(node.blockId);
      walk(node.children);
    }
  };
  walk(document.outline);
  return ids;
}

/** Every body sentence, verbatim, in reading order. */
function bodySentenceTexts(document: TrackingDocument): string[] {
  const headings = headingBlockIds(document);
  return document.sentences
    .filter((sentence) => !headings.has(sentence.blockId))
    .sort((a, b) => a.startTokenIndex - b.startTokenIndex)
    .map((sentence) =>
      document.spokenTokens
        .slice(sentence.startTokenIndex, sentence.endTokenIndex + 1)
        .map((token) => token.surface)
        .join(' '),
    );
}

export interface ReadThroughOptions {
  /**
   * Sentences per spoken utterance. `1` is a careful reader who pauses at
   * every full stop; `2` is a fluent one.
   */
  sentencesPerTurn?: number;
  /**
   * Offset the grouping by one sentence. In these fixtures every section holds
   * exactly two body sentences, so `sentencesPerTurn: 2` with `offset: 1`
   * makes every utterance after the first straddle exactly one section
   * boundary: it begins on the previous section's closing sentence and runs
   * on, unbroken, into the next section's opening one. That is the shape that
   * produced a matched span *ending* far past the entry corridor, and with it
   * the monotone wedge — each following utterance landed deeper than the last.
   *
   * Exactly one boundary per utterance is deliberate. §13 permits advancing to
   * the *immediate* next section, so an utterance that swallowed two whole
   * sections would be asking for a transition the specification prohibits,
   * which is a different question from the one these scenarios ask.
   */
  offset?: number;
  gapMs?: number;
}

/**
 * A verbatim read-through of a whole document: the plainest possible correct
 * behaviour, and the thing that has to work.
 */
export function scenarioVerbatimReadThrough(
  id: string,
  description: string,
  document: TrackingDocument,
  options?: ReadThroughOptions,
): PlaybackScenario {
  const perTurn = Math.max(1, options?.sentencesPerTurn ?? 1);
  const offset = Math.max(0, Math.min(perTurn - 1, options?.offset ?? 0));
  const sentences = bodySentenceTexts(document);
  const turns: TurnSpec[] = [];
  const push = (parts: string[]): void => {
    if (parts.length === 0) return;
    turns.push({
      text: parts.join(' '),
      ...(options?.gapMs !== undefined ? { gapMs: options.gapMs } : {}),
    });
  };
  if (offset > 0) push(sentences.slice(0, offset));
  for (let i = offset; i < sentences.length; i += perTurn) {
    push(sentences.slice(i, i + perTurn));
  }
  const { actions } = build(turns);
  return {
    id,
    description,
    document,
    actions,
    // Nothing here is a retake or a jump: it is one pass through the script.
    forbidBehaviors: ['retake'],
  };
}

/* ---------------------------------------------------------------------------
 * Misspeaking — the tolerance the product is actually sold on
 * ------------------------------------------------------------------------- */

/**
 * Words a presenter says that are not the words on the page.
 *
 * Deliberately ordinary English rather than nonsense: a stumble produces real
 * words, and real words are what the fuzzy and phonetic tiers have to decline
 * to match. Nonsense would be easier for the aligner than the truth is.
 */
const WRONG_WORDS = [
  'basically',
  'obviously',
  'whatever',
  'something',
  'anyway',
  'honestly',
  'actually',
  'certainly',
  'possibly',
  'apparently',
];

/** Words too small or too common to be worth scoring. */
const MISSPEAK_SKIP = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'if',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'so',
  'the',
  'to',
  'we',
  'you',
]);

/**
 * Replace a FRACTION of a sentence's content words with unrelated ones.
 *
 * A fraction rather than a count, because the fixtures' sentences are seven to
 * nine words long: asking for "six wrong words" in an eight-word sentence
 * silently produced two, and a test that believes it is exercising heavy
 * divergence while feeding mild divergence is worse than no test. The count it
 * actually applied is returned so a caller can assert on it.
 *
 * Stopwords are left alone. Swapping `the` for `a` is not what anyone means by
 * misspeaking, and the weak-match tier already treats it as nearly free — the
 * substitutions have to land on the words the score is built from.
 */
function misspeak(sentence: string, fraction: number, seed = 0): { text: string; changed: number } {
  const words = sentence.split(' ');
  const contentPositions = words
    .map((word, index) => ({ bare: word.replace(/[^A-Za-z']/g, '').toLowerCase(), index }))
    .filter((entry) => entry.bare.length >= 4 && !MISSPEAK_SKIP.has(entry.bare))
    .map((entry) => entry.index);
  const target = Math.min(contentPositions.length, Math.round(contentPositions.length * fraction));
  let changed = 0;
  for (let i = 0; i < target; i++) {
    // Spread the substitutions rather than clustering them: scattered errors
    // are both more realistic and strictly harder for the aligner, because a
    // contiguous run of nonsense leaves the surrounding ordered run intact.
    const position = contentPositions[Math.floor((i * contentPositions.length) / target)];
    if (position === undefined) continue;
    words[position] = WRONG_WORDS[(seed + i) % WRONG_WORDS.length] ?? 'whatever';
    changed++;
  }
  return { text: words.join(' '), changed };
}

export interface MisspeakOptions extends ReadThroughOptions {
  /**
   * Utterance indexes to garble, and what FRACTION of each one's content words
   * to replace (0–1). Every other utterance is spoken verbatim.
   */
  garble: ReadonlyMap<number, number>;
}

/**
 * A read-through in which some utterances come out wrong.
 *
 * This is the shape the corpus was missing. Every other "messy" fixture here
 * generates its spoken text from `document.spokenTokens[].surface`, so the
 * words are correct by construction and divergence is impossible — the suite
 * could vary document topology and utterance grouping thoroughly while never
 * once asking what happens when a presenter says the wrong word.
 */
export function scenarioMisspokenReadThrough(
  id: string,
  description: string,
  document: TrackingDocument,
  options: MisspeakOptions,
): PlaybackScenario & { endOfTurn: number[]; wordsChanged: number[] } {
  const perTurn = Math.max(1, options.sentencesPerTurn ?? 1);
  const sentences = bodySentenceTexts(document);
  const turns: TurnSpec[] = [];
  const wordsChanged: number[] = [];
  for (let i = 0, utterance = 0; i < sentences.length; i += perTurn, utterance++) {
    const verbatim = sentences.slice(i, i + perTurn).join(' ');
    const fraction = options.garble.get(utterance) ?? 0;
    const spoken = fraction > 0 ? misspeak(verbatim, fraction, utterance) : { text: verbatim, changed: 0 };
    wordsChanged.push(spoken.changed);
    turns.push({
      text: spoken.text,
      ...(options.gapMs !== undefined ? { gapMs: options.gapMs } : {}),
    });
  }
  const { actions, endOfTurn } = build(turns);
  // `endOfTurn` is exposed because the assertions are about the cursor's
  // TRAJECTORY, one reading per utterance. Inferring the boundaries from the
  // committed trace instead cannot work: a stall produces no change, so any
  // attempt to recover utterances by watching the value move erases exactly
  // the thing being measured.
  return { id, description, document, actions, forbidBehaviors: ['retake'], endOfTurn, wordsChanged };
}

/** Utterance count for a document at a given grouping — for the assertions. */
export function utteranceCount(document: TrackingDocument, sentencesPerTurn = 1): number {
  return Math.ceil(bodySentenceTexts(document).length / Math.max(1, sentencesPerTurn));
}

export function scenarioNestedPartsReadThrough(): PlaybackScenario {
  return scenarioVerbatimReadThrough(
    'L.1',
    'Verbatim read-through of a `# Part` / `## Scene` document, one sentence per breath.',
    nestedPartsDocument(),
  );
}

export function scenarioNestedPartsStraddle(): PlaybackScenario {
  return scenarioVerbatimReadThrough(
    'L.2',
    'Same nested document read fluently, so utterances straddle every part boundary.',
    nestedPartsDocument(),
    { sentencesPerTurn: 2, offset: 1 },
  );
}

export function scenarioShortSectionsReadThrough(): PlaybackScenario {
  return scenarioVerbatimReadThrough(
    'L.3',
    'Eight short sections: the entry corridor clamps to a token or two.',
    shortSectionsDocument(),
  );
}

export function scenarioShortSectionsStraddle(): PlaybackScenario {
  return scenarioVerbatimReadThrough(
    'L.4',
    'Eight short sections read fluently, so every utterance crosses a boundary.',
    shortSectionsDocument(),
    { sentencesPerTurn: 2, offset: 1 },
  );
}

export function scenarioPreambleReadThrough(): PlaybackScenario {
  return scenarioVerbatimReadThrough(
    'L.5',
    'Unowned preamble before the first heading, then three flat sections.',
    preambleDocument(),
  );
}

export function scenarioDemoReadThrough(): PlaybackScenario {
  return scenarioVerbatimReadThrough(
    'L.6',
    'Verbatim read-through of the shared demo script, flat `#` sections.',
    demoDocument(),
  );
}

/** Three sentences of ordinary live patter that appear nowhere in any script. */
const OFF_SCRIPT_ASIDE = [
  'Sorry give me one second while I find the right slide on this laptop.',
  'The clicker keeps disconnecting and I never trust hotel audio visual equipment.',
  'Anyway you can all see the screen now so let me pick this back up.',
];

export function scenarioRefrainReadThrough(): PlaybackScenario {
  return scenarioVerbatimReadThrough(
    'L.7',
    'A talk whose closing beat repeats its opening refrain word for word.',
    refrainDocument(),
  );
}

/**
 * The refrain reached after an aside — the §23.2 shape that wedged.
 *
 * The presenter breaks off for three sentences of ordinary live patter (a
 * clicker that will not connect) and then rejoins the script on the closing
 * refrain. Two things are true at that moment and both are ordinary:
 *
 *   - the rolling tail holds the *aside*, not the script, so the refrain
 *     utterance arrives with no surrounding content to say which copy it is;
 *   - nothing has matched confidently for several seconds, so §31.14 flattens
 *     the continuity prior — deliberately, so that global reacquisition stays
 *     reachable — and with it goes the only thing that had been separating the
 *     near copy from the far one.
 *
 * The two copies then score *identically*, to three decimals, and the ambiguity
 * policy is the only thing left that can decide between them. Since the refrain
 * is the last block of the script, an engine that will not decide never reaches
 * the end of it: the recorded failure was a committed cursor 53 tokens short
 * with the whole closing refrain undelivered, on camera, with manual navigation
 * the only way out.
 *
 * The aside is *not* what makes this a fair test — it is what makes it a
 * frequent one. Any lapse in confidence flattens the same prior.
 */
export function scenarioRefrainAfterAside(): PlaybackScenario {
  const document = refrainDocument();
  const sentences = bodySentenceTexts(document);
  const refrainOpening = sentences[0] ?? '';

  const turns: TurnSpec[] = [];
  let copiesSeen = 0;
  for (const text of sentences) {
    if (text === refrainOpening) {
      copiesSeen++;
      // Break off immediately before the *closing* copy, not the opening one.
      if (copiesSeen === 2) {
        for (const line of OFF_SCRIPT_ASIDE) turns.push({ text: line, gapMs: 900 });
      }
    }
    turns.push({ text });
  }
  const { actions } = build(turns);

  return {
    id: 'L.8',
    description: 'An aside, then the script rejoined on a verbatim closing refrain.',
    document,
    actions,
    // The presenter only ever moves forward: coming back on the refrain is a
    // continuation, and reading it as a return to the opening copy would be a
    // false retake of two hundred tokens.
    forbidBehaviors: ['retake'],
  };
}

/**
 * The safety counterpart to `scenarioRefrainAfterAside`.
 *
 * Same aside as L.8 — so the continuity prior is flattened and the tail carries
 * no script context, exactly the conditions that make two copies of a refrain
 * score identically — but this time the presenter comes back with the tagline
 * quoted *out of order*, from the middle of the second verse. The two copies
 * are now roughly equidistant, one behind and one ahead, and neither of them is
 * where the presenter actually is.
 *
 * §23.2's last clause is unconditional: never use one common repeated phrase as
 * a large-jump trigger. Nothing in this evidence continues the reading, so the
 * right answer is to stay where the presenter is and let the next line settle
 * it (§23.3) — and then finish the script.
 *
 * The two assertions pull opposite ways in one run: the interjection must move
 * the cursor nowhere, *and* the read must still reach the end. An engine that
 * chases the duplicate fails the first; an engine that answers ambiguity by
 * freezing fails the second.
 */
export function scenarioRefrainCallBack(): PlaybackScenario {
  const document = refrainDocument();
  const sentences = bodySentenceTexts(document);
  const refrainOpening = sentences[0] ?? '';
  // Four sentences of refrain, then two whole verses: far from both copies.
  const interjectAfter = 4 + 6;

  const turns: TurnSpec[] = [];
  let interjection = -1;
  sentences.forEach((text, index) => {
    turns.push({ text });
    if (index === interjectAfter - 1) {
      for (const line of OFF_SCRIPT_ASIDE) turns.push({ text: line, gapMs: 900 });
      turns.push({ text: refrainOpening, gapMs: 700 });
      interjection = turns.length - 1;
    }
  });
  const { actions, endOfTurn } = build(turns);

  return {
    id: 'L.9',
    description: 'A refrain quoted out of order after an aside: a duplicate is not a jump trigger.',
    document,
    actions,
    labels: [
      {
        afterAction: endOfTurn[interjection] ?? 0,
        // Where the presenter actually is: the end of the last line they read.
        intendedTokenIndex: document.sentences[interjectAfter]?.endTokenIndex ?? 0,
        // Wide enough for the ordinary provisional lead and the ordinary §23.3
        // lag; far narrower than the distance to either copy of the refrain.
        toleranceTokens: 20,
        sectionId: 'h0',
      },
    ],
    forbidBehaviors: ['large_skip', 'retake'],
  };
}

/* ---------------------------------------------------------------------------
 * L.10 / L.11 — the same rule as L.9, on the *commit* path.
 *
 * L.9 reaches §23.2 through the ambiguity policy: the aside flattens the
 * continuity prior, the two copies of the refrain then score identically, and
 * `resolveAmbiguity` is what refuses the move. That is only one of the two ways
 * a refrain can move the cursor, and it is not the dangerous one.
 *
 * Take the aside away and the engine is *confident*. The far copy of the
 * refrain then does not tie the near cursor — it beats it outright, because it
 * explains the whole tail verbatim and the cursor's own neighbourhood explains
 * none of it. The margin is 0.15–0.34, several times `ambiguityMargin`, so the
 * ambiguity policy is never consulted at all and the move goes straight down
 * the ordinary forward-commit path. Measured on this fixture before the gate
 * existed: committed cursor 146 → 312, behaviour `large_skip`, reason
 * `commit_skip`, confidence 0.897. §23.2's last clause, violated with a healthy
 * margin.
 *
 * The pair below is written to fail in opposite directions, on one document,
 * with one difference between them — *what the presenter quotes*:
 *
 *   - L.10 quotes the refrain, whose every phrase appears twice. Nothing may
 *     move.
 *   - L.11 quotes a passage that appears once, from further down the same
 *     section. The cursor must go there.
 *
 * An engine that chases duplicates fails L.10. An engine that answers the
 * problem by refusing large forward moves — the fourth freeze this suite has
 * been asked not to acquire — fails L.11.
 * ------------------------------------------------------------------------- */

/** Body sentences read straight through, with `quote` inserted after `after`. */
function refrainInterjection(
  id: string,
  description: string,
  after: number,
  quote: (sentences: readonly string[]) => string[],
  extra: Partial<PlaybackScenario>,
): PlaybackScenario {
  const document = refrainDocument();
  const sentences = bodySentenceTexts(document);

  const turns: TurnSpec[] = [];
  let interjection = -1;
  sentences.forEach((text, index) => {
    turns.push({ text });
    if (index === after - 1) {
      for (const line of quote(sentences)) turns.push({ text: line, gapMs: 700 });
      interjection = turns.length - 1;
    }
  });
  const { actions, endOfTurn } = build(turns);

  return {
    id,
    description,
    document,
    actions,
    labels: [
      {
        afterAction: endOfTurn[interjection] ?? 0,
        // Where the presenter actually is: the end of the last line they read.
        // `sentences[0]` is the heading, so body sentence `after - 1` is
        // `document.sentences[after]`.
        intendedTokenIndex: document.sentences[after]?.endTokenIndex ?? 0,
        toleranceTokens: 20,
        sectionId: 'h0',
      },
    ],
    ...extra,
  };
}

/**
 * L.10 — the refrain quoted out of order while the engine is confident.
 *
 * Twelve body sentences read straight through (the refrain, a whole verse, and
 * two lines of the next), so the cursor is locked and the prior is at full
 * strength, and then the opening line of the refrain as an aside — the shape of
 * every "as I said at the start…". The far copy of that line is 166 tokens
 * ahead, which is a large forward move on this script and comfortably inside
 * the continuity window, so nothing upstream of the decision layer stops it.
 */
export function scenarioRefrainQuotedWhileConfident(): PlaybackScenario {
  return refrainInterjection(
    'L.10',
    'A refrain quoted out of order while confident: still not a jump trigger.',
    4 + 6 + 2,
    (sentences) => [sentences[0] ?? ''],
    { forbidBehaviors: ['large_skip', 'retake'] },
  );
}

/**
 * L.11 — the same interruption, made of material that occurs once.
 *
 * The presenter genuinely jumps: after the same twelve sentences they drop the
 * rest of the second verse and pick up at the third, which is exactly the
 * distance L.10 forbids and the same section. Its opening line is not
 * remarkable — "Deployment frequency doubled within a quarter and the rollback
 * rate fell sharply" is ordinary prose, and words like "quarter", "frequency"
 * and "rate" recur elsewhere in the talk — but the *phrases* are its own, and
 * that is what the gate reads.
 *
 * Three sentences, not one: a real skip is followed by more reading, and the
 * scenario should fail if the cursor arrives and then loses its place.
 */
export function scenarioDistinctForwardSkip(): PlaybackScenario {
  const document = refrainDocument();
  const sentences = bodySentenceTexts(document);
  const readFirst = 4 + 6 + 2;
  const resumeAt = 4 + 6 + 6; // first line of the third verse

  const turns: TurnSpec[] = [];
  for (const text of sentences.slice(0, readFirst)) turns.push({ text });
  const beforeJump = turns.length - 1;
  for (const text of sentences.slice(resumeAt, resumeAt + 3)) turns.push({ text });
  const afterJump = turns.length - 1;
  const { actions, endOfTurn } = build(turns);

  return {
    id: 'L.11',
    description: 'A genuine forward skip onto a passage that occurs once: it must be followed.',
    document,
    actions,
    labels: [
      {
        afterAction: endOfTurn[beforeJump] ?? 0,
        intendedTokenIndex: document.sentences[readFirst]?.endTokenIndex ?? 0,
        toleranceTokens: 12,
        sectionId: 'h0',
      },
      {
        afterAction: endOfTurn[afterJump] ?? 0,
        intendedTokenIndex: document.sentences[resumeAt + 3]?.endTokenIndex ?? 0,
        toleranceTokens: 20,
        sectionId: 'h0',
      },
    ],
    // Where the presenter resumed, so a test can name the destination without
    // recounting sentences.
    skipIsExpected: true,
    forbidBehaviors: ['retake'],
  };
}

/** The token span L.11's presenter resumes at, derived the same way. */
export function distinctForwardSkipTarget(document: TrackingDocument): {
  startTokenIndex: number;
  endTokenIndex: number;
} {
  const resumeAt = 4 + 6 + 6;
  const sentence = document.sentences[resumeAt + 1];
  return {
    startTokenIndex: sentence?.startTokenIndex ?? 0,
    endTokenIndex: sentence?.endTokenIndex ?? 0,
  };
}

/** Every liveness scenario, for the shared assertion loop. */
export function allLivenessScenarios(): PlaybackScenario[] {
  return [
    scenarioNestedPartsReadThrough(),
    scenarioNestedPartsStraddle(),
    scenarioShortSectionsReadThrough(),
    scenarioShortSectionsStraddle(),
    scenarioPreambleReadThrough(),
    scenarioDemoReadThrough(),
    scenarioRefrainReadThrough(),
    scenarioRefrainAfterAside(),
    // L.9, L.10 and L.11 are deliberately *not* here. Each is two-sided on its
    // own — its own test asserts the safety half and the liveness half in one
    // run — and the refrain document is the slowest fixture in the suite, so
    // running it through the shared loop as well only buys a second copy of
    // assertions that are already being made.
  ];
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
