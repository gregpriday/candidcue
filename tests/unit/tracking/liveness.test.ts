/**
 * LIVENESS — a presenter reading the script correctly reaches the end of it.
 *
 * Every other section-gate property in this suite is one-sided. `§69.7`, the
 * `section-graph.test.ts` fuzz, and the harness's prohibited-jump metric all
 * assert the same shape of thing: *no illegal jump ever happens*. Replace
 * `SectionGraph.evaluate` with a function that returns `{ eligible: false }`
 * unconditionally and every one of them still passes — a gate that refuses
 * everything never jumps anywhere. That is not a hypothetical: two ordinary
 * document shapes made the real gate refuse everything, and the suite stayed
 * green through both.
 *
 *   1. `# Part` immediately followed by `## Scene`. Token ownership is
 *      deepest-wins, so the parent owns nothing but its own heading words —
 *      a span no presenter ever speaks — while it was the only legal successor
 *      of the previous scene. Every real commit landed in the first child, and
 *      was `prohibited_non_contiguous`, at every part boundary, permanently.
 *
 *   2. One fluent sentence straddling a boundary. The entry corridor was
 *      tested against the *end* of the matched span, so a sentence that ran
 *      through the boundary landed past it and was zeroed; every later
 *      utterance landed deeper still, making the wedge monotone.
 *
 *   3. An exact duplicate refrain. Not the gate this time but the §23.2
 *      ambiguity policy, which held whenever two eligible candidates were too
 *      close to separate — and two verbatim copies of a phrase are never
 *      separable, so that hold could not end. See the §23.2 block below.
 *
 * The first two ended in `searching`, which per Appendix E never widens across
 * sections — so the only recovery was manual navigation, live, on camera.
 *
 * These tests assert the missing half, and they are written so that the two
 * halves have to hold *simultaneously*: each scenario checks the §69.7
 * prohibited-jump count is still zero in the same run that checks the cursor
 * got to the end. A fix that unwedged the gate by weakening the prohibition
 * fails here, not somewhere else.
 */
import { describe, expect, it } from 'vitest';
import {
  checkGoldenExpectations,
  runPlayback,
  type PlaybackScenario,
} from '../../../src/shared/tracking/playback-harness';
import {
  allLivenessScenarios,
  distinctForwardSkipTarget,
  scenarioDistinctForwardSkip,
  scenarioDemoReadThrough,
  scenarioNestedPartsReadThrough,
  scenarioNestedPartsStraddle,
  scenarioPreambleReadThrough,
  scenarioRefrainCallBack,
  scenarioRefrainQuotedWhileConfident,
  scenarioShortSectionsReadThrough,
  scenarioShortSectionsStraddle,
} from '../../fixtures/alignment/playback-scenarios';
import { isDenseAlignment } from '../../../src/shared/tracking/alignment-v2';
import { DocumentIndex } from '../../../src/shared/tracking/document-index';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { SectionGraph } from '../../../src/shared/tracking/section-graph';
import { nestedPartsDocument } from '../../fixtures/alignment/fixture-script';
import type { OutlineNode } from '../../../src/shared/contracts/compiler';
import type { TrackingDocument } from '../../../src/shared/tracking/types';

/**
 * How close to the last token counts as "reached the end". The committed
 * cursor lands on the last token the *aligner matched*, and the final sentence
 * ends in stopwords the sequence aligner is entitled to drop, so an exact
 * equality here would be asserting a property of the tokenizer rather than of
 * the gate. Kept far tighter than a section, which is the distance that
 * matters: nothing under this tolerance can be mistaken for "wedged".
 */
const END_TOLERANCE_TOKENS = 6;

/**
 * Every section that owns at least one *body* token, derived from the outline
 * and the token stream rather than from `SectionGraph` — the point being to
 * check the engine against the document, not to agree with it.
 *
 * Heading-only sections (`# Part Two` with a `## Scene C` directly under it)
 * are deliberately excluded: they own nothing but their own title words, so no
 * presenter ever speaks them and no correct cursor can ever be inside one.
 * Requiring the cursor to visit them is requiring the wedge.
 */
function bodySectionIds(document: TrackingDocument): string[] {
  const flat: { id: string; start: number; blockId: string }[] = [];
  const walk = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      flat.push({ id: node.id, start: node.startTokenIndex, blockId: node.blockId });
      walk(node.children);
    }
  };
  walk(document.outline);
  flat.sort((a, b) => a.start - b.start);

  const owners = new Set<string>();
  const headingBlocks = new Set(flat.map((entry) => entry.blockId));
  for (const token of document.spokenTokens) {
    if (headingBlocks.has(token.blockId)) continue; // nobody reads headings
    let owner = '__document__'; // tokens before the first heading
    for (const entry of flat) {
      if (entry.start > token.index) break;
      owner = entry.id;
    }
    owners.add(owner);
  }
  return [...owners].sort();
}

interface LivenessReport {
  failures: string[];
  finalCommitted: number;
  lastTokenIndex: number;
  furthestCommitted: number;
  prohibitedJumps: number;
  sectionsReached: string[];
  sectionsExpected: string[];
  finalState: string;
}

function assessLiveness(scenario: PlaybackScenario): LivenessReport {
  const result = runPlayback(scenario);
  const committed = result.committedAfterAction;
  const reached = new Set<string>();
  for (const section of result.sectionAfterAction) {
    if (section !== undefined) reached.add(section);
  }
  return {
    finalCommitted: committed[committed.length - 1] ?? -1,
    lastTokenIndex: scenario.document.spokenTokens.length - 1,
    furthestCommitted: committed.reduce((max, value) => Math.max(max, value ?? 0), 0),
    prohibitedJumps: result.metrics.prohibitedSectionJumpCount,
    sectionsReached: [...reached].sort(),
    sectionsExpected: bodySectionIds(scenario.document),
    finalState: result.stateAfterAction[result.stateAfterAction.length - 1] ?? 'unknown',
    failures: checkGoldenExpectations(scenario, result),
  };
}

describe('LIVENESS: a correct read-through reaches the end (§13, §13.2)', () => {
  for (const scenario of allLivenessScenarios()) {
    it(`${scenario.id} — ${scenario.description}`, () => {
      const report = assessLiveness(scenario);
      const context =
        `${scenario.id}: committed ${report.finalCommitted}/${report.lastTokenIndex}, ` +
        `furthest ${report.furthestCommitted}, state ${report.finalState}, ` +
        `sections ${report.sectionsReached.join(',')}`;

      // LIVENESS: the cursor got to the end of the script.
      expect(
        report.finalCommitted,
        `${context} — the committed cursor never reached the end of the script`,
      ).toBeGreaterThanOrEqual(report.lastTokenIndex - END_TOLERANCE_TOKENS);

      // LIVENESS: and it got there by passing through every section that
      // holds body text, not by some jump that happened to land near the end.
      // A superset, not equality: the cursor starts at token 0, which on a
      // nested document is inside the first `# Part` heading, so that section
      // is always "visited" before any speech arrives.
      for (const sectionId of report.sectionsExpected) {
        expect(report.sectionsReached, `${context} — never reached ${sectionId}`).toContain(
          sectionId,
        );
      }

      // LIVENESS: a wedged engine ends in `searching` with no way out.
      expect(report.finalState, context).not.toBe('searching');

      // SAFETY, in the same run: unwedging the gate must not have cost the
      // §69.7 release blocker.
      expect(report.prohibitedJumps, context).toBe(0);
      expect(report.failures, context).toEqual([]);
    }, 30_000);
  }
});

describe('LIVENESS: the specific shapes that wedged (§13.2)', () => {
  /**
   * The `# Part` / `## Scene` boundary, at the gate rather than through the
   * engine, so a failure says which edge is missing rather than "the cursor
   * stopped somewhere".
   */
  it('the gate admits Scene B → Scene C across an unspoken `# Part Two`', () => {
    const document = nestedPartsDocument();
    const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
    const graph = new SectionGraph(index, DEFAULT_TRACKING_PROFILE);
    const sceneB = document.outline.find((node) => node.title === 'Scene B');
    const partTwo = document.outline.find((node) => node.title === 'Part Two');
    const sceneC = document.outline.find((node) => node.title === 'Scene C');
    expect(sceneB).toBeDefined();
    expect(partTwo).toBeDefined();
    expect(sceneC).toBeDefined();
    if (sceneB === undefined || partTwo === undefined || sceneC === undefined) return;

    // Part Two owns only its own heading words: nobody ever reads it aloud, so
    // requiring the cursor to land there is requiring the impossible.
    expect(sceneC.startTokenIndex - partTwo.startTokenIndex).toBeLessThanOrEqual(3);

    const verdict = graph.evaluate(
      sceneC.startTokenIndex - 1, // last body token before the part heading
      sceneC.startTokenIndex + 4, // a few words into Scene C's body
      {
        authority: 'ordinary',
        acquired: true,
        recentlyCrossedBoundary: false,
        retakeEvidenceStrong: false,
      },
    );
    expect(verdict.reason).toBe('sequential_next');
    expect(verdict.eligible).toBe(true);
  });

  /**
   * A section with a *body* between the two is still a jump: the §13.2
   * relaxation applies to unspoken headings, not to skipped script.
   */
  it('still prohibits Scene A → Scene C, which would skip Scene B entirely', () => {
    const document = nestedPartsDocument();
    const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
    const graph = new SectionGraph(index, DEFAULT_TRACKING_PROFILE);
    const sceneA = document.outline.find((node) => node.title === 'Scene A');
    const sceneC = document.outline.find((node) => node.title === 'Scene C');
    if (sceneA === undefined || sceneC === undefined) throw new Error('fixture changed');

    const verdict = graph.evaluate(sceneA.startTokenIndex + 4, sceneC.startTokenIndex + 4, {
      authority: 'ordinary',
      acquired: true,
      recentlyCrossedBoundary: false,
      retakeEvidenceStrong: false,
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('prohibited_non_contiguous');
  });

  /**
   * The straddling-utterance edge, at the gate. The candidate ends far past
   * the entry corridor; what makes it legal is where the evidence *entered*.
   */
  it('admits a span that entered at the boundary however far past it it ran', () => {
    const document = nestedPartsDocument();
    const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
    const graph = new SectionGraph(index, DEFAULT_TRACKING_PROFILE);
    const sceneC = document.outline.find((node) => node.title === 'Scene C');
    if (sceneC === undefined) throw new Error('fixture changed');

    const from = sceneC.startTokenIndex - 1;
    const deepInsideSceneC = sceneC.startTokenIndex + 20;
    const context = {
      authority: 'ordinary' as const,
      acquired: true,
      recentlyCrossedBoundary: false,
      retakeEvidenceStrong: false,
    };

    // Without the span start all the gate can see is a destination deep inside
    // the next section, and it is right to refuse it.
    expect(graph.evaluate(from, deepInsideSceneC, context).eligible).toBe(false);
    // With it, the same destination is an ordinary fluent sentence.
    expect(graph.evaluate(from, deepInsideSceneC, context, from - 2).reason).toBe(
      'sequential_next',
    );
    // But a span that *began* deep inside the next section is still a jump.
    expect(graph.evaluate(from, deepInsideSceneC, context, deepInsideSceneC - 1).eligible).toBe(
      false,
    );
  });
});

describe('LIVENESS: the wedges specifically, end to end', () => {
  it('L.1/L.2 — a nested part document is read to the end both carefully and fluently', { timeout: 20_000 }, () => {
    for (const scenario of [scenarioNestedPartsReadThrough(), scenarioNestedPartsStraddle()]) {
      const report = assessLiveness(scenario);
      expect(report.finalCommitted, scenario.id).toBeGreaterThanOrEqual(
        report.lastTokenIndex - END_TOLERANCE_TOKENS,
      );
      expect(report.prohibitedJumps, scenario.id).toBe(0);
    }
  });

  it('L.3/L.4 — eight short sections are read to the end, corridor clamp and all', { timeout: 20_000 }, () => {
    for (const scenario of [scenarioShortSectionsReadThrough(), scenarioShortSectionsStraddle()]) {
      const report = assessLiveness(scenario);
      expect(report.finalCommitted, scenario.id).toBeGreaterThanOrEqual(
        report.lastTokenIndex - END_TOLERANCE_TOKENS,
      );
      expect(report.prohibitedJumps, scenario.id).toBe(0);
    }
  });
});

/* ---------------------------------------------------------------------------
 * The refrain (§23.1, §23.2)
 *
 * The third wedge of this shape, and the first one that is not the section
 * gate's fault. An exact duplicate phrase is, by construction, the one thing
 * lexical evidence can never separate — so a policy that answers "two eligible
 * candidates are too close to tell apart" with *hold* has written a hold that
 * cannot end. §23.2 states the other half first, and it is the half that was
 * missing: **prefer continuity**.
 *
 * The liveness half is L.7 and L.8 in the loop above — a talk that opens and
 * closes on the same four lines, read straight through, and read again with an
 * ordinary aside before the closing copy. L.8 is two-sided on its own, and both
 * sides were measured against the code:
 *
 *   - delete the policy and hold unconditionally, as the engine did, and the
 *     committed cursor stops at 298 of 351 in `lost_local` with the whole
 *     closing refrain undelivered — the recorded failure;
 *   - keep the policy but drop its continuity filter, so a tie resolves to
 *     whichever candidate the later criteria like best, and the same run ends
 *     at committed 55: the engine leaves for the *opening* copy and finishes
 *     the talk 296 tokens behind the presenter.
 *
 * L.9 below holds the other end of the same rule: a refrain quoted out of order
 * must move the cursor nowhere, and the read must still finish. An engine that
 * chases duplicates fails its first assertion; an engine that answers ambiguity
 * by freezing fails its last one.
 * ------------------------------------------------------------------------- */
describe('SAFETY: an exact duplicate is never a reason to move (§23.2)', () => {
  it('L.9 — a duplicate phrase alone never authorizes the jump to its far copy', { timeout: 40_000 }, () => {
    const scenario = scenarioRefrainCallBack();
    const result = runPlayback(scenario);

    // Where the closing copy of the refrain begins.
    const opening = scenario.document.sentences[1]; // s0 is the heading
    expect(opening).toBeDefined();
    const closing = [...scenario.document.sentences]
      .reverse()
      .find((sentence) => sentence.normalizedText === opening?.normalizedText);
    expect(closing, 'fixture no longer contains two verbatim copies').toBeDefined();
    expect(closing?.startTokenIndex).not.toBe(opening?.startTokenIndex);
    if (closing === undefined) return;

    const committed = result.committedAfterAction;
    const settled = committed[scenario.labels?.[0]?.afterAction ?? 0] ?? -1;
    const context =
      `after the interjection the cursor was at ${settled}; the far copy starts at ` +
      `${closing.startTokenIndex}; behaviors ${result.metrics.behaviorsSeen.join(',')}`;

    // SAFETY: the interjection moved nothing. §23.3 — it is acceptable to
    // remain slightly behind for another phrase.
    expect(settled, context).toBeLessThan(closing.startTokenIndex);
    expect(closing.startTokenIndex - settled, context).toBeGreaterThan(
      DEFAULT_TRACKING_PROFILE.largeForwardDistance,
    );
    expect(result.metrics.prohibitedSectionJumpCount, context).toBe(0);
    // The scenario's §69.1 label, checked here: the cursor stayed within 20
    // tokens of the line the presenter had actually just read.
    expect(checkGoldenExpectations(scenario, result), context).toEqual([]);

    // LIVENESS, in the same run: the rest of the script is still read to the
    // end. A policy that answers the interjection by freezing fails here.
    expect(committed[committed.length - 1], context).toBeGreaterThanOrEqual(
      scenario.document.spokenTokens.length - 1 - END_TOLERANCE_TOKENS,
    );
  });
});

/* ---------------------------------------------------------------------------
 * The refrain, on the commit path (§23.1, §23.2)
 *
 * L.9 above reaches §23.2 through the ambiguity policy, and that is the easy
 * half. The engine has to be *unsure* for the ambiguity policy to run at all:
 * L.9's aside flattens the continuity prior, and only then do the two copies of
 * the refrain score closely enough to be a tie.
 *
 * With no aside the engine is confident, and the far copy does not tie the
 * cursor — it beats it. It explains the whole rolling tail verbatim; the
 * cursor's own neighbourhood explains none of it. The margin measured 0.15–0.34
 * against `ambiguityMargin: 0.08`, so `resolveAmbiguity` was never consulted,
 * and the move went down the ordinary forward-commit path: committed cursor
 * 146 → 312, `large_skip`, reason `commit_skip`, confidence 0.897. That is
 * §23.2's last clause — "never use one common repeated phrase as a large-jump
 * trigger" — broken on the path §23.2 is actually about, and it survived the
 * ambiguity fix because it never touched it.
 *
 * The two tests below are one rule seen from both sides, on one document, with
 * exactly one difference between them: what the presenter quotes. L.10 quotes
 * the refrain, whose every phrase occurs twice, and nothing may move. L.11
 * quotes a passage that occurs once, the same distance away in the same
 * section, and the cursor must go there.
 *
 * L.11 is the one that matters. A gate on large forward moves is trivially easy
 * to write in a way that passes every safety test in this repository and every
 * §69.7 assertion in it, because a cursor that never jumps never jumps
 * illegally. Three liveness bugs of exactly that shape have come out of this
 * suite. L.11 is here so a fourth cannot.
 * ------------------------------------------------------------------------- */
describe('SAFETY: a confident engine will not chase a duplicate either (§23.2)', () => {
  it('L.10 — a refrain quoted out of order moves nothing, margin or no margin', { timeout: 40_000 }, () => {
    const scenario = scenarioRefrainQuotedWhileConfident();
    const result = runPlayback(scenario);

    const opening = scenario.document.sentences[1]; // s0 is the heading
    const closing = [...scenario.document.sentences]
      .reverse()
      .find((sentence) => sentence.normalizedText === opening?.normalizedText);
    expect(closing, 'fixture no longer contains two verbatim copies').toBeDefined();
    expect(closing?.startTokenIndex).not.toBe(opening?.startTokenIndex);
    if (closing === undefined) return;

    const committed = result.committedAfterAction;
    const settled = committed[scenario.labels?.[0]?.afterAction ?? 0] ?? -1;
    const context =
      `after the quote the cursor was at ${settled}; the far copy starts at ` +
      `${closing.startTokenIndex}; behaviors ${result.metrics.behaviorsSeen.join(',')}`;

    // SAFETY: the quote did not carry the cursor to the far copy. The recorded
    // failure landed at 312, thirteen tokens into it.
    expect(settled, context).toBeLessThan(closing.startTokenIndex);
    expect(closing.startTokenIndex - settled, context).toBeGreaterThan(
      DEFAULT_TRACKING_PROFILE.largeForwardDistance,
    );
    expect(result.metrics.prohibitedSectionJumpCount, context).toBe(0);
    expect(checkGoldenExpectations(scenario, result), context).toEqual([]);

    // LIVENESS, in the same run: the rest of the script is still read to the
    // end. A gate that answered the quote by freezing fails here.
    expect(committed[committed.length - 1], context).toBeGreaterThanOrEqual(
      scenario.document.spokenTokens.length - 1 - END_TOLERANCE_TOKENS,
    );
  });

  it('L.11 — but a genuine skip onto a passage that occurs once still commits', { timeout: 40_000 }, () => {
    const scenario = scenarioDistinctForwardSkip();
    const result = runPlayback(scenario);
    const target = distinctForwardSkipTarget(scenario.document);

    const committed = result.committedAfterAction;
    const before = committed[scenario.labels?.[0]?.afterAction ?? 0] ?? -1;
    const after = committed[scenario.labels?.[1]?.afterAction ?? 0] ?? -1;
    const context =
      `cursor ${before} → ${after}; the presenter resumed at ${target.startTokenIndex}; ` +
      `behaviors ${result.metrics.behaviorsSeen.join(',')}`;

    // The move really is the kind L.10 forbids: forward, and further than the
    // profile's own large-forward distance. Without this the test could pass on
    // an engine that had merely crawled.
    expect(target.startTokenIndex - before, context).toBeGreaterThan(
      DEFAULT_TRACKING_PROFILE.largeForwardDistance,
    );

    // LIVENESS: the cursor followed the presenter to the new passage and kept
    // reading it, rather than sitting where the skip left off.
    expect(after, context).toBeGreaterThanOrEqual(target.endTokenIndex);
    expect(
      result.metrics.behaviorsSeen.some((b) => b === 'large_skip' || b === 'small_skip'),
      `${context} — the cursor arrived without the engine ever calling it a skip`,
    ).toBe(true);

    // SAFETY, in the same run.
    expect(result.metrics.prohibitedSectionJumpCount, context).toBe(0);
    expect(checkGoldenExpectations(scenario, result), context).toEqual([]);
  });
});

describe('SAFETY: a span start is only evidence when the alignment is dense', () => {
  /**
   * The gate reads `evidenceStartTokenIndex` as a claim that the presenter
   * read continuously from there through the boundary. A sparse match — two
   * distant phrases that both happen to appear in one rolling tail — spans
   * just as many tokens and means nothing, so the beam must not offer its
   * start. Without this, "began behind the cursor" would be a licence to cross
   * a boundary on any long, thin match.
   */
  const pairs = (count: number) => ({
    matchedPairs: Array.from({ length: count }, (_, i) => ({ scriptTokenIndex: i })),
  });

  it('a verbatim read spanning a boundary is dense', () => {
    expect(
      isDenseAlignment({
        startTokenPosition: 10,
        tokenPosition: 50, // 41 script tokens
        sequence: pairs(30) as never, // stopwords dropped, still most of it
      }),
    ).toBe(true);
  });

  it('two distant phrases spanning the same range are not', () => {
    expect(
      isDenseAlignment({
        startTokenPosition: 10,
        tokenPosition: 50,
        sequence: pairs(8) as never,
      }),
    ).toBe(false);
  });

  it('a single-token span is trivially dense', () => {
    expect(
      isDenseAlignment({ startTokenPosition: 7, tokenPosition: 7, sequence: pairs(1) as never }),
    ).toBe(true);
  });
});

/**
 * LIVENESS under real transcript confidence (§30.5, §60).
 *
 * `TranscriptLedger` now attaches per-token ASR confidence from the provider's
 * log probabilities, which the app has been paying for and discarding. That
 * value reaches `confidenceModel` as `transcriptConfidence`, and every
 * threshold in `DEFAULT_TRACKING_PROFILE` — `lockedThreshold`,
 * `globalThreshold`, `backwardThreshold`, `minimumForwardMargin` — was tuned
 * while it was pinned at 1.0. A multiplier that has only ever been 1 is exactly
 * the kind of change that produces a gate which refuses to move while every
 * safety test stays green.
 *
 * So the liveness property is re-asserted with the signal turned down as far as
 * it goes. `0.05` is a transcript no presenter would tolerate; the point is that
 * even there the confidence model's bounded `0.85 + 0.15·c` factor cannot wedge
 * the cursor, and the §69.7 prohibited-jump count is still zero in the same run.
 */
function withTranscriptConfidence(
  scenario: PlaybackScenario,
  probability: number,
): PlaybackScenario {
  const logprob = Math.log(probability);
  return {
    ...scenario,
    id: `${scenario.id}+conf${probability}`,
    actions: scenario.actions.map((action) => {
      if (action.kind !== 'transcript' || action.event.type !== 'completed') return action;
      const words = action.event.text.split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) return action;
      return {
        ...action,
        event: {
          ...action.event,
          logprobs: words.map((word, i) => ({ token: i === 0 ? word : ` ${word}`, logprob })),
        },
      };
    }),
  };
}

describe('LIVENESS: a hopeless transcript degrades, it does not wedge (§60)', () => {
  // One scenario per document SHAPE, rather than the whole shared list: each
  // straddle variant exercises the same gate on the same document, and the
  // refrain fixture is the slowest in the suite.
  const shapes = [
    scenarioNestedPartsReadThrough(),
    scenarioShortSectionsReadThrough(),
    scenarioPreambleReadThrough(),
    scenarioDemoReadThrough(),
  ];
  for (const shape of shapes) {
    it(`${shape.id} at ASR confidence 0.05`, () => {
      const report = assessLiveness(withTranscriptConfidence(shape, 0.05));
      const context =
        `${shape.id}: committed ${report.finalCommitted}/${report.lastTokenIndex}, ` +
        `state ${report.finalState}`;
      expect(
        report.finalCommitted,
        `${context} — real ASR confidence wedged the cursor`,
      ).toBeGreaterThanOrEqual(report.lastTokenIndex - END_TOLERANCE_TOKENS);
      expect(report.finalState, context).not.toBe('searching');
      expect(report.prohibitedJumps, context).toBe(0);
    }, 30_000);
  }
});
