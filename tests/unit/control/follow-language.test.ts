import { describe, expect, it } from 'vitest';
import type { TrackingBehavior, TrackingStateV2 } from '../../../src/shared/contracts';
import {
  CONFIDENCE_BANDS,
  CONFIDENCE_BAND_LABELS,
  FOLLOW_BEHAVIOR_LABELS,
  FOLLOW_NOTICE_COPY,
  FOLLOW_STATE_DETAIL,
  FOLLOW_STATE_LABELS,
  budgetNoticeCopy,
  confidenceBand,
  confidenceBandIndex,
  describeMovement,
  followStateTone,
  formatPace,
  formatScore,
  formatSessionTime,
  lunaUnavailableCopy,
  type MovementDecisionRecord,
} from '../../../src/control/lib/follow-language';

const ALL_STATES: TrackingStateV2[] = [
  'acquiring',
  'following',
  'coasting',
  'uncertain',
  'adlib_hold',
  'catching_up',
  'retake_pending',
  'rewinding',
  'reanchoring',
  'command_pending',
  'paused',
  'reconnecting',
  'lost_local',
];

const ALL_BEHAVIORS: TrackingBehavior[] = [
  'acquire',
  'normal',
  'minor_variation',
  'paraphrase',
  'adlib',
  'return',
  'small_skip',
  'large_skip',
  'retake_candidate',
  'retake',
  'manual_navigation',
  'command_navigation',
  'lost',
];

function record(patch: Partial<MovementDecisionRecord> = {}): MovementDecisionRecord {
  return {
    revision: 12,
    sessionTimeMs: 65_400,
    fromUnit: 100,
    toUnit: 104.5,
    behavior: 'small_skip',
    stateBefore: 'following',
    stateAfter: 'catching_up',
    localConfidence: 0.71,
    secondBestMargin: 0.18,
    sectionGate: 'allowed',
    authority: 'ordinary',
    visualDisposition: 'catch_up',
    ...patch,
  };
}

describe('follow language (§48, §49)', () => {
  it('has a plain-language label and tone for every tracking state', () => {
    for (const state of ALL_STATES) {
      expect(FOLLOW_STATE_LABELS[state]).toBeTruthy();
      expect(FOLLOW_STATE_DETAIL).toHaveProperty(state);
      expect(followStateTone(state)).toBeTruthy();
    }
  });

  it('never labels a state with a raw enum value', () => {
    for (const state of ALL_STATES) {
      expect(FOLLOW_STATE_LABELS[state]).not.toContain('_');
    }
  });

  it('has a label for every tracking behavior', () => {
    for (const behavior of ALL_BEHAVIORS) {
      expect(FOLLOW_BEHAVIOR_LABELS[behavior]).toBeTruthy();
    }
  });

  it('reuses the F.11 wording for held and reconnecting states', () => {
    expect(FOLLOW_STATE_LABELS.reconnecting).toBe('Reconnecting — position held');
    expect(FOLLOW_STATE_LABELS.lost_local).toBe('Looking for your place');
    expect(FOLLOW_STATE_LABELS.paused).toContain('CandidCue, resume');
  });
});

describe('confidence presentation (§48 — no false precision)', () => {
  it('bands confidence coarsely and reports "unknown" without a reading', () => {
    expect(confidenceBand(null)).toBe('unknown');
    expect(confidenceBand(undefined)).toBe('unknown');
    expect(confidenceBand(Number.NaN)).toBe('unknown');
    expect(confidenceBand(0.95)).toBe('strong');
    expect(confidenceBand(0.8)).toBe('strong');
    expect(confidenceBand(0.79)).toBe('steady');
    expect(confidenceBand(0.6)).toBe('steady');
    expect(confidenceBand(0.59)).toBe('unsure');
    expect(confidenceBand(0.35)).toBe('unsure');
    expect(confidenceBand(0.34)).toBe('low');
    expect(confidenceBand(0)).toBe('low');
  });

  it('never renders confidence as a percentage', () => {
    for (const band of CONFIDENCE_BANDS) {
      expect(CONFIDENCE_BAND_LABELS[band]).not.toMatch(/%|\d/);
    }
    expect(CONFIDENCE_BAND_LABELS.unknown).not.toMatch(/%|\d/);
  });

  it('maps bands onto meter positions, with -1 for unknown', () => {
    expect(confidenceBandIndex('unknown')).toBe(-1);
    expect(confidenceBandIndex('low')).toBe(0);
    expect(confidenceBandIndex('strong')).toBe(CONFIDENCE_BANDS.length - 1);
  });

  it('hedges the pace estimate and admits when there is none', () => {
    expect(formatPace(null)).toBe('Pace not established yet');
    expect(formatPace(0)).toBe('Pace not established yet');
    expect(formatPace(142)).toBe('≈ 140 words per minute');
  });
});

describe('“why did it move?” records (§65)', () => {
  it('explains direction, behavior, and visual disposition', () => {
    const explanation = describeMovement(record());
    expect(explanation.headline).toContain('forward');
    expect(explanation.headline.toLowerCase()).toContain('skipped a little ahead');
    expect(explanation.headline).toContain('caught up gradually');
  });

  it('names the state transition, the authority, and the evidence margin', () => {
    const explanation = describeMovement(record({ authority: 'manual' }));
    expect(explanation.detail).toContain('Following');
    expect(explanation.detail).toContain('Catching up');
    expect(explanation.detail).toContain('authorized by you');
    expect(explanation.detail).toContain('0.71');
    expect(explanation.detail).toContain('0.18');
    expect(explanation.detail).toContain('no assist input');
  });

  it('reports semantic assist only when the record carries it', () => {
    const withAssist = describeMovement(
      record({ semanticAssistRelation: 'paraphrase', semanticAssistInfluence: 0.12 }),
    );
    expect(withAssist.detail).toContain('paraphrase');
    expect(withAssist.detail).toContain('influence 0.12');
    expect(withAssist.facts.some((f) => f.label === 'Assist')).toBe(true);
    expect(describeMovement(record()).facts.some((f) => f.label === 'Assist')).toBe(false);
  });

  it('calls out a blocked section gate', () => {
    const blocked = describeMovement(record({ sectionGate: 'blocked' }));
    expect(blocked.detail).toContain('blocked');
    expect(blocked.detail).toContain('command or manual authority');
  });

  it('describes a hold as holding, not as movement', () => {
    const held = describeMovement(
      record({ fromUnit: 100, toUnit: 100, visualDisposition: 'hold', behavior: 'adlib' }),
    );
    expect(held.headline).toContain('Held position');
  });

  it('formats scores and session time without inventing precision', () => {
    expect(formatScore(0.5)).toBe('0.50');
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatSessionTime(65_400)).toBe('1:05.400');
    expect(formatSessionTime(-1)).toBe('0:00.000');
  });
});

describe('degraded-state copy (Part XI)', () => {
  it('has specific copy for every non-assist condition', () => {
    for (const copy of Object.values(FOLLOW_NOTICE_COPY)) {
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(20);
      expect(copy.detail).not.toMatch(/something went wrong/i);
    }
  });

  it('promises that following continues without Luna (§58)', () => {
    for (const reason of ['timeout', 'error', 'quota', 'budget', 'no_model_access', 'no_key'] as const) {
      const copy = lunaUnavailableCopy(reason);
      expect(copy.title).toBeTruthy();
      expect(copy.detail).toMatch(/local matching|local tracking|Transcription/i);
    }
  });

  it('frames an exceeded budget as a measurement, not a failure (§63)', () => {
    const copy = budgetNoticeCopy([
      { id: 'stage_frame', observed: 2.4, budget: 1, unit: ' ms' },
    ]);
    expect(copy.tone).toBe('info');
    expect(copy.title).toContain('Stage frame work');
    expect(copy.detail).toContain('Following continues');
  });
});
