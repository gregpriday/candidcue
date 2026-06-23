import type { MediaClip, SpeakingMediaPlan, SpeakingMediaPlanSegment } from '@shared/domain';
import { MEDIA_DEFAULTS } from '@shared/constants/runtime-defaults';
import { mulberry32, seedFromString } from '@shared/utils';

/** Tuning options for {@link planSpeaking}; all fields fall back to MEDIA_DEFAULTS. */
export interface PlanSpeakingOptions {
  /** Slowest allowed playback rate (defaults to MEDIA_DEFAULTS.speakingPlaybackRateMin). */
  minRate?: number;
  /** Fastest allowed playback rate (defaults to MEDIA_DEFAULTS.speakingPlaybackRateMax). */
  maxRate?: number;
  /** Seed for deterministic tie-breaking; defaults to String(speechDurationMs). */
  seed?: string;
}

/** Recency weights applied when scoring how recently a clip was reused (spec §18.7). */
const PENALTY_USED_LAST_TURN = 50;
const PENALTY_USED_RECENTLY = 20;
/** Penalty for a rate that sits hard against a bound, which strains the calibration. */
const PENALTY_AT_BOUND = 15;
/** How close to a bound (in rate units) counts as "at the bound". */
const BOUND_EPSILON = 0.01;
/** Per-cut penalty added when a plan stitches multiple clips together (spec §18.8). */
const PENALTY_CUT = 25;

/**
 * Plan which SPEAKING clip(s) cover a stretch of synthesized speech (spec §18.7–18.9).
 *
 * Mira's speaking takes are pre-rendered, so the planner must fit a fixed-length
 * clip to a variable speech duration by nudging its playback rate within a narrow
 * band. The strategy degrades gracefully:
 *
 *  1. `single_match`  — one eligible clip whose required rate is in range; the
 *     clip whose rate sits closest to 1.0 (and was least recently used) wins.
 *  2. `pair_match`    — no single clip fits, so two distinct clips are stitched
 *     and share one rate derived from their combined native duration.
 *  3. `forced_cut`    — nothing fits cleanly, so the closest longer clip is
 *     clamped to the nearest allowed rate as a last resort.
 *  4. `poster_fallback` — no speaking clips exist at all; the caller shows a poster.
 *
 * Listening clips and disabled clips are never considered. Ties are broken with a
 * seeded PRNG so a given (speech duration, clip set, recency) input is reproducible.
 */
export function planSpeaking(
  speechDurationMs: number,
  clips: MediaClip[],
  recentClipIds: string[],
  opts: PlanSpeakingOptions = {},
): SpeakingMediaPlan {
  const minRate = opts.minRate ?? MEDIA_DEFAULTS.speakingPlaybackRateMin;
  const maxRate = opts.maxRate ?? MEDIA_DEFAULTS.speakingPlaybackRateMax;
  const rng = mulberry32(seedFromString(opts.seed ?? String(speechDurationMs)));

  const candidates = clips.filter((c) => c.enabled && c.mode === 'speaking');

  // No speaking material at all: the renderer falls back to a static poster.
  if (candidates.length === 0) {
    return {
      speechDurationMs,
      segments: [],
      selectionReason: 'poster_fallback',
      diagnosticScore: 0,
    };
  }

  // Guard against a zero/negative target which would make every rate infinite.
  const safeSpeechMs = speechDurationMs > 0 ? speechDurationMs : 1;

  const single = pickSingle(candidates, recentClipIds, safeSpeechMs, minRate, maxRate, rng);
  if (single) {
    return {
      speechDurationMs,
      segments: [makeSegment(single.clip, single.rate)],
      selectionReason: 'single_match',
      diagnosticScore: single.score,
    };
  }

  const pair = pickPair(candidates, recentClipIds, safeSpeechMs, minRate, maxRate, rng);
  if (pair) {
    return {
      speechDurationMs,
      segments: pair.clips.map((clip) => makeSegment(clip, pair.rate)),
      selectionReason: 'pair_match',
      diagnosticScore: pair.score,
    };
  }

  // Last resort: stretch the closest longer clip (or, failing that, the closest
  // clip overall) by clamping its required rate into the allowed band.
  const forced = pickForcedCut(candidates, safeSpeechMs, minRate, maxRate);
  return {
    speechDurationMs,
    segments: [makeSegment(forced.clip, forced.rate)],
    selectionReason: 'forced_cut',
    diagnosticScore: forced.score,
  };
}

interface SingleChoice {
  clip: MediaClip;
  rate: number;
  score: number;
}

/**
 * Choose the single best eligible clip, or `null` if none fits in [min, max].
 * Lower scores are better; equal scores are broken deterministically by the RNG.
 */
function pickSingle(
  candidates: MediaClip[],
  recentClipIds: string[],
  speechDurationMs: number,
  minRate: number,
  maxRate: number,
  rng: () => number,
): SingleChoice | null {
  let best: SingleChoice | null = null;
  let bestKey = Number.POSITIVE_INFINITY;

  for (const clip of candidates) {
    const rate = clip.durationMs / speechDurationMs;
    if (rate < minRate || rate > maxRate) {
      continue;
    }
    const score = scoreRate(rate, clip.id, recentClipIds, minRate, maxRate);
    const key = breakTie(score, rng);
    if (best === null || key < bestKey) {
      best = { clip, rate, score };
      bestKey = key;
    }
  }

  return best;
}

interface PairChoice {
  clips: [MediaClip, MediaClip];
  rate: number;
  score: number;
}

/**
 * Choose the best eligible pair of two distinct clips whose combined native
 * duration yields a shared playback rate inside [min, max], or `null` if none.
 *
 * Both clips play back-to-back at the same rate, so the rate that lands their
 * combined length on the target is `(a.durationMs + b.durationMs) / speechMs`.
 * A flat per-cut penalty discourages stitching when a single clip would do, and
 * recency penalties for either clip discourage visible reuse.
 */
function pickPair(
  candidates: MediaClip[],
  recentClipIds: string[],
  speechDurationMs: number,
  minRate: number,
  maxRate: number,
  rng: () => number,
): PairChoice | null {
  let best: PairChoice | null = null;
  let bestKey = Number.POSITIVE_INFINITY;

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i] as MediaClip;
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j] as MediaClip;
      const rate = (a.durationMs + b.durationMs) / speechDurationMs;
      if (rate < minRate || rate > maxRate) {
        continue;
      }
      const score =
        scoreRate(rate, a.id, recentClipIds, minRate, maxRate) +
        scoreRate(rate, b.id, recentClipIds, minRate, maxRate) +
        PENALTY_CUT;
      const key = breakTie(score, rng);
      if (best === null || key < bestKey) {
        best = { clips: [a, b], rate, score };
        bestKey = key;
      }
    }
  }

  return best;
}

/**
 * Final fallback: pick the clip closest to the target, preferring the closest
 * LONGER clip (which can be slowed into range) and otherwise the closest clip
 * overall, then clamp its required rate into [min, max].
 */
function pickForcedCut(
  candidates: MediaClip[],
  speechDurationMs: number,
  minRate: number,
  maxRate: number,
): SingleChoice {
  // Prefer the shortest clip that is still longer than (or equal to) the target,
  // since slowing a clip down reads better than speeding it up past the cap.
  let chosen: MediaClip | null = null;
  let chosenGap = Number.POSITIVE_INFINITY;
  for (const clip of candidates) {
    if (clip.durationMs >= speechDurationMs) {
      const gap = clip.durationMs - speechDurationMs;
      if (gap < chosenGap) {
        chosen = clip;
        chosenGap = gap;
      }
    }
  }

  // No clip is long enough: fall back to whichever clip is nearest the target.
  if (chosen === null) {
    let nearestGap = Number.POSITIVE_INFINITY;
    for (const clip of candidates) {
      const gap = Math.abs(clip.durationMs - speechDurationMs);
      if (gap < nearestGap) {
        chosen = clip;
        nearestGap = gap;
      }
    }
  }

  const clip = chosen as MediaClip;
  const requiredRate = clip.durationMs / speechDurationMs;
  const rate = clamp(requiredRate, minRate, maxRate);
  const score = scoreRate(rate, clip.id, [], minRate, maxRate);
  return { clip, rate, score };
}

/**
 * Score a candidate rate (lower is better). Combines distance from the ideal
 * 1.0 rate (log space, so 0.9 and 1.11 weigh the same), recency penalties, and
 * a penalty for sitting hard against a rate bound (spec §18.7).
 */
function scoreRate(
  rate: number,
  clipId: string,
  recentClipIds: string[],
  minRate: number,
  maxRate: number,
): number {
  let score = Math.abs(Math.log(rate)) * 100;
  if (recentClipIds[0] === clipId) {
    score += PENALTY_USED_LAST_TURN;
  }
  if (recentClipIds.slice(0, 3).includes(clipId)) {
    score += PENALTY_USED_RECENTLY;
  }
  if (Math.abs(rate - minRate) < BOUND_EPSILON || Math.abs(rate - maxRate) < BOUND_EPSILON) {
    score += PENALTY_AT_BOUND;
  }
  return score;
}

/**
 * Fold a tiny deterministic jitter into a score so equal scores resolve to a
 * stable, reproducible order for the given seed. The jitter (< 1e-6) is far
 * smaller than any real score difference, so it only ever decides exact ties.
 */
function breakTie(score: number, rng: () => number): number {
  return score + rng() * 1e-6;
}

/** Build a playback segment for `clip` at `rate`, computing its expected length. */
function makeSegment(clip: MediaClip, rate: number): SpeakingMediaPlanSegment {
  return {
    clipId: clip.id,
    relativePath: clip.relativePath,
    playbackRate: rate,
    expectedPlaybackDurationMs: clip.durationMs / rate,
  };
}

/** Constrain `value` to the inclusive range [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
