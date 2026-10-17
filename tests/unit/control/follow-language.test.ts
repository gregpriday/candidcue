import { describe, expect, it } from 'vitest';
import type { AlignmentDecision, StageMotionState } from '../../../src/shared/contracts';
import {
  CONFIDENCE_BANDS,
  CONFIDENCE_BAND_LABELS,
  FOLLOW_DECISION_LABELS,
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
  type MovementDecisionRecord,
} from '../../../src/control/lib/follow-language';

const ALL_STATES: StageMotionState[] = [
  'searching',
  'following',
  'holding',
  'ambiguous',
  'paused',
];

const ALL_DECISIONS: AlignmentDecision[] = [
  'noEvidence',
  'localObserved',
  'localConfirmed',
  'holdLowEvidence',
  'holdOffScript',
  'holdAmbiguous',
  'holdOffScreen',
  'relocationAccepted',
  'jumpForwardAccepted',
  'retakeAccepted',
  'jumpPending',
  'manualAnchor',
];

function record(patch: Partial<MovementDecisionRecord> = {}): MovementDecisionRecord {
  return {
    seq: 12,
    audioMs: 65_400,
    fromToken: 100,
    toToken: 104.5,
    decision: 'jumpForwardAccepted',
    stateBefore: 'following',
    stateAfter: 'following',
    confidence: 0.71,
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

  it('has a diagnostics label for every decision code', () => {
    for (const decision of ALL_DECISIONS) {
      expect(FOLLOW_DECISION_LABELS[decision]).toBeTruthy();
    }
  });

  it('reuses the F.11 wording for held and searching states', () => {
    expect(FOLLOW_STATE_LABELS.searching).toBe('Looking for your place');
    expect(FOLLOW_STATE_LABELS.holding).toBe('Holding your place');
    expect(FOLLOW_STATE_LABELS.paused).toContain('listening');
  });

  /*
   * The research brief is explicit that a hold must read as calm. A warning
   * tone here would train presenters to panic at exactly the moment the engine
   * is being careful on their behalf — refusing to guess where they are.
   */
  it('never uses a warning tone for a hold', () => {
    expect(followStateTone('holding')).toBe('neutral');
    expect(followStateTone('ambiguous')).toBe('neutral');
  });

  /*
   * `ambiguous` and `holding` deliberately share a status label but not a
   * detail: "these words appear twice" is something the presenter can act on,
   * "evidence is thin" would send them hunting a microphone fault.
   */
  it('distinguishes ambiguity from weak evidence in the detail, not the label', () => {
    expect(FOLLOW_STATE_LABELS.ambiguous).toBe(FOLLOW_STATE_LABELS.holding);
    expect(FOLLOW_STATE_DETAIL.ambiguous).not.toBe(FOLLOW_STATE_DETAIL.holding);
    expect(FOLLOW_STATE_DETAIL.ambiguous).toContain('more than one place');
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
  it('explains direction, distance and the decision behind it', () => {
    const explanation = describeMovement(record());
    expect(explanation.headline).toContain('forward');
    expect(explanation.headline.toLowerCase()).toContain('jumped forward');
  });

  it('names the state transition and the evidence score', () => {
    const explanation = describeMovement(
      record({ stateBefore: 'holding', stateAfter: 'following' }),
    );
    expect(explanation.detail).toContain('Holding your place');
    expect(explanation.detail).toContain('Following');
    expect(explanation.detail).toContain('0.71');
  });

  /*
   * Confidence is a documented heuristic, not a calibrated probability, so it
   * must never be rendered as a percentage anywhere a presenter can read it.
   */
  it('never renders the match score as a percentage', () => {
    expect(describeMovement(record()).detail).not.toContain('%');
  });

  it('describes a hold as holding, not as movement', () => {
    const held = describeMovement(
      record({ fromToken: 100, toToken: 100, decision: 'holdOffScript' }),
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

  /*
   * #304: the recogniser runs on this machine. "Reconnecting" promised a retry
   * that a recogniser which gave up will never make, and "still connected"
   * pointed a presenter at their wifi.
   */
  it('describes speech recognition, not a connection, when transcription stops', () => {
    const copy = FOLLOW_NOTICE_COPY.transcription_interrupted;
    // Raised on a healthy first start too, so it cannot claim an interruption.
    expect(copy.title).toBe('Voice following unavailable — position held');
    expect(copy.detail).toMatch(/^Speech recognition is not ready\./);
    expect(FOLLOW_STATE_DETAIL.paused).toBe('Automatic movement is stopped. The take is still running.');
    for (const text of [copy.title, copy.detail, FOLLOW_STATE_DETAIL.paused, FOLLOW_STATE_LABELS.paused]) {
      expect(text).not.toMatch(/connect|transcriber|network/i);
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
