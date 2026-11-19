/**
 * How long the rolling script sat still, from one offset reading per frame
 * (issue #240). Pure, so the benchmark's stall rule is tested in node rather
 * than only in a packaged app.
 *
 * A still stretch is measured up to the frame where the script moves again,
 * not reset by it: the first version reset the clock on that frame before
 * measuring, so a one-second freeze that ended was never counted at all.
 */
export interface StillTracker {
  /** One frame's timestamp and the scroll offset it showed. */
  observe(now: number, offset: number | null): void;
  /** The longest time between two frames that showed different offsets. */
  readonly longestStillMs: number;
}

export function stillTracker(): StillTracker {
  let lastMovedAt: number | null = null;
  let lastOffset: number | null = null;
  let longest = 0;
  return {
    observe(now, offset) {
      if (lastMovedAt === null) {
        lastMovedAt = now;
        lastOffset = offset;
        return;
      }
      longest = Math.max(longest, now - lastMovedAt);
      if (offset !== lastOffset) {
        lastMovedAt = now;
        lastOffset = offset;
      }
    },
    get longestStillMs() {
      return longest;
    },
  };
}
