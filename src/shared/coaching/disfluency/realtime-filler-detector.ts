/**
 * Layer A — realtime transcript detection (§16.1).
 *
 * Every detection this module produces is `probable`. That is not timidity, it
 * is the contract (`FillerEvent.confidence`, §2.3): the Realtime path is
 * documented to drop hesitations it was never prompted to keep, so its
 * *presence* claims are useful and its *absence* claims are worthless. Only
 * local audio, a precision transcript, or Luna may promote a detection —
 * promotion lives in `filler-tracker.ts`, never here.
 *
 * Provisional text cannot produce an event at all: `observeProvisional`
 * returns hints, not `FillerEvent`s, so §16.1's "MUST NOT create a visible
 * solid tick" is unrepresentable rather than merely unimplemented.
 */
import type { FillerEvent, FillerKind } from '../../contracts/coaching';
import { normalizeText } from '../../tracking/normalize';
import {
  CONTEXTUAL_CONFIRM_CONFIDENCE,
  classifyContextual,
  type ContextualVerdict,
} from './contextual-classifier';
import type { FillerLexicon } from './filler-lexicon';
import type {
  AuthoredSpanContext,
  FillerDetection,
  ProvisionalFillerHint,
  RealtimeTranscriptItem,
} from './types';
import { fillerEventId } from './types';
import { applyPauseBoundaries, excerptAround, tokenizeUtterance, type UtteranceToken } from './utterance';

export type { FillerDetection };

/** One sentence-opener occurrence (§15.3). Never a filler event on its own. */
export interface OpenerObservation {
  form: string;
  audioStartMs: number;
  audioEndMs: number;
  sentenceIndex: number;
  itemId: string;
  commitSequence: number | null;
  /**
   * True when the opener is present in the aligned authored span *or* the
   * alignment is unavailable. Fails closed: §15.3 requires the pattern to be
   * "confidently absent from the script" before it may be coached.
   */
  authored: boolean;
}

export interface RealtimeDetectionResult {
  detections: FillerDetection[];
  openers: OpenerObservation[];
  tokens: UtteranceToken[];
  /** Rejected contextual matches, kept for diagnostics and tests. */
  rejectedContextual: Array<{ form: string; tokenIndex: number; verdict: ContextualVerdict }>;
}

/** Local audio evidence the detector may consult while classifying (§16.2). */
export interface AcousticEvidenceLookup {
  /** True when a hesitation-like region overlaps `[startMs, endMs]`. */
  hasHesitation(startMs: number, endMs: number): boolean;
  /** Speech-run start times, used to recover sentence boundaries (§16.4). */
  boundaryStartsMs(startMs: number, endMs: number): readonly number[];
  /**
   * The overlapping hesitation region itself, when one exists — used by the
   * reconciler to snap a delayed precision insertion onto real audio
   * (§16.3.4) instead of a proportional guess.
   */
  hesitationRegion?(startMs: number, endMs: number): { startMs: number; endMs: number } | null;
}

const NO_ACOUSTIC_EVIDENCE: AcousticEvidenceLookup = {
  hasHesitation: () => false,
  boundaryStartsMs: () => [],
};

/**
 * Words English legitimately doubles. Without this list `we had had a plan`
 * and `that that argument` become disfluencies, which is the same class of
 * false positive as flagging every "and".
 */
const LEGITIMATE_DOUBLES = new Set(['had', 'that', 'very', 'no', 'yes', 'ha', 'bye']);

/** Cues that mark an explicit self-correction (§15.4). */
const CORRECTION_CUES: readonly string[][] = [
  ['sorry'],
  ['rather'],
  ['no', 'wait'],
  ['excuse', 'me'],
  ['let', 'me', 'rephrase'],
  ['scratch', 'that'],
];

export interface RealtimeFillerDetectorOptions {
  lexicon: FillerLexicon;
  /** Window for the contextual repetition requirement, ms. Default 60 000. */
  repetitionWindowMs?: number;
  acoustics?: AcousticEvidenceLookup;
}

export class RealtimeFillerDetector {
  private readonly lexicon: FillerLexicon;
  private readonly repetitionWindowMs: number;
  private acoustics: AcousticEvidenceLookup;
  /** Recent contextual-form occurrences, for the repetition requirement. */
  private history: Array<{ form: string; audioTimeMs: number }> = [];

  constructor(options: RealtimeFillerDetectorOptions) {
    this.lexicon = options.lexicon;
    this.repetitionWindowMs = options.repetitionWindowMs ?? 60_000;
    this.acoustics = options.acoustics ?? NO_ACOUSTIC_EVIDENCE;
  }

  setAcoustics(acoustics: AcousticEvidenceLookup): void {
    this.acoustics = acoustics;
  }

  /** Drop history belonging to a previous take pass. */
  reset(): void {
    this.history = [];
  }

  /**
   * §16.1. Provisional text may refine an internal candidate but may never
   * become an event — a provisional tail is routinely revised away.
   */
  observeProvisional(
    item: RealtimeTranscriptItem,
    authored: AuthoredSpanContext,
  ): ProvisionalFillerHint[] {
    const tokens = tokenizeUtterance(item.text, {
      audioStartMs: item.audioStartMs,
      audioEndMs: item.audioEndMs,
      turnStart: item.turnStart,
    });
    const hints: ProvisionalFillerHint[] = [];
    for (const token of tokens) {
      const strict = this.lexicon.matchStrict(token.normalized);
      if (!strict) continue;
      if (this.authoredContains(authored, [strict.form])) continue;
      hints.push({
        itemId: item.itemId,
        normalizedForm: strict.form,
        kind: 'strict_vocalized',
        audioStartMs: token.startMs,
        audioEndMs: token.endMs,
      });
    }
    return hints;
  }

  /** §16.1. Detect on a finalized item. All events are `probable`. */
  observeFinal(
    item: RealtimeTranscriptItem,
    authored: AuthoredSpanContext,
    take: { takePassId: string; trackingEpoch: number },
  ): RealtimeDetectionResult {
    const tokens = tokenizeUtterance(item.text, {
      audioStartMs: item.audioStartMs,
      audioEndMs: item.audioEndMs,
      wordTimings: item.wordTimings,
      turnStart: item.turnStart,
    });
    applyPauseBoundaries(tokens, this.acoustics.boundaryStartsMs(item.audioStartMs, item.audioEndMs));

    const result: RealtimeDetectionResult = {
      detections: [],
      openers: [],
      tokens,
      rejectedContextual: [],
    };
    if (tokens.length === 0) return result;
    if (authored.coachingDisabled === true) return result;

    const normalized = tokens.map((token) => token.normalized);
    const quoted = quotationMask(tokens);
    const consumed = new Array<boolean>(tokens.length).fill(false);

    // --- Repetitions, false starts and self-corrections first (§15.4): they
    // claim their tokens so a repeated `like like` is one stumble, not two
    // contextual fillers.
    for (const detection of this.detectRepetitions(tokens, item, authored, take)) {
      result.detections.push(detection.detection);
      for (const index of detection.tokenIndexes) consumed[index] = true;
    }

    // --- Strict vocalized (§15.1).
    //
    // §15.5 is a *budget*, not a flag: if the script says "um" once and the
    // presenter says it twice, the first is authored delivery and the second
    // is an insertion. Treating it as a flag (does the span contain "um"?)
    // silently excused every extra filler on any line that authored one.
    const authoredBudget = this.authoredStrictBudget(authored);
    for (let i = 0; i < tokens.length; i++) {
      if (consumed[i]) continue;
      const token = tokens[i] as UtteranceToken;
      const strict = this.lexicon.matchStrict(token.normalized);
      if (!strict) continue;
      consumed[i] = true;
      const authoredIntentional = this.consumeAuthoredBudget(
        authoredBudget,
        authored,
        strict.form,
        token.normalized,
      );
      result.detections.push(
        this.buildDetection({
          tokens,
          startIndex: i,
          endIndex: i,
          kind: 'strict_vocalized',
          canonicalForm: strict.form,
          normalizedForm: strict.form,
          displayForm: this.lexicon.displayFormFor(strict.form),
          item,
          authored,
          take,
          authoredIntentional,
          requiresHesitationEvidence: !strict.unconditional,
          contextScore: 1,
          reasons: [strict.unconditional ? 'strict lexicon (unconditional)' : 'strict lexicon (hesitation-conditional)'],
        }),
      );
    }

    // --- Contextual (§15.2 / §16.4). Every one of these must survive the gate.
    for (let i = 0; i < tokens.length; i++) {
      if (consumed[i]) continue;
      const match = this.lexicon.matchContextualAt(normalized, i);
      if (!match) continue;
      const lastIndex = i + match.length - 1;
      if (consumed.slice(i, lastIndex + 1).some(Boolean)) continue;
      const first = tokens[i] as UtteranceToken;
      const last = tokens[lastIndex] as UtteranceToken;
      const absentFromAuthored =
        this.authoredUsable(authored) && !this.authoredContains(authored, match.form.split(' '));
      const verdict = classifyContextual(tokens, {
        form: match.form,
        tokenIndex: i,
        length: match.length,
        absentFromAuthored,
        acousticHesitation: this.acoustics.hasHesitation(first.startMs, last.endMs),
        priorOccurrences: this.priorOccurrences(match.form, first.startMs),
        inQuotation: quoted[i] === true,
        custom: match.custom,
      });
      // Only filler-*shaped* uses feed the repetition requirement. Counting
      // lexical uses would let "turn right" twice unlock a `right` filler on
      // the third occurrence — a repetition gate that its own false positives
      // can open is not a gate.
      if (verdict.isFiller || verdict.veto === 'insufficient_repetition') {
        this.history.push({ form: match.form, audioTimeMs: first.startMs });
      }
      if (!verdict.isFiller) {
        result.rejectedContextual.push({ form: match.form, tokenIndex: i, verdict });
        continue;
      }
      for (let k = i; k <= lastIndex; k++) consumed[k] = true;
      result.detections.push(
        this.buildDetection({
          tokens,
          startIndex: i,
          endIndex: lastIndex,
          kind: 'contextual',
          canonicalForm: match.form,
          normalizedForm: match.form,
          // §25.3: contextual forms are never quoted back, custom or not.
          displayForm: null,
          item,
          authored,
          take,
          authoredIntentional: false,
          // §16.5: the classification term for a contextual filler is the
          // §16.4 verdict itself (veto → structure → repetition), carried as
          // `contextScore`. Acoustic hesitation raises that score; it is not a
          // separate precondition.
          requiresHesitationEvidence: false,
          contextScore: verdict.score,
          reasons: verdict.reasons,
        }),
      );
    }

    // --- Openers (§15.3): logged as a session pattern, never as a filler.
    for (const token of tokens) {
      if (!token.isSentenceStart) continue;
      if (!this.lexicon.isOpener(token.normalized)) continue;
      result.openers.push({
        form: token.normalized,
        audioStartMs: token.startMs,
        audioEndMs: token.endMs,
        sentenceIndex: token.sentenceIndex,
        itemId: item.itemId,
        commitSequence: item.commitSequence,
        authored:
          !this.authoredUsable(authored) || this.authoredContains(authored, [token.normalized]),
      });
    }

    this.trimHistory(item.audioEndMs);
    result.detections.sort((a, b) => a.event.audioStartMs - b.event.audioStartMs);
    return result;
  }

  /* ----------------------------------------------------------------------- */

  private detectRepetitions(
    tokens: readonly UtteranceToken[],
    item: RealtimeTranscriptItem,
    authored: AuthoredSpanContext,
    take: { takePassId: string; trackingEpoch: number },
  ): Array<{ detection: FillerDetection; tokenIndexes: number[] }> {
    const out: Array<{ detection: FillerDetection; tokenIndexes: number[] }> = [];
    const claimed = new Set<number>();

    // Self-correction cues (§15.4). Checked first so `sorry, the second option`
    // is a correction rather than a bare repetition.
    for (let i = 0; i < tokens.length; i++) {
      for (const cue of CORRECTION_CUES) {
        if (i + cue.length > tokens.length) continue;
        let matched = true;
        for (let k = 0; k < cue.length; k++) {
          if (tokens[i + k]?.normalized !== cue[k]) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        const indexes = Array.from({ length: cue.length }, (_, k) => i + k);
        if (indexes.some((index) => claimed.has(index))) continue;
        for (const index of indexes) claimed.add(index);
        out.push({
          tokenIndexes: indexes,
          detection: this.buildDetection({
            tokens,
            startIndex: i,
            endIndex: i + cue.length - 1,
            kind: 'self_correction',
            canonicalForm: cue.join(' '),
            normalizedForm: cue.join(' '),
            displayForm: null,
            item,
            authored,
            take,
            authoredIntentional: this.authoredContains(authored, cue),
            requiresHesitationEvidence: false,
            contextScore: 0.7,
            reasons: ['explicit correction cue'],
          }),
        });
      }
    }

    // Phrase repetition / false start: the longest repeated run wins, so
    // `the next— the next thing` is one false start, not two repeated words.
    for (let i = 0; i < tokens.length; i++) {
      for (let length = 4; length >= 2; length--) {
        if (i + length * 2 > tokens.length) continue;
        let matched = true;
        for (let k = 0; k < length; k++) {
          if (tokens[i + k]?.normalized !== tokens[i + length + k]?.normalized) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        const indexes = Array.from({ length: length * 2 }, (_, k) => i + k);
        if (indexes.some((index) => claimed.has(index))) continue;
        for (const index of indexes) claimed.add(index);
        const phrase = tokens
          .slice(i, i + length)
          .map((token) => token.normalized)
          .join(' ');
        out.push({
          tokenIndexes: indexes,
          detection: this.buildDetection({
            tokens,
            startIndex: i,
            endIndex: i + length * 2 - 1,
            kind: 'false_start',
            canonicalForm: phrase,
            normalizedForm: phrase,
            displayForm: null,
            item,
            authored,
            take,
            authoredIntentional: this.authoredContains(authored, [phrase, phrase]),
            requiresHesitationEvidence: false,
            contextScore: 0.8,
            reasons: [`phrase "${phrase}" restarted`],
          }),
        });
        break;
      }
    }

    // Single-token repetition, allowing an intervening strict filler so
    // `the, um, the second option` is caught (§15.4).
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as UtteranceToken;
      if (claimed.has(i)) continue;
      if (LEGITIMATE_DOUBLES.has(token.normalized)) continue;
      if (token.normalized.length === 0) continue;
      let j = i + 1;
      const skipped: number[] = [];
      while (j < tokens.length && this.lexicon.matchStrict(tokens[j]?.normalized ?? '')) {
        skipped.push(j);
        j++;
      }
      const next = tokens[j];
      if (!next || next.normalized !== token.normalized) continue;
      if (claimed.has(j)) continue;
      claimed.add(i);
      claimed.add(j);
      out.push({
        // The intervening filler stays unclaimed: an "um" between two "the"s
        // is a real filler and must still be counted.
        tokenIndexes: [i, j],
        detection: this.buildDetection({
          tokens,
          startIndex: i,
          endIndex: j,
          kind: 'repeated_word',
          canonicalForm: token.normalized,
          normalizedForm: token.normalized,
          displayForm: null,
          item,
          authored,
          take,
          authoredIntentional: this.authoredContains(authored, [token.normalized, token.normalized]),
          requiresHesitationEvidence: false,
          contextScore: 0.8,
          reasons: [`"${token.normalized}" repeated${skipped.length > 0 ? ' across a filler' : ''}`],
        }),
      });
    }

    return out;
  }

  private buildDetection(input: {
    tokens: readonly UtteranceToken[];
    startIndex: number;
    endIndex: number;
    kind: FillerKind;
    canonicalForm: string;
    normalizedForm: string;
    displayForm: string | null;
    item: RealtimeTranscriptItem;
    authored: AuthoredSpanContext;
    take: { takePassId: string; trackingEpoch: number };
    authoredIntentional: boolean;
    requiresHesitationEvidence: boolean;
    contextScore: number;
    reasons: string[];
  }): FillerDetection {
    const first = input.tokens[input.startIndex] as UtteranceToken;
    const last = input.tokens[input.endIndex] as UtteranceToken;
    const neighbours = [
      input.tokens[input.startIndex - 1]?.normalized ?? '^',
      input.tokens[input.endIndex + 1]?.normalized ?? '$',
      input.authored.scriptAnchorTokenId ?? '-',
    ];
    const event: FillerEvent = {
      eventId: fillerEventId({
        takePassId: input.take.takePassId,
        normalizedForm: input.normalizedForm,
        audioCenterMs: (first.startMs + last.endMs) / 2,
        neighboringTokenIds: neighbours,
      }),
      kind: input.kind,
      normalizedForm: input.normalizedForm,
      displayForm: input.displayForm,
      confidence: 'probable',
      evidenceSources: ['realtime'],
      audioStartMs: first.startMs,
      audioEndMs: last.endMs,
      timingConfidence: first.timingConfidence,
      scriptAnchorTokenId: input.authored.scriptAnchorTokenId,
      takePassId: input.take.takePassId,
      authoredIntentional: input.authoredIntentional,
      countedLive: false,
    };
    return {
      event,
      canonicalForm: input.canonicalForm,
      // Only `observeFinal` reaches this builder; `observeProvisional` returns
      // hints, which have no path to an event at all (§16.1).
      finalEvidence: true,
      requiresHesitationEvidence: input.requiresHesitationEvidence,
      contextScore: input.contextScore,
      neighbourKey: `${neighbours[0]}|${neighbours[1]}`,
      commitSequence: input.item.commitSequence,
      trackingEpoch: input.take.trackingEpoch,
      itemId: input.item.itemId,
      tokenIndex: input.startIndex,
      spokenFragment: excerptAround(input.tokens, input.startIndex),
      authoredFragment: boundedExcerpt(input.authored.text),
      reasons: input.reasons,
    };
  }

  /** §15.5. How many of each strict form the authored span actually contains. */
  private authoredStrictBudget(authored: AuthoredSpanContext): Map<string, number> {
    const budget = new Map<string, number>();
    if (!this.authoredUsable(authored)) return budget;
    for (const token of normalizeText(authored.text).split(' ')) {
      const entry = this.lexicon.matchStrict(token);
      if (!entry) continue;
      budget.set(entry.form, (budget.get(entry.form) ?? 0) + 1);
    }
    return budget;
  }

  /**
   * §15.5. An explicit annotation covers every occurrence on the line; an
   * unannotated authored filler covers one occurrence each.
   */
  private consumeAuthoredBudget(
    budget: Map<string, number>,
    authored: AuthoredSpanContext,
    canonicalForm: string,
    spokenForm: string,
  ): boolean {
    const intentional = authored.intentionalForms ?? [];
    if (intentional.includes(canonicalForm) || intentional.includes(spokenForm)) return true;
    const remaining = budget.get(canonicalForm) ?? 0;
    if (remaining <= 0) return false;
    budget.set(canonicalForm, remaining - 1);
    return true;
  }

  private authoredUsable(authored: AuthoredSpanContext): boolean {
    return authored.alignmentUnreliable !== true && authored.text.trim().length > 0;
  }

  /** True when the authored span contains the token sequence in order. */
  private authoredContains(authored: AuthoredSpanContext, sequence: readonly string[]): boolean {
    if (!this.authoredUsable(authored)) return false;
    const authoredTokens = normalizeText(authored.text).split(' ').filter((token) => token.length > 0);
    if (sequence.length === 0) return false;
    const flat = sequence.flatMap((entry) => entry.split(' '));
    for (let i = 0; i + flat.length <= authoredTokens.length; i++) {
      let matched = true;
      for (let k = 0; k < flat.length; k++) {
        if (authoredTokens[i + k] !== flat[k]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
    return false;
  }

  private priorOccurrences(form: string, audioTimeMs: number): number {
    const cutoff = audioTimeMs - this.repetitionWindowMs;
    let count = 0;
    for (const entry of this.history) {
      if (entry.form === form && entry.audioTimeMs >= cutoff && entry.audioTimeMs < audioTimeMs) {
        count++;
      }
    }
    return count;
  }

  private trimHistory(audioTimeMs: number): void {
    const cutoff = audioTimeMs - this.repetitionWindowMs;
    this.history = this.history.filter((entry) => entry.audioTimeMs >= cutoff);
  }
}

/** Mark tokens that sit inside double-quoted speech (§16.4 "not a quotation"). */
function quotationMask(tokens: readonly UtteranceToken[]): boolean[] {
  const mask = new Array<boolean>(tokens.length).fill(false);
  let open = false;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]?.raw ?? '';
    const leadingQuote = /^["“]/.test(raw);
    const trailingQuote = /["”]/.test(raw.slice(1));
    if (leadingQuote) open = true;
    mask[i] = open;
    if (trailingQuote) open = false;
  }
  return mask;
}

function boundedExcerpt(text: string, maxChars = 120): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
}

export { CONTEXTUAL_CONFIRM_CONFIDENCE };
