/**
 * Alignment and reconciliation of a delayed precision transcript
 * (§16.3.4, §16.5, §29.2).
 *
 * Three sequences meet here: the finalized Realtime transcript, the verbatim
 * precision transcript, and the eligible authored span. Weighted dynamic
 * programming aligns the first two; tokens present **only** in the precision
 * transcript are candidate disfluencies, because the Realtime path is the one
 * documented to drop them.
 *
 * The rule that matters most is §5.4: a precision result arrives seconds after
 * the audio it describes, and it is mapped **back** onto that audio. Nothing
 * in this file reads a clock. An insertion is placed, in order of preference:
 *
 * 1. the model's own word timing, when supplied;
 * 2. the gap between its matched neighbours' Realtime intervals — the
 *    Realtime tokens are anchored to commits, so they are the better ruler;
 * 3. an overlapping local acoustic hesitation, which snaps the estimate;
 * 4. proportional placement inside the chunk, stamped with a timing
 *    confidence below {@link UNLOCALIZED_TIMING_CONFIDENCE} so §16.3.4's
 *    "count it but do not place a gutter dot" rule can be applied by name.
 */
import type { FillerEvent } from '../../contracts/coaching';
import { contractionEquivalent, numberEquivalent } from '../../tracking/normalize';
import { classifyContextual } from './contextual-classifier';
import type { FillerLexicon } from './filler-lexicon';
import type { AcousticEvidenceLookup } from './realtime-filler-detector';
import type {
  AuthoredSpanContext,
  FillerDetection,
  PrecisionTranscriptResult,
  ReconciliationOutcome,
  TakeIdentity,
} from './types';
import { UNLOCALIZED_TIMING_CONFIDENCE, fillerEventId } from './types';
import { excerptAround, tokenizeUtterance, type UtteranceToken } from './utterance';

/* ---------------------------------------------------------------------------
 * Weighted alignment
 * ------------------------------------------------------------------------- */

export type AlignmentOp =
  | { op: 'match'; realtimeIndex: number; precisionIndex: number }
  | { op: 'substitute'; realtimeIndex: number; precisionIndex: number }
  /** Present only in the precision transcript — the candidate disfluency. */
  | { op: 'insert'; precisionIndex: number }
  /** Present only in the realtime transcript — precision dropped a word. */
  | { op: 'delete'; realtimeIndex: number };

const SCORE = {
  exact: 2,
  equivalent: 1.5,
  substitute: -1.5,
  /** A precision-only *filler* is the expected outcome, so it is cheap. */
  insertFiller: -0.2,
  insertOther: -1,
  delete: -1,
};

/**
 * Needleman–Wunsch over normalized tokens. Chunks are ≤ 12 s (§29.1), so the
 * sequences are tens of tokens and the quadratic table is trivial.
 */
export function alignSequences(
  realtime: readonly string[],
  precision: readonly string[],
  isFillerLike: (token: string) => boolean,
): AlignmentOp[] {
  const n = realtime.length;
  const m = precision.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = 1; i <= n; i++) table[i]![0] = (table[i - 1]![0] as number) + SCORE.delete;
  for (let j = 1; j <= m; j++) {
    const token = precision[j - 1] as string;
    table[0]![j] =
      (table[0]![j - 1] as number) + (isFillerLike(token) ? SCORE.insertFiller : SCORE.insertOther);
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const a = realtime[i - 1] as string;
      const b = precision[j - 1] as string;
      const diagonal = (table[i - 1]![j - 1] as number) + pairScore(a, b);
      const up = (table[i - 1]![j] as number) + SCORE.delete;
      const left =
        (table[i]![j - 1] as number) + (isFillerLike(b) ? SCORE.insertFiller : SCORE.insertOther);
      table[i]![j] = Math.max(diagonal, up, left);
    }
  }

  const ops: AlignmentOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const a = realtime[i - 1] as string;
      const b = precision[j - 1] as string;
      if ((table[i]![j] as number) === (table[i - 1]![j - 1] as number) + pairScore(a, b)) {
        ops.push({
          op: a === b || equivalent(a, b) ? 'match' : 'substitute',
          realtimeIndex: i - 1,
          precisionIndex: j - 1,
        });
        i--;
        j--;
        continue;
      }
    }
    if (j > 0) {
      const b = precision[j - 1] as string;
      const cost = isFillerLike(b) ? SCORE.insertFiller : SCORE.insertOther;
      if ((table[i]![j] as number) === (table[i]![j - 1] as number) + cost) {
        ops.push({ op: 'insert', precisionIndex: j - 1 });
        j--;
        continue;
      }
    }
    ops.push({ op: 'delete', realtimeIndex: i - 1 });
    i--;
  }
  return ops.reverse();
}

function equivalent(a: string, b: string): boolean {
  return numberEquivalent(a, b) || contractionEquivalent(a, b);
}

function pairScore(a: string, b: string): number {
  if (a === b) return SCORE.exact;
  if (equivalent(a, b)) return SCORE.equivalent;
  return SCORE.substitute;
}

/* ---------------------------------------------------------------------------
 * Reconciliation
 * ------------------------------------------------------------------------- */

export interface ReconcileInput {
  result: PrecisionTranscriptResult;
  /** Finalized realtime tokens covering (at least) the chunk interval. */
  realtimeTokens: readonly UtteranceToken[];
  /** Detections already held for this interval, from Layer A or an overlap. */
  existing: readonly FillerDetection[];
  authored: AuthoredSpanContext;
  take: TakeIdentity;
  lexicon: FillerLexicon;
  acoustics?: AcousticEvidenceLookup;
}

/** Two detections of the same form this close together are the same event. */
const IDENTITY_TOLERANCE_MS = 750;
/**
 * The wider bound used when a placement is unlocalized and identity therefore
 * rests on the neighbouring tokens. One maximum chunk (§29.1) — beyond that,
 * two occurrences with identical neighbours are two occurrences.
 */
const UNLOCALIZED_IDENTITY_TOLERANCE_MS = 6_000;

const TIMING_CONFIDENCE = {
  providedByModel: 0.85,
  neighbourGap: 0.6,
  acousticSnap: 0.75,
  proportional: 0.25,
};

export function reconcilePrecisionResult(input: ReconcileInput): ReconciliationOutcome {
  const outcome: ReconciliationOutcome = {
    created: [],
    promoted: [],
    demoted: [],
    deduplicated: [],
    corroborated: [],
  };

  const { result, realtimeTokens, existing, lexicon } = input;
  const precisionTokens = tokenizeUtterance(result.text, {
    audioStartMs: result.audioStartMs,
    audioEndMs: result.audioEndMs,
    ...(result.wordTimings ? { wordTimings: result.wordTimings } : {}),
  });

  // Nothing to say about an interval the model returned no words for; an empty
  // precision transcript is a failed pass, not evidence of clean delivery.
  if (precisionTokens.length === 0) return outcome;

  const inChunk = realtimeTokens.filter(
    (token) => token.endMs > result.audioStartMs && token.startMs < result.audioEndMs,
  );
  const realtimeForms = inChunk.map((token) => token.normalized);
  const precisionForms = precisionTokens.map((token) => token.normalized);
  const isFillerLike = (token: string): boolean =>
    lexicon.matchStrict(token) !== null || lexicon.matchContextualAt([token], 0) !== null;

  const ops = alignSequences(realtimeForms, precisionForms, isFillerLike);

  // Which precision tokens are insertions, and where they sit between matches.
  const matchedPrecisionToRealtime = new Map<number, number>();
  for (const op of ops) {
    if (op.op === 'match' || op.op === 'substitute') {
      matchedPrecisionToRealtime.set(op.precisionIndex, op.realtimeIndex);
    }
  }

  // Promotion and demotion may only speak about audio this chunk actually
  // covers…
  const overlapping = existing.filter(
    (detection) =>
      detection.event.audioEndMs > result.audioStartMs &&
      detection.event.audioStartMs < result.audioEndMs,
  );
  // …but de-duplication has to look wider, because an unlocalized placement
  // from the previous overlapping chunk can land outside this chunk entirely
  // while still describing the same "um".
  const nearby = existing.filter(
    (detection) =>
      detection.event.audioEndMs > result.audioStartMs - UNLOCALIZED_IDENTITY_TOLERANCE_MS &&
      detection.event.audioStartMs < result.audioEndMs + UNLOCALIZED_IDENTITY_TOLERANCE_MS,
  );
  const seen = new Set<string>();

  for (const op of ops) {
    if (op.op !== 'insert') continue;
    const token = precisionTokens[op.precisionIndex] as UtteranceToken;

    const strict = lexicon.matchStrict(token.normalized);
    const contextual = strict ? null : lexicon.matchContextualAt(precisionForms, op.precisionIndex);
    const repeated =
      !strict && !contextual && precisionForms[op.precisionIndex - 1] === token.normalized;
    if (!strict && !contextual && !repeated) continue;

    const placed = placeInsertion(
      op.precisionIndex,
      precisionTokens,
      inChunk,
      matchedPrecisionToRealtime,
      result,
      input.acoustics,
    );

    const canonicalForm = strict?.form ?? contextual?.form ?? token.normalized;
    const kind = strict ? 'strict_vocalized' : contextual ? 'contextual' : 'repeated_word';

    // §29.2: the same filler seen in an overlapping chunk is one event.
    //
    // Centre proximity alone is not enough. Two chunks that overlap by 450 ms
    // place the *same* unlocalized "um" proportionally inside two different
    // windows, and the two estimates can sit a second and a half apart — which
    // is why §29.2's identity hash includes the neighbouring tokens. When
    // either placement is unlocalized we fall back to that neighbour key,
    // bounded to one chunk's width so two genuinely different "um"s minutes
    // apart can never merge.
    const centreMs = (placed.startMs + placed.endMs) / 2;
    const neighbourKey = `${precisionForms[op.precisionIndex - 1] ?? '^'}|${
      precisionForms[op.precisionIndex + 1] ?? '$'
    }`;
    const duplicate = nearby.find((detection) => {
      if (detection.canonicalForm !== canonicalForm) return false;
      const delta = Math.abs(centreOf(detection.event) - centreMs);
      if (delta <= IDENTITY_TOLERANCE_MS) return true;
      const eitherUnlocalized =
        detection.event.timingConfidence < UNLOCALIZED_TIMING_CONFIDENCE ||
        placed.timingConfidence < UNLOCALIZED_TIMING_CONFIDENCE;
      return (
        eitherUnlocalized &&
        detection.neighbourKey === neighbourKey &&
        delta <= UNLOCALIZED_IDENTITY_TOLERANCE_MS
      );
    });
    if (duplicate) {
      seen.add(duplicate.event.eventId);
      outcome.deduplicated.push(duplicate.event.eventId);
      if (duplicate.event.confidence !== 'confirmed') outcome.promoted.push(duplicate.event.eventId);
      continue;
    }

    if (contextual) {
      // A precision transcript proves the *word* was spoken; it does not prove
      // the word was a filler. §16.4 still has to pass.
      const verdict = classifyContextual(precisionTokens, {
        form: contextual.form,
        tokenIndex: op.precisionIndex,
        length: contextual.length,
        absentFromAuthored: !authoredContains(input.authored, contextual.form),
        acousticHesitation: input.acoustics?.hasHesitation(placed.startMs, placed.endMs) ?? false,
        // A precision-only contextual token is by definition absent from the
        // realtime transcript; without repetition evidence across the take we
        // treat this chunk's own repeats as the count.
        priorOccurrences: countBefore(precisionForms, contextual.form, op.precisionIndex),
        inQuotation: false,
        ...(contextual.custom ? { custom: true } : {}),
      });
      if (!verdict.isFiller) continue;
    }

    const authoredIntentional =
      (input.authored.intentionalForms ?? []).includes(canonicalForm) ||
      authoredContains(input.authored, canonicalForm);

    const event: FillerEvent = {
      eventId: fillerEventId({
        takePassId: input.take.takePassId,
        normalizedForm: canonicalForm,
        audioCenterMs: (placed.startMs + placed.endMs) / 2,
        neighboringTokenIds: [
          precisionForms[op.precisionIndex - 1] ?? '^',
          precisionForms[op.precisionIndex + 1] ?? '$',
          input.authored.scriptAnchorTokenId ?? '-',
        ],
      }),
      kind,
      normalizedForm: canonicalForm,
      displayForm: strict ? lexicon.displayFormFor(canonicalForm) : null,
      // §16.5: a verbatim transcript containing the event, with credible
      // timing, is the definition of confirmed.
      confidence: 'confirmed',
      evidenceSources: ['precision_transcript'],
      audioStartMs: placed.startMs,
      audioEndMs: placed.endMs,
      timingConfidence: placed.timingConfidence,
      scriptAnchorTokenId: input.authored.scriptAnchorTokenId,
      takePassId: input.take.takePassId,
      authoredIntentional,
      countedLive: false,
    };

    outcome.created.push({
      event,
      canonicalForm,
      neighbourKey,
      finalEvidence: true,
      requiresHesitationEvidence: false,
      contextScore: contextual ? 0.9 : 1,
      commitSequence: result.commitSequence,
      trackingEpoch: input.take.trackingEpoch,
      itemId: `precision:${result.chunkId}`,
      tokenIndex: op.precisionIndex,
      spokenFragment: excerptAround(precisionTokens, op.precisionIndex),
      authoredFragment: input.authored.text.slice(0, 120),
      reasons: [`precision transcript insertion (${placed.method})`],
    });
  }

  // --- Promotion and demotion of what Layer A already believed (§16.5).
  for (const detection of overlapping) {
    if (seen.has(detection.event.eventId)) continue;
    if (detection.event.kind === 'repetitive_opener') continue;
    if (detection.event.evidenceSources.includes('precision_transcript')) continue;

    const present = precisionContains(precisionForms, detection.canonicalForm);
    if (present) {
      if (detection.event.confidence === 'confirmed') outcome.corroborated.push(detection.event.eventId);
      else outcome.promoted.push(detection.event.eventId);
      continue;
    }
    // The verbatim pass covered this interval and does not contain the form.
    // §16.5: "later transcript revision or context shows a legitimate word."
    if (detection.event.confidence !== 'rejected') outcome.demoted.push(detection.event.eventId);
  }

  return outcome;
}

interface PlacedInsertion {
  startMs: number;
  endMs: number;
  timingConfidence: number;
  method: 'model_timing' | 'neighbour_gap' | 'acoustic_snap' | 'proportional';
}

/**
 * §16.3.4. Map a precision-only token onto the audio interval it describes.
 * Never onto the moment the result arrived.
 */
function placeInsertion(
  precisionIndex: number,
  precisionTokens: readonly UtteranceToken[],
  realtimeTokens: readonly UtteranceToken[],
  matched: ReadonlyMap<number, number>,
  result: PrecisionTranscriptResult,
  acoustics?: AcousticEvidenceLookup,
): PlacedInsertion {
  const token = precisionTokens[precisionIndex] as UtteranceToken;

  if (result.wordTimings && result.wordTimings.length === precisionTokens.length) {
    return {
      startMs: token.startMs,
      endMs: token.endMs,
      timingConfidence: TIMING_CONFIDENCE.providedByModel,
      method: 'model_timing',
    };
  }

  // Matched neighbours, whose realtime intervals are anchored to commits.
  let beforeMs: number | null = null;
  for (let i = precisionIndex - 1; i >= 0; i--) {
    const realtimeIndex = matched.get(i);
    if (realtimeIndex === undefined) continue;
    beforeMs = realtimeTokens[realtimeIndex]?.endMs ?? null;
    break;
  }
  let afterMs: number | null = null;
  for (let i = precisionIndex + 1; i < precisionTokens.length; i++) {
    const realtimeIndex = matched.get(i);
    if (realtimeIndex === undefined) continue;
    afterMs = realtimeTokens[realtimeIndex]?.startMs ?? null;
    break;
  }

  if (beforeMs !== null && afterMs !== null && afterMs - beforeMs > 40) {
    const snapped = snapToAcoustic(beforeMs, afterMs, acoustics);
    if (snapped) return snapped;
    return {
      startMs: beforeMs,
      endMs: afterMs,
      timingConfidence: TIMING_CONFIDENCE.neighbourGap,
      method: 'neighbour_gap',
    };
  }

  const snapped = snapToAcoustic(result.audioStartMs, result.audioEndMs, acoustics);
  if (snapped) return snapped;

  // §16.3.4: count it, but say plainly that we cannot place it.
  return {
    startMs: token.startMs,
    endMs: token.endMs,
    timingConfidence: TIMING_CONFIDENCE.proportional,
    method: 'proportional',
  };
}

function snapToAcoustic(
  startMs: number,
  endMs: number,
  acoustics: AcousticEvidenceLookup | undefined,
): PlacedInsertion | null {
  if (!acoustics?.hasHesitation(startMs, endMs)) return null;
  const region = acoustics.hesitationRegion?.(startMs, endMs);
  if (!region) return null;
  return {
    startMs: region.startMs,
    endMs: region.endMs,
    timingConfidence: TIMING_CONFIDENCE.acousticSnap,
    method: 'acoustic_snap',
  };
}

function centreOf(event: FillerEvent): number {
  return (event.audioStartMs + event.audioEndMs) / 2;
}

function countBefore(forms: readonly string[], phrase: string, index: number): number {
  const words = phrase.split(' ');
  let count = 0;
  for (let i = 0; i + words.length <= index; i++) {
    let matched = true;
    for (let k = 0; k < words.length; k++) {
      if (forms[i + k] !== words[k]) {
        matched = false;
        break;
      }
    }
    if (matched) count++;
  }
  return count;
}

function precisionContains(forms: readonly string[], canonicalForm: string): boolean {
  const words = canonicalForm.split(' ');
  for (let i = 0; i + words.length <= forms.length; i++) {
    let matched = true;
    for (let k = 0; k < words.length; k++) {
      if (forms[i + k] !== words[k]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function authoredContains(authored: AuthoredSpanContext, phrase: string): boolean {
  if (authored.alignmentUnreliable === true) return false;
  const text = authored.text.toLowerCase();
  if (text.length === 0) return false;
  return new RegExp(`(^|[^a-z])${escapeRegExp(phrase)}([^a-z]|$)`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { UNLOCALIZED_TIMING_CONFIDENCE };
