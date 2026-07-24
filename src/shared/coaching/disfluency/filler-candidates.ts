/**
 * Filler-derived coach candidates (§16.7, §16.8, §24).
 *
 * A candidate is a *proposal*, not a tip: the scheduler in `coach/` decides
 * whether anything is shown, and Luna may only classify what is proposed here
 * (§2.1, §24). This module's whole job is to be honest about how much evidence
 * exists — `localConfidence` is computed from the margin over the threshold
 * and the quality of the underlying classification, never assigned a
 * comfortable constant.
 *
 * §16.7's first rule is the one most easily lost: **do not show a live tip for
 * the first isolated filler.** Every generator below therefore requires a
 * *pattern*, and every pattern is measured over an audio-clock window.
 */
import type { CoachCandidate, CoachCandidateType, FillerEvent } from '../../contracts/coaching';
import { CONTEXTUAL_CONFIRM_CONFIDENCE } from './contextual-classifier';
import type { FillerLexicon } from './filler-lexicon';
import type { OpenerObservation } from './realtime-filler-detector';
import type { FillerDetection, TakeIdentity } from './types';
import { isCountableFiller, stableId } from './types';

/** §16.7 initial thresholds. Personalized slowly; forgiving by default. */
export interface FillerCandidateConfig {
  clusterWindow20sCount: number;
  clusterWindow60sCount: number;
  sameStrictFillerCount: number;
  sameStrictFillerWindowMs: number;
  contextualRepeatCount: number;
  contextualRepeatWindowMs: number;
  /** §15.4 / §24: repeated restarts that block progress. */
  stumbleCount: number;
  stumbleWindowMs: number;
  /** §15.3: openers are only coachable live when the pattern is extreme. */
  repetitiveOpenerLiveTips: boolean;
  openerWindowSentences: number;
  openerMinRun: number;
  openerMinTotal: number;
  /** §16.8 / §25.6: off by default and never patronizing. */
  positiveReinforcementEnabled: boolean;
  positiveStreakMs: number;
}

export const DEFAULT_FILLER_CANDIDATE_CONFIG: FillerCandidateConfig = {
  clusterWindow20sCount: 3,
  clusterWindow60sCount: 5,
  sameStrictFillerCount: 3,
  sameStrictFillerWindowMs: 30_000,
  contextualRepeatCount: 3,
  contextualRepeatWindowMs: 60_000,
  stumbleCount: 2,
  stumbleWindowMs: 20_000,
  repetitiveOpenerLiveTips: false,
  openerWindowSentences: 8,
  openerMinRun: 5,
  openerMinTotal: 6,
  positiveReinforcementEnabled: false,
  positiveStreakMs: 30_000,
};

export interface FillerCandidateInput {
  detections: readonly FillerDetection[];
  openers: readonly OpenerObservation[];
  nowAudioMs: number;
  take: TakeIdentity;
  lexicon: FillerLexicon;
  config: FillerCandidateConfig;
  /** Audio-clock end of the most recent countable filler, or `null`. */
  lastCountableFillerEndMs: number | null;
  /** Audio-clock start of the current take pass. */
  takeStartAudioMs: number;
  /** True once this take has produced at least one countable filler. */
  hadFillersEarlier: boolean;
}

export function generateFillerCandidates(input: FillerCandidateInput): CoachCandidate[] {
  const candidates: CoachCandidate[] = [];
  const countable = input.detections.filter((detection) => isCountableFiller(detection.event));

  candidates.push(...clusterCandidates(countable, input));
  candidates.push(...repeatedStrictCandidates(countable, input));
  candidates.push(...contextualCandidates(countable, input));
  candidates.push(...stumbleCandidates(input));
  candidates.push(...openerCandidates(input));
  candidates.push(...positiveCandidates(input));
  return candidates;
}

/* ------------------------------------------------------------------------- */

function within(
  detections: readonly FillerDetection[],
  nowAudioMs: number,
  windowMs: number,
): FillerDetection[] {
  return detections.filter((detection) => detection.event.audioEndMs > nowAudioMs - windowMs);
}

function clusterCandidates(
  countable: readonly FillerDetection[],
  input: FillerCandidateInput,
): CoachCandidate[] {
  const last20 = within(countable, input.nowAudioMs, 20_000);
  const last60 = within(countable, input.nowAudioMs, 60_000);
  const by20 = last20.length >= input.config.clusterWindow20sCount;
  const by60 = last60.length >= input.config.clusterWindow60sCount;
  if (!by20 && !by60) return [];

  const contributing = by20 ? last20 : last60;
  const threshold = by20 ? input.config.clusterWindow20sCount : input.config.clusterWindow60sCount;
  return [
    buildCandidate({
      type: 'filler_cluster',
      detailCode: by20 ? 'cluster_20s' : 'cluster_60s',
      contributing,
      input,
      localConfidence: marginConfidence(contributing.length, threshold),
    }),
  ];
}

function repeatedStrictCandidates(
  countable: readonly FillerDetection[],
  input: FillerCandidateInput,
): CoachCandidate[] {
  const recent = within(countable, input.nowAudioMs, input.config.sameStrictFillerWindowMs).filter(
    (detection) => detection.event.kind === 'strict_vocalized',
  );
  const groups = groupBy(recent, (detection) => detection.canonicalForm);
  const out: CoachCandidate[] = [];
  for (const [form, detections] of groups) {
    if (detections.length < input.config.sameStrictFillerCount) continue;
    // §25.3: the interpolated `{filler}` must come from the fixed allowlist.
    // If the lexicon will not vouch for the form, no quotable candidate is
    // produced at all — the cluster tip covers it instead.
    if (input.lexicon.displayFormFor(form) === null) continue;
    out.push(
      buildCandidate({
        type: 'repeated_filler',
        detailCode: form,
        contributing: detections,
        input,
        localConfidence: marginConfidence(detections.length, input.config.sameStrictFillerCount),
      }),
    );
  }
  return out;
}

function contextualCandidates(
  countable: readonly FillerDetection[],
  input: FillerCandidateInput,
): CoachCandidate[] {
  const recent = within(countable, input.nowAudioMs, input.config.contextualRepeatWindowMs).filter(
    (detection) => detection.event.kind === 'contextual',
  );
  const groups = groupBy(recent, (detection) => detection.canonicalForm);
  const out: CoachCandidate[] = [];
  for (const [form, detections] of groups) {
    if (detections.length < input.config.contextualRepeatCount) continue;
    const meanScore =
      detections.reduce((total, detection) => total + detection.contextScore, 0) / detections.length;
    // A weakly-classified contextual pattern is not worth a live tip: §2.4's
    // failure mode is exactly a confident-looking tip about a normal word.
    if (meanScore < CONTEXTUAL_CONFIRM_CONFIDENCE) continue;
    out.push(
      buildCandidate({
        type: 'contextual_filler',
        detailCode: form,
        contributing: detections,
        input,
        localConfidence:
          marginConfidence(detections.length, input.config.contextualRepeatCount) * meanScore,
      }),
    );
  }
  return out;
}

function stumbleCandidates(input: FillerCandidateInput): CoachCandidate[] {
  const recent = input.detections.filter(
    (detection) =>
      detection.event.confidence === 'confirmed' &&
      !detection.event.authoredIntentional &&
      (detection.event.kind === 'repeated_word' ||
        detection.event.kind === 'false_start' ||
        detection.event.kind === 'self_correction') &&
      detection.event.audioEndMs > input.nowAudioMs - input.config.stumbleWindowMs,
  );
  if (recent.length < input.config.stumbleCount) return [];
  return [
    buildCandidate({
      type: 'repeated_stumble',
      detailCode: 'restart',
      contributing: recent,
      input,
      localConfidence: marginConfidence(recent.length, input.config.stumbleCount),
    }),
  ];
}

/**
 * §15.3. A repetitive opener is a session pattern and is normally post-take
 * feedback. Live coaching requires all three of: an extreme run, the user
 * having enabled it, and the openers being confidently absent from the script.
 */
function openerCandidates(input: FillerCandidateInput): CoachCandidate[] {
  if (!input.config.repetitiveOpenerLiveTips) return [];
  const window = input.openers.slice(-input.config.openerWindowSentences);
  if (window.length < input.config.openerWindowSentences) return [];

  const groups = groupBy(window, (opener) => opener.form);
  for (const [form, occurrences] of groups) {
    if (occurrences.length < input.config.openerMinRun) continue;
    if (occurrences.some((opener) => opener.authored)) continue;
    const total = input.openers.filter(
      (opener) => opener.form === form && !opener.authored,
    ).length;
    if (total < input.config.openerMinTotal) continue;
    const audioStartMs = Math.min(...occurrences.map((opener) => opener.audioStartMs));
    const audioEndMs = Math.max(...occurrences.map((opener) => opener.audioEndMs));
    const last = occurrences[occurrences.length - 1] as OpenerObservation;
    return [
      {
        evidenceId: stableId('cand', ['repetitive_opener', input.take.takePassId, form, audioStartMs]),
        type: 'repetitive_opener',
        localConfidence: marginConfidence(occurrences.length, input.config.openerMinRun),
        stamp: {
          audioStartMs,
          audioEndMs,
          commitSequence: last.commitSequence,
          trackingEpoch: input.take.trackingEpoch,
          takePassId: input.take.takePassId,
        },
        scriptSpanId: null,
        scriptAnchorTokenId: null,
        // A session pattern across many sentences; there is no single
        // underlying `FillerEvent` to revise away.
        contributingEventIds: [],
        detailCode: form,
        spokenFragment: `${occurrences.length} of the last ${window.length} sentences opened with "${form}"`,
        authoredFragment: '',
        finalEvidence: true,
      },
    ];
  }
  return [];
}

function positiveCandidates(input: FillerCandidateInput): CoachCandidate[] {
  if (!input.config.positiveReinforcementEnabled) return [];
  // §25.6: a streak only means something after there was something to improve.
  if (!input.hadFillersEarlier || input.lastCountableFillerEndMs === null) return [];
  const streakMs = input.nowAudioMs - input.lastCountableFillerEndMs;
  if (streakMs < input.config.positiveStreakMs) return [];
  return [
    {
      evidenceId: stableId('cand', [
        'positive_filler_streak',
        input.take.takePassId,
        Math.round(input.lastCountableFillerEndMs),
      ]),
      type: 'positive_filler_streak',
      localConfidence: 0.9,
      stamp: {
        audioStartMs: input.lastCountableFillerEndMs,
        audioEndMs: input.nowAudioMs,
        commitSequence: null,
        trackingEpoch: input.take.trackingEpoch,
        takePassId: input.take.takePassId,
      },
      scriptSpanId: null,
      scriptAnchorTokenId: null,
      // Derived from the *absence* of events over a window.
      contributingEventIds: [],
      detailCode: `streak_${Math.floor(streakMs / 1000)}s`,
      spokenFragment: '',
      authoredFragment: '',
      finalEvidence: true,
    },
  ];
}

/* ------------------------------------------------------------------------- */

function buildCandidate(input: {
  type: CoachCandidateType;
  detailCode: string;
  contributing: readonly FillerDetection[];
  input: FillerCandidateInput;
  localConfidence: number;
}): CoachCandidate {
  const events = input.contributing.map((detection) => detection.event);
  const audioStartMs = Math.min(...events.map((event) => event.audioStartMs));
  const audioEndMs = Math.max(...events.map((event) => event.audioEndMs));
  const last = input.contributing[input.contributing.length - 1] as FillerDetection;
  return {
    evidenceId: stableId('cand', [
      input.type,
      input.input.take.takePassId,
      input.detailCode,
      Math.round(audioEndMs / 1000),
    ]),
    type: input.type,
    localConfidence: clamp(input.localConfidence),
    stamp: {
      audioStartMs,
      audioEndMs,
      // §5.4: the commit the newest piece of evidence came from, or `null`
      // when the evidence is purely local/precision-derived.
      commitSequence: last.commitSequence,
      trackingEpoch: input.input.take.trackingEpoch,
      takePassId: input.input.take.takePassId,
    },
    // A span id and a token id are different namespaces. This used to put the
    // event's *token* anchor in the *span* field, which defeated both the
    // §19.4 opt-out (a token id is never in the disabled-span set) and §26.5
    // scope cancellation (a token id never equals the active span id, so every
    // filler tip cancelled itself on the following tick).
    scriptSpanId: last.scriptSpanId,
    scriptAnchorTokenId: last.event.scriptAnchorTokenId,
    // §26.5: the path from a demoted `FillerEvent` back to this candidate.
    contributingEventIds: events.map((event) => event.eventId),
    detailCode: input.detailCode,
    spokenFragment: last.spokenFragment,
    authoredFragment: last.authoredFragment,
    // Every contributing event is `confirmed`, and confirmation only ever
    // comes from final transcript, local audio, precision or Luna — never
    // from a provisional tail.
    finalEvidence: events.every((event: FillerEvent) => event.confidence === 'confirmed'),
  };
}

/**
 * Confidence from the margin over the threshold: exactly at the threshold is
 * a weak claim, twice the threshold is a strong one. Deliberately never 1.
 */
function marginConfidence(count: number, threshold: number): number {
  if (threshold <= 0) return 0.5;
  return clamp(0.55 + 0.1 * (count - threshold), 0.55, 0.95);
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.min(high, Math.max(low, value));
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const group = map.get(key(item));
    if (group) group.push(item);
    else map.set(key(item), [item]);
  }
  return map;
}
