/**
 * Listener clip scheduling (spec §40.2–40.3): a seeded shuffle bag over the
 * pack's neutral listening loops, plus transition timing so the playback
 * engine can crossfade inside the shared neutral boundary (§38.3).
 * Pure logic — no DOM, no media.
 */

export interface SchedulerClip {
  id: string;
  durationMs: number;
}

export interface ClipPlan {
  clipId: string;
  durationMs: number;
  /** Playback time at which the crossfade to the next clip should begin. */
  transitionAtMs: number;
  crossfadeMs: number;
}

/** Crossfade duration within the §40.1 recommended 120–220 ms window. */
export const DEFAULT_CROSSFADE_MS = 180;
/** Extra lead before clip end so the fade completes inside the neutral tail. */
export const TRANSITION_LEAD_MS = 260;

/** Deterministic PRNG — seeded per session for reproducible diagnostics. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** When the crossfade should start: inside the neutral end zone, never < 0. */
export function planTransitionAtMs(
  durationMs: number,
  crossfadeMs: number = DEFAULT_CROSSFADE_MS,
  leadMs: number = TRANSITION_LEAD_MS,
): number {
  return Math.max(0, durationMs - crossfadeMs - leadMs);
}

export interface ClipScheduler {
  /** Next clip to play. Returns null when the pack has no clips. */
  next(): ClipPlan | null;
  /** Clip ids drawn so far, oldest first (diagnostics/tests). */
  history(): readonly string[];
}

export interface ClipSchedulerOptions {
  seed?: number;
  crossfadeMs?: number;
  leadMs?: number;
}

/**
 * Shuffle bag: every eligible clip plays once before the bag refills, and the
 * first draw of a new bag never repeats the previous draw (no immediate
 * repeat across bag boundaries, §40.2). A single-clip pack simply loops.
 */
export function createClipScheduler(
  clips: readonly SchedulerClip[],
  options: ClipSchedulerOptions = {},
): ClipScheduler {
  const rng = mulberry32(options.seed ?? 1);
  const crossfadeMs = options.crossfadeMs ?? DEFAULT_CROSSFADE_MS;
  const leadMs = options.leadMs ?? TRANSITION_LEAD_MS;
  const pool = clips.filter((c) => c.durationMs > 0);
  let bag: SchedulerClip[] = [];
  let lastId: string | null = null;
  const drawn: string[] = [];

  const shuffle = (items: SchedulerClip[]): SchedulerClip[] => {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  };

  const refill = () => {
    bag = shuffle(pool);
    // No immediate repeat across the bag boundary (only possible with 2+ clips).
    if (pool.length > 1 && bag[0]!.id === lastId) {
      const swapWith = 1 + Math.floor(rng() * (bag.length - 1));
      const tmp = bag[0]!;
      bag[0] = bag[swapWith]!;
      bag[swapWith] = tmp;
    }
  };

  return {
    next(): ClipPlan | null {
      if (pool.length === 0) return null;
      if (bag.length === 0) refill();
      const clip = bag.shift()!;
      lastId = clip.id;
      drawn.push(clip.id);
      return {
        clipId: clip.id,
        durationMs: clip.durationMs,
        transitionAtMs: planTransitionAtMs(clip.durationMs, crossfadeMs, leadMs),
        crossfadeMs,
      };
    },
    history(): readonly string[] {
      return drawn;
    },
  };
}
