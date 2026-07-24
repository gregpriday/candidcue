/**
 * Recently visited span ring buffer (§14.4, §21.1).
 *
 * §14.4 lists this among the indexes a compiled session must maintain, and
 * §21.1 lists "the destination was visited recently" among the positive retake
 * evidence features. Neither existed. The engine approximated the feature with
 * `previouslyPassed = startPosition <= committedTokenIndex`, which is true of
 * *everything behind the cursor* — the opening paragraph of a forty-minute talk
 * scores the same as the sentence the presenter finished four seconds ago — and
 * with `matchesPreviouslyReadOpening`, which needs two of the destination's
 * leading content words to survive the transcriber intact.
 *
 * What this adds is the missing axis: recency. A destination is *visited* when
 * the committed cursor actually travelled through it, and *recent* when that
 * happened within the configured interval.
 *
 * ## Bounds
 *
 * The buffer is a fixed-capacity ring, so both memory and lookup cost are
 * functions of the profile and never of script length (§63). Consecutive
 * commits coalesce into one growing span, which is what makes a small capacity
 * enough: reading a paragraph straight through is one visit, not eighty.
 *
 * The recency bound is deliberately expressed in *milliseconds* rather than in
 * tokens. Every token constant in this engine needed `scales.ts` clamping
 * because "forty tokens" means something different in a keynote chapter and a
 * forty-word social clip; "the last thirty seconds" means the same thing in
 * both, because it is a property of the presenter rather than of the script.
 */

export interface VisitedSpan {
  startTokenIndex: number;
  endTokenIndex: number;
  /** Worker clock time the span was last extended. */
  atMs: number;
}

export class VisitedSpanRing {
  private readonly capacity: number;
  private spans: VisitedSpan[] = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /**
   * Record that the cursor travelled from `fromTokenIndex` to `toTokenIndex`.
   *
   * A move that touches or overlaps the newest span extends it; anything else
   * opens a new one. Backward moves are recorded exactly like forward moves —
   * a retake destination becomes visited by being read, which is what makes a
   * *second* restart of the same sentence detectable.
   */
  record(fromTokenIndex: number, toTokenIndex: number, atMs: number): void {
    const start = Math.min(fromTokenIndex, toTokenIndex);
    const end = Math.max(fromTokenIndex, toTokenIndex);
    const newest = this.spans[this.spans.length - 1];
    if (newest !== undefined && start <= newest.endTokenIndex + 1 && end >= newest.startTokenIndex - 1) {
      newest.startTokenIndex = Math.min(newest.startTokenIndex, start);
      newest.endTokenIndex = Math.max(newest.endTokenIndex, end);
      newest.atMs = atMs;
      return;
    }
    this.spans.push({ startTokenIndex: start, endTokenIndex: end, atMs });
    if (this.spans.length > this.capacity) this.spans.shift();
  }

  /**
   * §21.1: was `tokenIndex` inside a span the cursor occupied within the last
   * `withinMs`? Returns false for a position the cursor has never held, however
   * far behind the cursor it sits.
   */
  visitedRecently(tokenIndex: number, nowMs: number, withinMs: number): boolean {
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const span = this.spans[i];
      if (span === undefined) continue;
      if (nowMs - span.atMs > withinMs) continue;
      if (tokenIndex >= span.startTokenIndex && tokenIndex <= span.endTokenIndex) return true;
    }
    return false;
  }

  /** Newest first; for diagnostics and tests. */
  recent(): readonly VisitedSpan[] {
    return [...this.spans].reverse();
  }

  clear(): void {
    this.spans = [];
  }
}
