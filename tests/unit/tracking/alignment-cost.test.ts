/**
 * §63 cost control: per-transcript-event work must not track script length.
 *
 * `alignment-v2.ts` claims "total work stays proportional to the candidate cap
 * plus the beam width, never to script length". It did not hold: the `section`
 * candidate window spanned the *entire* current section, a common-ish "rare"
 * word contributed a 161-token window per occurrence, and overlapping windows
 * merged into arbitrarily large spans — so a 6400-token script cost roughly an
 * order of magnitude more per event than a 440-token one, on identical input.
 * The recogniser emits several deltas per second, so the worker fell
 * permanently and cumulatively behind on any script longer than a few minutes.
 *
 * The assertion is a *ratio*, deliberately, so it means the same thing on a
 * loaded CI box as on a quiet laptop. Absolute milliseconds here would be a
 * flake generator, not a regression test.
 */
import { describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { compileFixtureScript } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

/** A ~400-word vocabulary, so tokens repeat the way real prose does. */
const VOCABULARY = Array.from({ length: 400 }, (_, i) => `lexeme${i}`);

function syntheticScript(targetTokens: number, seed = 12345): string {
  let state = seed >>> 0;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const words: string[] = [];
  while (words.length < targetTokens) {
    words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)] ?? 'lexeme0');
  }
  const sentences: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    sentences.push(`${words.slice(i, i + 12).join(' ')}.`);
  }
  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += 4) {
    paragraphs.push(sentences.slice(i, i + 4).join(' '));
  }
  // A real script has headings, and a chapter of any length is one section.
  // That matters: the `section` candidate window used to span the whole
  // section, so on a long chapter it spanned the whole chapter.
  return `# Chapter one\n\n${paragraphs.join('\n\n')}`;
}

/**
 * Replay a fixed number of transcript events, all drawn from the same offset
 * in the script, so only script *length* varies between measurements.
 */
const documents = new Map<number, ReturnType<typeof compileFixtureScript>>();
function documentOf(targetTokens: number) {
  const cached = documents.get(targetTokens);
  if (cached !== undefined) return cached;
  const built = compileFixtureScript(syntheticScript(targetTokens));
  documents.set(targetTokens, built);
  return built;
}

function costPerEventMs(targetTokens: number): number {
  const document = documentOf(targetTokens);
  const spoken = document.spokenTokens.slice(20, 44).map((t) => t.normalized);
  const turns = [
    spoken.slice(0, 8).join(' '),
    spoken.slice(6, 16).join(' '),
    spoken.slice(14, 24).join(' '),
  ];

  // A fresh engine per run: the ledger is keyed by item id and the scripter
  // reuses ids, so a reused engine would silently discard every replayed event
  // as a duplicate and measure nothing. Construction (which builds an O(n)
  // `DocumentIndex`, once per session by design) sits outside the timer.
  const run = (): number => {
    const engine = new AlignmentEngine(document, {
      sessionId: `cost-${targetTokens}`,
      sessionGeneration: 1,
      stageGeneration: 1,
    });
    const scripter = new TranscriptScripter(10_000, 1);
    const events = turns.flatMap((text) => [...scripter.speak({ text })]);
    const startedAt = performance.now();
    for (const event of events) engine.handleTranscriptEvent(event);
    const elapsed = performance.now() - startedAt;
    return elapsed / events.length;
  };

  run(); // warm up the JIT so the first measurement is not the slowest
  // Best of two: we care about the work performed, not about whatever else the
  // machine decided to do during one of the samples.
  return Math.min(run(), run());
}

describe('per-event alignment cost is flat in script length (§63)', () => {
  it('a 16× longer script does not cost meaningfully more per event', { timeout: 60_000 }, () => {
    const small = costPerEventMs(400);
    const large = costPerEventMs(6400);
    const ratio = large / Math.max(small, 1e-6);
    expect(
      ratio,
      `per-event cost ${small.toFixed(2)}ms @400 tokens vs ${large.toFixed(2)}ms @6400 tokens ` +
        `(${ratio.toFixed(1)}×) — cost is tracking script length again`,
    ).toBeLessThan(3);
  });

  it('the growth is not merely deferred to the middle of the range', { timeout: 60_000 }, () => {
    const small = costPerEventMs(400);
    const medium = costPerEventMs(1600);
    const large = costPerEventMs(6400);
    // Before the fix these steps were 2.1× and 2.6×; they are now ~1.2× and
    // below 1×, so 2.0 both fails on the regression and leaves real headroom.
    expect(medium / Math.max(small, 1e-6)).toBeLessThan(2);
    expect(large / Math.max(medium, 1e-6)).toBeLessThan(2);
  });
});
