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
 * Both ended in `searching`, which per Appendix E never widens across
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
  scenarioNestedPartsReadThrough,
  scenarioNestedPartsStraddle,
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
    }, 20_000);
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
