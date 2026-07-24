/**
 * Continuous estimation: semantic filter + pace estimator
 * (companion §19.2, §24, §25, App. B.3).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts/smooth-follow';
import { PaceEstimatorV2 } from '../../../src/shared/tracking/pace-estimator';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { SemanticFilter } from '../../../src/shared/tracking/semantic-filter';
import { SpeechUnitScale } from '../../../src/shared/tracking/speech-units';
import { demoDocument } from '../../fixtures/alignment/fixture-script';

const profile = DEFAULT_TRACKING_PROFILE;
const smooth = DEFAULT_SMOOTH_FOLLOW_PROFILE;
const COAST_BUDGET_UNITS = smooth.prediction.maxCoastUnits * profile.unitsPerRenderedLine;

function newFilter(): SemanticFilter {
  return new SemanticFilter(profile, smooth);
}

/** Drive a confident, evenly paced read so the filter acquires a velocity. */
function establishFollowing(filter: SemanticFilter, startMs = 0): number {
  filter.setState('following');
  let atMs = startMs;
  for (let i = 0; i < 8; i++) {
    filter.observe({
      positionUnits: i * 2.5,
      confidence: 0.9,
      margin: 0.4,
      beamVariance: 0.5,
      finalEvidence: true,
      atMs,
    });
    atMs += 1000;
  }
  return atMs;
}

describe('SpeechUnitScale (companion §6)', () => {
  const units = new SpeechUnitScale(demoDocument(), profile);

  it('is monotone non-decreasing and starts at zero', () => {
    expect(units.unitAt(0)).toBe(0);
    let previous = -1;
    for (let i = 0; i < 147; i++) {
      const value = units.unitAt(i);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(Number.isFinite(value)).toBe(true);
      previous = value;
    }
  });

  it('round-trips tokens through units', () => {
    for (const tokenIndex of [0, 7, 26, 61, 62, 106, 146]) {
      expect(units.tokenIndexAt(units.unitAt(tokenIndex))).toBe(tokenIndex);
    }
  });

  it('weights long words above ordinary words above function words (§6.1)', () => {
    const document = demoDocument();
    const find = (word: string): number =>
      document.spokenTokens.findIndex((t) => t.normalized === word);
    const short = units.weightAt(find('the'));
    const ordinary = units.weightAt(find('watch'));
    const long = units.weightAt(find('kaleidoscope'));
    expect(short).toBeLessThan(ordinary);
    expect(ordinary).toBeLessThan(long);
  });

  it('adds a virtual pause at sentence and block boundaries (§6.2)', () => {
    // "channel" ends the first sentence, so its unit span exceeds a plain word.
    const document = demoDocument();
    const channel = document.spokenTokens.findIndex((t) => t.normalized === 'channel');
    expect(units.weightAt(channel)).toBeGreaterThan(profile.unitNormalWeight);
  });
});

describe('SemanticFilter (companion §24)', () => {
  it('predicts continuously between measurements (§3.1)', () => {
    const filter = newFilter();
    const atMs = establishFollowing(filter);
    const a = filter.predict(atMs + 100).positionUnits;
    const b = filter.predict(atMs + 300).positionUnits;
    expect(b).toBeGreaterThan(a); // motion continues without new evidence
    expect(filter.estimate().velocityUnitsPerSecond).toBeGreaterThan(0);
  });

  it('ad-lib drift is bounded and then holds (§19.2, §85)', () => {
    const filter = newFilter();
    const atMs = establishFollowing(filter);
    const anchor = filter.estimate().positionUnits;

    // No further evidence — the coast → decelerate → hold schedule runs.
    filter.setState('adlib_hold');
    let last = anchor;
    for (let t = 20; t <= 6000; t += 20) {
      const estimate = filter.predict(atMs + t);
      expect(Number.isFinite(estimate.positionUnits)).toBe(true);
      // §19.2 step 4 / §24.2.1: a hard runaway limit under one rendered line.
      expect(estimate.positionUnits - anchor).toBeLessThanOrEqual(COAST_BUDGET_UNITS + 1e-6);
      expect(estimate.positionUnits).toBeGreaterThanOrEqual(last - 1e-9); // never reverses
      last = estimate.positionUnits;
    }
    // §19.2 step 3: settled by ~1.1 s after loss of credible progress.
    expect(filter.estimate().velocityUnitsPerSecond).toBeLessThan(0.05);
  });

  it('does not extrapolate while paused or reconnecting (§17.11)', () => {
    const filter = newFilter();
    const atMs = establishFollowing(filter);
    const before = filter.predict(atMs).positionUnits;
    filter.setState('paused');
    expect(filter.predict(atMs + 5000).positionUnits).toBeCloseTo(before, 9);
    filter.setState('reconnecting');
    expect(filter.predict(atMs + 9000).positionUnits).toBeCloseTo(before, 9);
  });

  it('never acquires negative velocity outside a committed rewind (§24.2.1)', () => {
    const filter = newFilter();
    const atMs = establishFollowing(filter);
    filter.setState('retake_pending');
    filter.observe({
      positionUnits: 0,
      confidence: 0.9,
      margin: 0.5,
      beamVariance: 0.1,
      finalEvidence: true,
      atMs: atMs + 100,
    });
    expect(filter.estimate().velocityUnitsPerSecond).toBeGreaterThanOrEqual(0);
  });

  it('clamps innovation so one wrong measurement cannot teleport the estimate (§24.2)', () => {
    const filter = newFilter();
    const atMs = establishFollowing(filter);
    const before = filter.predict(atMs).positionUnits;
    filter.setState('following');
    filter.observe({
      positionUnits: before + 5000,
      confidence: 1,
      margin: 1,
      beamVariance: 0,
      finalEvidence: true,
      atMs: atMs + 50,
    });
    expect(filter.estimate().positionUnits - before).toBeLessThanOrEqual(
      profile.filterInnovationClampUnits + 1e-6,
    );
  });

  it('trusts final evidence more than provisional evidence (§24.2.1 R)', () => {
    const jump = 6;
    const move = (finalEvidence: boolean): number => {
      const filter = newFilter();
      const atMs = establishFollowing(filter);
      const before = filter.predict(atMs).positionUnits;
      filter.setState('following');
      filter.observe({
        positionUnits: before + jump,
        confidence: 0.85,
        margin: 0.4,
        beamVariance: 0.2,
        finalEvidence,
        atMs: atMs + 50,
      });
      return filter.estimate().positionUnits - before;
    };
    expect(move(true)).toBeGreaterThan(move(false));
  });

  it('resets hard around an authoritative destination (§24.2, §56.1)', () => {
    const filter = newFilter();
    const atMs = establishFollowing(filter);
    filter.resetTo(500, atMs + 10, 4, 'following');
    const estimate = filter.estimate();
    expect(estimate.positionUnits).toBe(500);
    expect(estimate.velocityUnitsPerSecond).toBe(0);
    expect(estimate.epoch).toBe(4);
  });

  it('cannot drift past a prohibited section boundary (§24.2.1)', () => {
    const filter = newFilter();
    const atMs = establishFollowing(filter);
    const ceiling = filter.estimate().positionUnits + 1;
    filter.setSectionBounds(0, ceiling);
    for (let t = 20; t <= 2000; t += 20) {
      expect(filter.predict(atMs + t).positionUnits).toBeLessThanOrEqual(ceiling + 1e-6);
    }
  });

  it('lead compensation is bounded and never negative (§24.7)', () => {
    const filter = newFilter();
    establishFollowing(filter);
    expect(filter.leadUnits(1)).toBeGreaterThanOrEqual(filter.leadUnits(0));
    expect(filter.leadUnits(1)).toBeLessThanOrEqual(COAST_BUDGET_UNITS + 1e-9);
    expect(filter.leadUnits(0)).toBeGreaterThanOrEqual(0);
  });
});

describe('PaceEstimatorV2 (companion §24.4–§24.5)', () => {
  const sample = (units: number, atMs: number, durationMs = 1000, quality = 1) => ({
    units,
    durationMs,
    atMs,
    quality,
  });

  it('maintains separate short and baseline windows (§24.5)', () => {
    const pace = new PaceEstimatorV2(profile);
    // 20 s of steady 2 units/s, then 3 s of fast 5 units/s.
    for (let t = 0; t < 20_000; t += 1000) pace.observe(sample(2, t));
    for (let t = 20_000; t < 23_000; t += 1000) pace.observe(sample(5, t));
    const estimate = pace.estimate(23_000);
    expect(estimate.shortTermUnitsPerSecond).toBeGreaterThan(estimate.baselineUnitsPerSecond);
    // The baseline damps the swing: the blend sits between the two.
    expect(estimate.blendedUnitsPerSecond).toBeLessThan(estimate.shortTermUnitsPerSecond);
    expect(estimate.blendedUnitsPerSecond).toBeGreaterThan(estimate.baselineUnitsPerSecond);
  });

  it('rejects contaminated spans rather than absorbing them (§24.4)', () => {
    const pace = new PaceEstimatorV2(profile);
    for (let t = 0; t < 10_000; t += 1000) pace.observe(sample(2, t));
    const clean = pace.estimate(10_000).baselineUnitsPerSecond;
    expect(pace.observe(sample(7, 11_000), ['skip'])).toBe('skip');
    expect(pace.observe(sample(7, 12_000), ['retake'])).toBe('retake');
    expect(pace.observe(sample(7, 13_000), ['command_speech'])).toBe('command_speech');
    expect(pace.estimate(13_000).baselineUnitsPerSecond).toBeCloseTo(clean, 6);
  });

  it('rejects implausible rates and silence (§24.4)', () => {
    const pace = new PaceEstimatorV2(profile);
    expect(pace.observe(sample(500, 1000))).toBe('implausible_rate');
    expect(pace.observe(sample(0, 1000))).toBe('silence');
    expect(pace.observe(sample(2, 1000, 0))).toBe('silence');
    expect(pace.observe(sample(Number.NaN, 1000))).toBe('implausible_rate');
  });

  it('is median-based, so one outlier cannot swing the rate (§24.4)', () => {
    const pace = new PaceEstimatorV2(profile);
    for (let t = 0; t < 12_000; t += 1000) pace.observe(sample(2, t));
    const before = pace.estimate(12_000).baselineUnitsPerSecond;
    pace.observe(sample(7.9, 13_000));
    const after = pace.estimate(13_000).baselineUnitsPerSecond;
    expect(Math.abs(after - before)).toBeLessThan(0.4);
  });

  it('holds the previous estimate until there is enough evidence (§24.5)', () => {
    const pace = new PaceEstimatorV2(profile);
    expect(pace.estimate(0).blendedUnitsPerSecond).toBe(0);
    pace.observe(sample(2, 1000));
    expect(pace.estimate(1000).blendedUnitsPerSecond).toBe(0); // one sample is not a rate
  });

  it('reset clears everything (session restart, epoch change)', () => {
    const pace = new PaceEstimatorV2(profile);
    for (let t = 0; t < 6000; t += 1000) pace.observe(sample(3, t));
    expect(pace.estimate(6000).blendedUnitsPerSecond).toBeGreaterThan(0);
    pace.reset();
    expect(pace.estimate(6000).blendedUnitsPerSecond).toBe(0);
  });
});
