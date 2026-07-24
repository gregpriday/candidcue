/**
 * §60 low transcript confidence — the detector behind the notice.
 *
 * `requestLogprobs: true` is set on every realtime session, the transport
 * normalizes the provider's log probabilities, and `tokenConfidencesFromLogprobs`
 * turns them into a confidence per normalized word. Everything downstream of
 * that already consumes the numbers: the semantic filter widens its measurement
 * variance when they are low, so following genuinely gets vaguer while the
 * recogniser is struggling. The one thing missing was telling the presenter, and
 * `TranscriptFeedStatus` has had a `'low_confidence'` member with no producer.
 *
 * This module is that producer, and it exists as its own pure unit because the
 * hard part is not detecting weak confidence — it is NOT firing.
 *
 * ## Why the evidence is read here rather than signalled out of the worker
 *
 * The per-token confidences are attached inside the tracking worker's ledger,
 * but the raw `logprobs` they are derived from ride on the very `completed`
 * transcript event the control window forwards INTO the worker
 * (`voice-session.ts` → `session.ts` → `driver.feedTranscript`). The evidence is
 * therefore already in the control window one step before the worker sees it,
 * and reading it here needs no new worker protocol message, no new field on
 * `TrackingSnapshot`, and no change to the alignment engine. The same exported
 * mapping function the worker's ledger uses is reused verbatim, so the two sides
 * cannot drift.
 *
 * The one thing the worker knows that this side does not is which items the
 * command channel consumed. That is handled by `forget()`: the router masks
 * items before the tracking event is forwarded, so the session store retracts
 * them from the window rather than judging the recogniser on a wake phrase.
 *
 * ## Thresholds and hysteresis
 *
 * §60 is about a SUSTAINED degradation. A notice that flickers on every hard
 * proper noun is worse than no notice at all, so four independent gates must all
 * be satisfied before the notice can appear:
 *
 *  1. a rolling window of the most recent `windowTokens` (40) confidence-bearing
 *     word tokens — long enough that one unlucky word moves the mean by ~0.02;
 *  2. at least `minTokens` (24) tokens in that window, so a verdict is never
 *     reached on a fragment;
 *  3. at least `minItems` (3) distinct finalized commits contributing, so one
 *     mangled utterance is not "sustained" no matter how long it was;
 *  4. at least `minSpanMs` (4 s) of wall time between the oldest and newest
 *     contributing item, so three rapid-fire short commits do not qualify either.
 *
 * On top of that the trigger is a Schmitt trigger, not a threshold: it ENTERS
 * below a mean of 0.60 and only LEAVES above 0.75. The dead band between the two
 * is what stops a recogniser hovering around the entry threshold from toggling
 * the notice several times a minute. Recovery is deliberately cheaper than
 * onset — it needs the window and the token minimum, but neither the item count
 * nor the time span — because leaving a stale "following cautiously" notice up
 * after the audio recovered is the failure mode that teaches people to ignore
 * notices.
 *
 * The numbers are calibrated against what `exp(mean logprob)` actually looks
 * like: cleanly recognised speech sits around 0.85–0.95 per word, and a
 * recogniser that is guessing sits around 0.35–0.65. 0.60/0.75 straddles that
 * gap. They are exported and overridable precisely because they are a judgement
 * call rather than a measurement.
 */
import { tokenConfidencesFromLogprobs } from '../../shared/tracking/transcript-confidence';
import type { TokenLogprob } from '../../shared/contracts';

export interface TranscriptConfidenceThresholds {
  /** Rolling window length, in confidence-bearing word tokens. */
  windowTokens: number;
  /** No verdict at all below this many tokens in the window. */
  minTokens: number;
  /** Distinct finalized commits that must contribute before onset. */
  minItems: number;
  /** Wall-clock span the contributing items must cover before onset. */
  minSpanMs: number;
  /** Windowed mean at or below which the notice turns on. */
  enterMean: number;
  /** Windowed mean at or above which the notice turns off. */
  exitMean: number;
}

export const DEFAULT_TRANSCRIPT_CONFIDENCE_THRESHOLDS: TranscriptConfidenceThresholds = {
  windowTokens: 40,
  minTokens: 24,
  minItems: 3,
  minSpanMs: 4000,
  enterMean: 0.6,
  exitMean: 0.75,
};

/** One finalized transcript item, as the tracking event carries it. */
export interface TranscriptConfidenceInput {
  itemId: string;
  text: string;
  logprobs?: readonly TokenLogprob[];
  receivedAtMs: number;
}

/**
 * What the watcher decided this call. `null` means "nothing changed" — the
 * common case, and the caller does nothing with it.
 */
export type TranscriptConfidenceVerdict =
  | { status: 'low_confidence'; detail: string }
  | { status: 'recovered' }
  | null;

interface WindowEntry {
  itemId: string;
  atMs: number;
  confidences: number[];
}

/**
 * Rolling ASR-confidence watcher for one take. Construct per session; the
 * session store owns the instance and the reporting.
 */
export class TranscriptConfidenceWatch {
  private readonly thresholds: TranscriptConfidenceThresholds;
  private entries: WindowEntry[] = [];
  private low = false;

  constructor(thresholds: Partial<TranscriptConfidenceThresholds> = {}) {
    this.thresholds = { ...DEFAULT_TRANSCRIPT_CONFIDENCE_THRESHOLDS, ...thresholds };
  }

  /** True while the watcher believes the recogniser is sustainedly struggling. */
  get degraded(): boolean {
    return this.low;
  }

  /** Tokens currently informing the verdict — diagnostics and tests. */
  get windowSize(): number {
    return this.entries.reduce((sum, entry) => sum + entry.confidences.length, 0);
  }

  /** The windowed mean, or `null` when there is not enough evidence for one. */
  get mean(): number | null {
    const tokens = this.tokens();
    if (tokens.length < this.thresholds.minTokens) return null;
    return tokens.reduce((a, b) => a + b, 0) / tokens.length;
  }

  reset(): void {
    this.entries = [];
    this.low = false;
  }

  /**
   * Retract items the command channel consumed (§33.4). A wake phrase is not
   * evidence about how well the recogniser is hearing the SCRIPT, and the router
   * masks it before the tracking event is forwarded, so the retraction always
   * arrives in time.
   */
  forget(itemIds: readonly string[]): void {
    if (itemIds.length === 0 || this.entries.length === 0) return;
    const drop = new Set(itemIds);
    const kept = this.entries.filter((entry) => !drop.has(entry.itemId));
    if (kept.length === this.entries.length) return;
    this.entries = kept;
  }

  /**
   * Observe one finalized item. Items whose pieces could not be reconciled with
   * their own tokenization contribute NOTHING — not a low reading, not a high
   * one. An unattributable transcript is missing evidence, and treating missing
   * evidence as bad evidence is how a provider that simply does not return
   * logprobs would end up permanently accused of mishearing.
   */
  observe(item: TranscriptConfidenceInput): TranscriptConfidenceVerdict {
    const confidences = tokenConfidencesFromLogprobs(item.text, item.logprobs);
    if (confidences === undefined || confidences.length === 0) return null;

    // An item already seen (a re-delivered commit) replaces itself rather than
    // being counted twice.
    this.entries = this.entries.filter((entry) => entry.itemId !== item.itemId);
    this.entries.push({ itemId: item.itemId, atMs: item.receivedAtMs, confidences });
    this.trim();
    return this.evaluate();
  }

  /** Drop the oldest entries until the window fits `windowTokens`. */
  private trim(): void {
    let total = this.windowSize;
    while (this.entries.length > 1 && total > this.thresholds.windowTokens) {
      const oldest = this.entries[0];
      if (oldest === undefined) break;
      // Keep the newest entry whole even when it alone overflows the window:
      // truncating the item we are judging on would bias the mean toward
      // whichever end of the sentence happened to survive.
      total -= oldest.confidences.length;
      this.entries.shift();
    }
  }

  private tokens(): number[] {
    const out: number[] = [];
    for (const entry of this.entries) out.push(...entry.confidences);
    return out;
  }

  private evaluate(): TranscriptConfidenceVerdict {
    const t = this.thresholds;
    const tokens = this.tokens();
    if (tokens.length < t.minTokens) return null;
    const mean = tokens.reduce((a, b) => a + b, 0) / tokens.length;

    if (this.low) {
      // Recovery: window + token floor only. Deliberately cheaper than onset.
      if (mean >= t.exitMean) {
        this.low = false;
        return { status: 'recovered' };
      }
      return null;
    }

    if (mean > t.enterMean) return null;
    if (this.entries.length < t.minItems) return null;
    const first = this.entries[0];
    const last = this.entries[this.entries.length - 1];
    if (first === undefined || last === undefined) return null;
    if (last.atMs - first.atMs < t.minSpanMs) return null;

    this.low = true;
    return {
      status: 'low_confidence',
      // Banded, never a percentage (companion §3, §49): the number is an
      // uncalibrated model score and quoting it to two decimals would claim a
      // precision it does not have.
      detail: 'the last few seconds came back weakly',
    };
  }
}
