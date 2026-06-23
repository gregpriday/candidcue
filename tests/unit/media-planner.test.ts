import type { MediaClip } from '@shared/domain';
import { MEDIA_DEFAULTS } from '@shared/constants/runtime-defaults';
import { planSpeaking } from '@main/media/media-planner';

const MIN = MEDIA_DEFAULTS.speakingPlaybackRateMin; // 0.92
const MAX = MEDIA_DEFAULTS.speakingPlaybackRateMax; // 1.08

/** Build a fully-typed MediaClip with sensible defaults; override as needed. */
function clip(overrides: Partial<MediaClip> & { id: string; durationMs: number }): MediaClip {
  return {
    relativePath: `clips/${overrides.id}.mp4`,
    mode: 'speaking',
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    container: 'mp4',
    hasAudio: false,
    fileSizeBytes: 1_000_000,
    sha256: 'a'.repeat(64),
    enabled: true,
    tags: [],
    ...overrides,
  };
}

describe('planSpeaking', () => {
  it('returns poster_fallback with no segments when there are zero speaking clips', () => {
    const onlyListening = [clip({ id: 'l1', durationMs: 5000, mode: 'listening' })];
    const plan = planSpeaking(5000, onlyListening, []);
    expect(plan.selectionReason).toBe('poster_fallback');
    expect(plan.segments).toEqual([]);
    expect(plan.speechDurationMs).toBe(5000);
  });

  it('returns poster_fallback when an empty clip list is supplied', () => {
    const plan = planSpeaking(5000, [], []);
    expect(plan.selectionReason).toBe('poster_fallback');
    expect(plan.segments).toEqual([]);
  });

  it('picks an exact-duration clip at rate ~1 with single_match', () => {
    const clips = [clip({ id: 'a', durationMs: 5000 })];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('single_match');
    expect(plan.segments).toHaveLength(1);
    const seg = plan.segments[0]!;
    expect(seg.clipId).toBe('a');
    expect(seg.relativePath).toBe('clips/a.mp4');
    expect(seg.playbackRate).toBeCloseTo(1, 6);
    // expectedPlaybackDurationMs = durationMs / rate ~= speechDurationMs
    expect(seg.expectedPlaybackDurationMs).toBeCloseTo(5000, 3);
  });

  it('computes requiredPlaybackRate = durationMs / speechDurationMs within bounds', () => {
    // 5400 / 5000 = 1.08 (exactly at MAX, still eligible)
    const clips = [clip({ id: 'fast', durationMs: 5400 })];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('single_match');
    expect(plan.segments[0]!.playbackRate).toBeCloseTo(MAX, 6);
    expect(plan.segments[0]!.playbackRate).toBeLessThanOrEqual(MAX);
    expect(plan.segments[0]!.playbackRate).toBeGreaterThanOrEqual(MIN);
  });

  it('treats a clip just outside the rate band as ineligible for single_match', () => {
    // 5500 / 5000 = 1.10 > MAX -> not eligible as a single, so not single_match.
    const clips = [clip({ id: 'tooFast', durationMs: 5500 })];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).not.toBe('single_match');
    // With only one clip and no eligible pair, it falls back to a forced cut.
    expect(plan.selectionReason).toBe('forced_cut');
  });

  it('never selects a disabled clip', () => {
    const clips = [
      clip({ id: 'disabled', durationMs: 5000, enabled: false }),
      clip({ id: 'enabled', durationMs: 5000, enabled: true }),
    ];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.segments.map((s) => s.clipId)).not.toContain('disabled');
    expect(plan.segments[0]!.clipId).toBe('enabled');
  });

  it('never selects a listening clip even if its duration would fit', () => {
    const clips = [
      clip({ id: 'listen', durationMs: 5000, mode: 'listening' }),
      clip({ id: 'speak', durationMs: 5000, mode: 'speaking' }),
    ];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.segments.map((s) => s.clipId)).not.toContain('listen');
    expect(plan.segments[0]!.clipId).toBe('speak');
  });

  it('ignores disabled and listening clips entirely when all speaking clips are unusable', () => {
    // Only a disabled speaking clip and an (eligible-duration) listening clip exist.
    const clips = [
      clip({ id: 'd', durationMs: 5000, enabled: false }),
      clip({ id: 'l', durationMs: 5000, mode: 'listening' }),
    ];
    const plan = planSpeaking(5000, clips, []);
    // No enabled speaking clips -> poster fallback.
    expect(plan.selectionReason).toBe('poster_fallback');
    expect(plan.segments).toEqual([]);
  });

  it('penalizes a clip used last turn so a tied alternative wins', () => {
    // Two clips with identical durations -> identical base rate score. The one
    // used last turn (recentClipIds[0]) carries a recency penalty, so the other
    // must be chosen despite the otherwise-tied scores.
    const clips = [
      clip({ id: 'recent', durationMs: 5000 }),
      clip({ id: 'fresh', durationMs: 5000 }),
    ];
    const plan = planSpeaking(5000, clips, ['recent']);
    expect(plan.selectionReason).toBe('single_match');
    expect(plan.segments[0]!.clipId).toBe('fresh');
  });

  it('applies the recent-window penalty (slice 0..3) as well as the last-turn penalty', () => {
    // 'a' is two turns back (in recent window but not last turn); 'b' is fresh.
    const clips = [
      clip({ id: 'a', durationMs: 5000 }),
      clip({ id: 'b', durationMs: 5000 }),
    ];
    const plan = planSpeaking(5000, clips, ['x', 'a']);
    expect(plan.segments[0]!.clipId).toBe('b');
  });

  it('produces a pair_match when no single clip is eligible but two combine into range', () => {
    // Each clip alone is far too short (rate ~0.5), so neither is eligible single.
    // Combined: (2600 + 2600) / 5000 = 1.04 -> within [0.92, 1.08].
    const clips = [
      clip({ id: 'p1', durationMs: 2600 }),
      clip({ id: 'p2', durationMs: 2600 }),
    ];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('pair_match');
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments.map((s) => s.clipId).sort()).toEqual(['p1', 'p2']);
    // Both segments share the same combined playback rate.
    expect(plan.segments[0]!.playbackRate).toBeCloseTo(plan.segments[1]!.playbackRate, 9);
    expect(plan.segments[0]!.playbackRate).toBeCloseTo(5200 / 5000, 6);
  });

  it('uses two distinct clips for a pair_match (never the same clip twice)', () => {
    const clips = [
      clip({ id: 'p1', durationMs: 2600 }),
      clip({ id: 'p2', durationMs: 2700 }),
    ];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('pair_match');
    const ids = plan.segments.map((s) => s.clipId);
    expect(new Set(ids).size).toBe(2);
  });

  it('prefers a single_match over a pair_match when a single clip is eligible', () => {
    const clips = [
      clip({ id: 'single', durationMs: 5000 }), // rate 1.0, eligible alone
      clip({ id: 'half', durationMs: 2500 }),
      clip({ id: 'half2', durationMs: 2500 }),
    ];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('single_match');
    expect(plan.segments[0]!.clipId).toBe('single');
  });

  it('falls back to forced_cut only as a last resort, clamping into the rate band', () => {
    // One clip far too long, no second clip to pair with -> forced cut.
    const clips = [clip({ id: 'long', durationMs: 9000 })];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('forced_cut');
    expect(plan.segments).toHaveLength(1);
    const rate = plan.segments[0]!.playbackRate;
    expect(rate).toBeGreaterThanOrEqual(MIN);
    expect(rate).toBeLessThanOrEqual(MAX);
    // Required rate 9000/5000 = 1.8 -> clamped to MAX.
    expect(rate).toBeCloseTo(MAX, 6);
  });

  it('forced_cut prefers the closest LONGER clip over a shorter one', () => {
    // Neither fits a single band nor a pair; the longer clip should be chosen
    // so it can be slowed (rather than over-speeding a short clip).
    const clips = [
      clip({ id: 'short', durationMs: 1000 }),
      clip({ id: 'long', durationMs: 9000 }),
    ];
    // 1000+9000 = 10000 / 5000 = 2.0 -> pair not in range either.
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('forced_cut');
    expect(plan.segments[0]!.clipId).toBe('long');
  });

  it('very short target speech picks the closest available clip', () => {
    // Target is tiny; every clip is far too long. The closest (shortest longer)
    // clip is chosen and clamped to MAX.
    const clips = [
      clip({ id: 'big', durationMs: 8000 }),
      clip({ id: 'closest', durationMs: 4000 }),
    ];
    const plan = planSpeaking(100, clips, []);
    expect(plan.selectionReason).toBe('forced_cut');
    expect(plan.segments[0]!.clipId).toBe('closest');
    expect(plan.segments[0]!.playbackRate).toBeCloseTo(MAX, 6);
  });

  it('expectedPlaybackDurationMs equals durationMs / playbackRate for each segment', () => {
    const clips = [clip({ id: 'a', durationMs: 5200 })];
    const plan = planSpeaking(5000, clips, []);
    const seg = plan.segments[0]!;
    expect(seg.expectedPlaybackDurationMs).toBeCloseTo(5200 / seg.playbackRate, 6);
  });

  it('respects custom minRate / maxRate options', () => {
    // 5500/5000 = 1.10. Default MAX 1.08 rejects it, but a custom max 1.15 admits it.
    const clips = [clip({ id: 'fast', durationMs: 5500 })];
    const tight = planSpeaking(5000, clips, []);
    expect(tight.selectionReason).toBe('forced_cut');

    const loose = planSpeaking(5000, clips, [], { minRate: 0.85, maxRate: 1.15 });
    expect(loose.selectionReason).toBe('single_match');
    expect(loose.segments[0]!.playbackRate).toBeCloseTo(1.1, 6);
  });

  it('is deterministic: same seed + inputs produce a deep-equal plan', () => {
    // Several equal-duration clips force ties resolved by the seeded RNG.
    const clips = [
      clip({ id: 'a', durationMs: 5000 }),
      clip({ id: 'b', durationMs: 5000 }),
      clip({ id: 'c', durationMs: 5000 }),
      clip({ id: 'd', durationMs: 5000 }),
    ];
    const first = planSpeaking(5000, clips, [], { seed: 'fixed-seed' });
    const second = planSpeaking(5000, clips, [], { seed: 'fixed-seed' });
    expect(second).toEqual(first);
  });

  it('is deterministic across many ties even without an explicit seed', () => {
    const clips = [
      clip({ id: 'a', durationMs: 4900 }),
      clip({ id: 'b', durationMs: 4900 }),
      clip({ id: 'c', durationMs: 4900 }),
    ];
    const a = planSpeaking(5000, clips, []);
    const b = planSpeaking(5000, clips, []);
    expect(b).toEqual(a);
  });

  it('different seeds can resolve a tie to different clips', () => {
    const clips = [
      clip({ id: 'a', durationMs: 5000 }),
      clip({ id: 'b', durationMs: 5000 }),
      clip({ id: 'c', durationMs: 5000 }),
      clip({ id: 'd', durationMs: 5000 }),
    ];
    const seeds = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'];
    const picked = new Set(
      seeds.map((seed) => planSpeaking(5000, clips, [], { seed }).segments[0]!.clipId),
    );
    // The tie-break must actually depend on the seed for at least some inputs.
    expect(picked.size).toBeGreaterThan(1);
  });

  it('prefers the rate nearest 1.0 among multiple eligible singles', () => {
    // 4800/5000 = 0.96, 5000/5000 = 1.00, 5200/5000 = 1.04. The 1.00 clip wins.
    const clips = [
      clip({ id: 'slow', durationMs: 4800 }),
      clip({ id: 'ideal', durationMs: 5000 }),
      clip({ id: 'fast', durationMs: 5200 }),
    ];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('single_match');
    expect(plan.segments[0]!.clipId).toBe('ideal');
  });

  it('penalizes a rate sitting at a bound versus an interior rate', () => {
    // 'edge' sits exactly at MAX (rate 1.08) -> bound penalty; 'mid' at 1.00.
    const clips = [
      clip({ id: 'edge', durationMs: 5400 }),
      clip({ id: 'mid', durationMs: 5000 }),
    ];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.segments[0]!.clipId).toBe('mid');
  });

  it('includes diagnosticScore reflecting the chosen plan', () => {
    const clips = [clip({ id: 'a', durationMs: 5000 })];
    const plan = planSpeaking(5000, clips, []);
    // Rate is exactly 1.0 -> log(1)=0, no recency, not at a bound -> score 0.
    expect(plan.diagnosticScore).toBeCloseTo(0, 6);
    expect(plan.diagnosticScore).toBeGreaterThanOrEqual(0);
  });

  it('pair_match diagnosticScore includes the per-cut penalty (>= single ideal)', () => {
    const clips = [
      clip({ id: 'p1', durationMs: 2500 }),
      clip({ id: 'p2', durationMs: 2500 }),
    ];
    const plan = planSpeaking(5000, clips, []);
    expect(plan.selectionReason).toBe('pair_match');
    // Two ideal-rate clips contribute ~0 each plus a cut penalty of 25.
    expect(plan.diagnosticScore).toBeGreaterThanOrEqual(25);
  });
});
