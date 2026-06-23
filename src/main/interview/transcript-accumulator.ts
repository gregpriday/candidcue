/**
 * Streaming transcript accumulator (spec §13.5).
 *
 * Collects a stream of speech-to-text output into two parts:
 *  - an immutable list of finalized segments, and
 *  - a single, replaceable interim segment representing the in-flight phrase.
 *
 * Final segments never change once added, so display text and any committed
 * answer stay stable while the interim region is revised in place. Re-adding the
 * exact same final segment (which can happen when a transport reconnects and
 * replays its last result) is treated as a no-op for safety.
 */
export class TranscriptAccumulator {
  /** Finalized, immutable transcript segments in arrival order. */
  private readonly segments: string[] = [];
  /** The current in-flight phrase; empty string means "no interim". */
  private interim = '';

  /**
   * Append a finalized segment. Empty/whitespace-only text is ignored. If the
   * trimmed text is identical to the immediately previous final segment it is
   * dropped to guard against reconnect replays.
   */
  addFinalSegment(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const last = this.segments[this.segments.length - 1];
    if (last === trimmed) return;
    this.segments.push(trimmed);
  }

  /** Replace the current interim segment (revisions replace, never accumulate). */
  setInterim(text: string): void {
    this.interim = text.trim();
  }

  /** Finalized segments joined by a space, plus the interim phrase if present. */
  get displayText(): string {
    const parts = this.interim.length > 0 ? [...this.segments, this.interim] : this.segments;
    return parts.join(' ');
  }

  /** Read-only view of the finalized segments. */
  get finalSegments(): readonly string[] {
    return this.segments;
  }

  /**
   * Return the finalized transcript (segments joined and trimmed) and discard
   * the pending interim phrase. Finalized segments are left intact.
   */
  commit(): string {
    this.interim = '';
    return this.segments.join(' ').trim();
  }

  /** Clear all finalized segments and any interim phrase. */
  reset(): void {
    this.segments.length = 0;
    this.interim = '';
  }
}
