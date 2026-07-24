/**
 * The hard section-eligibility invariant (companion §13, §3.3, §69.7,
 * Appendix B.2, D.4).
 *
 * "An uncommanded non-contiguous section jump is prohibited even if a
 * distinctive phrase matches perfectly." §69.7 makes any occurrence a release
 * blocker, so this file tests the gate directly *and* fuzzes the whole engine
 * against random speech to show the invariant survives contact with the
 * decision layer.
 */
import { describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { DocumentIndex } from '../../../src/shared/tracking/document-index';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { SectionGraph } from '../../../src/shared/tracking/section-graph';
import type { SectionTransitionContext } from '../../../src/shared/tracking/section-graph';
import { compileFixtureScript, demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

/** Welcome = 0–61, The Kaleidoscope Demo = 62–116, Closing Thoughts = 117–146. */
const WELCOME_START = 0;
const WELCOME_END = 61;
const KALEIDOSCOPE_START = 62;
const CLOSING_START = 117;

function graph(): SectionGraph {
  const document = demoDocument();
  const index = new DocumentIndex(document, { rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight });
  return new SectionGraph(index, DEFAULT_TRACKING_PROFILE);
}

function ordinary(overrides?: Partial<SectionTransitionContext>): SectionTransitionContext {
  return {
    authority: 'ordinary',
    acquired: true,
    recentlyCrossedBoundary: false,
    retakeEvidenceStrong: false,
    ...overrides,
  };
}

describe('SectionGraph eligibility (companion §13, B.2)', () => {
  it('always allows movement inside the current section', () => {
    const g = graph();
    expect(g.isEligible(WELCOME_START, WELCOME_END, ordinary())).toBe(true);
    expect(g.isEligible(WELCOME_END, WELCOME_START, ordinary())).toBe(true);
  });

  it('PROHIBITS a non-contiguous jump to a distant section (§13.1, D.4)', () => {
    const g = graph();
    const verdict = g.evaluate(10, CLOSING_START + 5, ordinary());
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('prohibited_non_contiguous');
  });

  it('prohibits entering the next section from far inside the current one', () => {
    const g = graph();
    // Sequential progression is allowed only through the *end boundary*.
    expect(g.isEligible(5, KALEIDOSCOPE_START + 2, ordinary())).toBe(false);
  });

  it('allows sequential progression through the end boundary (§13.2)', () => {
    const g = graph();
    expect(g.isEligible(WELCOME_END - 2, KALEIDOSCOPE_START + 2, ordinary())).toBe(true);
  });

  it('allows a boundary retake only just after crossing, with strong evidence (§21.2)', () => {
    const g = graph();
    const from = KALEIDOSCOPE_START + 3;
    const to = WELCOME_END - 3;
    expect(g.isEligible(from, to, ordinary())).toBe(false);
    expect(
      g.isEligible(from, to, ordinary({ recentlyCrossedBoundary: true })),
    ).toBe(false); // needs retake evidence too
    expect(
      g.isEligible(
        from,
        to,
        ordinary({ recentlyCrossedBoundary: true, retakeEvidenceStrong: true }),
      ),
    ).toBe(true);
  });

  it('never allows a two-section backward jump even with maximal evidence', () => {
    const g = graph();
    expect(
      g.isEligible(
        CLOSING_START + 2,
        WELCOME_END,
        ordinary({ recentlyCrossedBoundary: true, retakeEvidenceStrong: true }),
      ),
    ).toBe(false);
  });

  it('command and manual authority may open any validated target (§12.6)', () => {
    const g = graph();
    expect(g.isEligible(5, CLOSING_START + 5, ordinary({ authority: 'command' }))).toBe(true);
    expect(g.isEligible(5, CLOSING_START + 5, ordinary({ authority: 'manual' }))).toBe(true);
  });

  it('authority still rejects a target outside the authorized set', () => {
    const g = graph();
    const verdict = g.evaluate(5, CLOSING_START + 5, {
      ...ordinary({ authority: 'command' }),
      authorizedSectionIds: new Set(['h1']),
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('prohibited_unauthorized_target');
  });

  it('acquisition is not a transition — an unacquired engine may lock anywhere (§17.1)', () => {
    const g = graph();
    const verdict = g.evaluate(0, CLOSING_START + 5, ordinary({ acquired: false }));
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBe('unacquired');
  });

  it('a document with no outline is one implicit section', () => {
    const document = compileFixtureScript('Just one paragraph with several words in it.');
    const index = new DocumentIndex(document);
    const g = new SectionGraph(index, DEFAULT_TRACKING_PROFILE);
    expect(g.isEligible(0, document.spokenTokens.length - 1, ordinary())).toBe(true);
  });
});

describe('prohibited jumps never reach the cursor (property, §69.7)', () => {
  /**
   * A phrase lifted verbatim from a distant chapter is the strongest possible
   * lexical evidence for an ineligible destination. Companion D.4 requires the
   * candidate to be visible in diagnostics but never executable.
   */
  it('a verbatim distant-chapter sentence does not move the cursor there (D.4)', () => {
    const engine = new AlignmentEngine(demoDocument(), {
      sessionId: 'gate-1',
      sessionGeneration: 1,
      stageGeneration: 1,
    });
    const scripter = new TranscriptScripter(10_000, 1);
    // Acquire in Welcome.
    for (const event of scripter.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      engine.handleTranscriptEvent(event);
    }
    expect(engine.sectionGraph.sectionIdAt(engine.cursor.committedTokenIndex)).toBe('h0');

    // Now speak a distinctive sentence that exists only in Chapter 2.
    for (const event of scripter.speak({
      text: 'Now watch the kaleidoscope demo carefully because the colors shift like a metronome keeping perfect time.',
    })) {
      engine.handleTranscriptEvent(event);
    }

    expect(engine.sectionGraph.sectionIdAt(engine.cursor.committedTokenIndex)).toBe('h0');
    expect(engine.cursor.committedTokenIndex).toBeLessThanOrEqual(KALEIDOSCOPE_START - 1);
    // The candidate was seen and explicitly rejected, not merely outscored.
    expect(engine.measurement?.blockedCount ?? 0).toBeGreaterThan(0);
    expect(engine.measurement?.blocked?.reason).toBe('prohibited_non_contiguous');
  });

  /**
   * The previous fuzz checked section *adjacency* only, so a mid-section →
   * mid-section move into the neighbouring chapter passed — which is exactly
   * the defect class the boundary-corridor clamp was added for, and exactly
   * what the C1 mutation produces. It also generated only contiguous verbatim
   * runs of real script tokens, and only final evidence, so it never explored
   * paraphrases, interleavings, out-of-order completions, or the provisional
   * path at all.
   *
   * Section spans and the corridor are computed here from the outline, not
   * from `SectionGraph`, for the same reason the harness metric is: a check
   * that calls the gate's own helpers cannot catch a defect in them.
   */
  it('fuzz: no random speech ever produces an uncommanded non-contiguous jump', { timeout: 60_000 }, () => {
    const document = demoDocument();
    const spans = document.outline
      .map((node) => ({
        id: node.id,
        start: node.startTokenIndex,
        end: node.endTokenIndex,
      }))
      .sort((a, b) => a.start - b.start);
    const ownerOf = (tokenIndex: number): number =>
      spans.findIndex((span) => tokenIndex >= span.start && tokenIndex <= span.end);
    // Generous relative corridor: strictly looser than any sane engine value,
    // so only a corridor that has swallowed the section body trips it.
    const corridorOf = (index: number): number => {
      const span = spans[index];
      if (span === undefined) return 0;
      return Math.max(1, (span.end - span.start + 1) * 0.35);
    };

    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const words = document.spokenTokens.map((token) => token.normalized);
    const FILLERS = ['um', 'so', 'okay', 'basically', 'right', 'you', 'know'];

    /** Build one utterance: verbatim, paraphrased, interleaved, or shuffled. */
    const utterance = (): string => {
      const start = Math.floor(random() * Math.max(1, words.length - 12));
      const length = 4 + Math.floor(random() * 9);
      const run = words.slice(start, start + length);
      switch (Math.floor(random() * 4)) {
        case 0:
          return run.join(' '); // verbatim
        case 1: {
          // Paraphrase: drop and substitute words, keep order.
          const kept = run.filter(() => random() > 0.3);
          const noisy = kept.flatMap((word) =>
            random() > 0.75 ? [FILLERS[Math.floor(random() * FILLERS.length)] ?? 'um', word] : [word],
          );
          return noisy.join(' ');
        }
        case 2: {
          // Interleaving: a second run from somewhere else spliced in.
          const other = Math.floor(random() * Math.max(1, words.length - 8));
          return [...run.slice(0, 4), ...words.slice(other, other + 5)].join(' ');
        }
        default: {
          // Out-of-order: the words the presenter said, jumbled.
          const shuffled = [...run];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            const a = shuffled[i];
            const b = shuffled[j];
            if (a !== undefined && b !== undefined) {
              shuffled[i] = b;
              shuffled[j] = a;
            }
          }
          return shuffled.join(' ');
        }
      }
    };

    for (let trial = 0; trial < 24; trial++) {
      const engine = new AlignmentEngine(document, {
        sessionId: `fuzz-${trial}`,
        sessionGeneration: 1,
        stageGeneration: 1,
      });
      const scripter = new TranscriptScripter(10_000, 1);
      let previousToken = 0;
      let acquired = false;
      // Half the trials stream deltas, so the provisional path is fuzzed too.
      const withDeltas = trial % 2 === 0;
      /** Completions held back and replayed late, out of commit order (§30.7). */
      const delayed: ReturnType<TranscriptScripter['speak']> = [];

      for (let turn = 0; turn < 6; turn++) {
        const text = utterance();
        if (text.trim().length === 0) continue;

        const events = scripter.speak({ text, withDeltas });
        for (const event of events) {
          // Occasionally hold a completion back and deliver it several turns
          // later, after newer speech has already been aligned.
          if (event.type === 'completed' && random() > 0.8) {
            delayed.push(event);
            continue;
          }
          engine.handleTranscriptEvent(event);
          check();
        }
        if (delayed.length > 0 && random() > 0.6) {
          const late = delayed.shift();
          if (late !== undefined) {
            engine.handleTranscriptEvent({ ...late, receivedAtMs: scripter.clockMs });
            check();
          }
        }
      }

      function check(): void {
        const token = engine.cursor.committedTokenIndex;
        if (!acquired) {
          // Acquisition may land anywhere (§17.1); start policing afterwards.
          if (token > 0) {
            acquired = true;
            previousToken = token;
          }
          return;
        }
        const from = ownerOf(previousToken);
        const to = ownerOf(token);
        const fromToken = previousToken;
        previousToken = token;
        if (from === to || from < 0 || to < 0) return;

        const label = `trial ${trial}: ${fromToken}(${spans[from]?.id}) → ${token}(${spans[to]?.id})`;
        // 1. Adjacency.
        expect(Math.abs(to - from), `${label}: non-contiguous section jump`).toBe(1);
        // 2. Corridor — the part the old fuzz never checked, and the part the
        //    corridor clamp exists for.
        const forward = to > from;
        const origin = spans[from];
        const destination = spans[to];
        if (origin === undefined || destination === undefined) return;
        const leftNearBoundary = forward
          ? origin.end - fromToken <= corridorOf(from)
          : fromToken - origin.start <= corridorOf(from);
        expect(leftNearBoundary, `${label}: left the section from its body`).toBe(true);
        const enteredNearBoundary = forward
          ? token - destination.start <= corridorOf(to)
          : destination.end - token <= corridorOf(to);
        expect(enteredNearBoundary, `${label}: entered the section at its body`).toBe(true);
      }
    }
  });
});
