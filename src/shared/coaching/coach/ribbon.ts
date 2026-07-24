/**
 * §10 / §27.4. The producer of {@link CoachRibbonEvent}.
 *
 * The stage renderer implements all eight ribbon shapes and the control side
 * bounds the array — but nothing constructed a ribbon event of any type, so the
 * rail rendered an empty ribbon and would have done so forever. Rule 1a in the
 * contract assigns `CoachRibbonEvent` to `coaching/coach`; this is it.
 *
 * ---------------------------------------------------------------------------
 * THE RIBBON IS TIME-INDEXED (§27.4)
 * ---------------------------------------------------------------------------
 * "Where recently did that happen?" — not "which line was it on". Every event
 * here carries an audio-clock `[startMs, endMs]` and nothing else positional.
 * The script-indexed view is {@link CoachGutterMark}, produced separately in
 * `gutter-marks.ts`; the two are not substitutable and neither is derived from
 * the other.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY AND MAY NOT APPEAR
 * ---------------------------------------------------------------------------
 * §10.4: a late event fades in *at its historical position*. That is why events
 * are stamped with the interval they describe and never with arrival time, and
 * why the same call producing the same input twice produces the same
 * `eventId` — an event revised by a later transcript must update in place
 * rather than appear a second time next to itself.
 *
 * §2.4: a `probable` filler is drawn differently from a `confirmed` one but is
 * still shown, because the ribbon is a *record*, not a verdict. An
 * `authoredIntentional` disfluency is not shown at all: the author asked for it.
 *
 * A dropout is never a pause (§12.4). Pause events therefore come from the
 * caller's cadence lane, which knows the difference, and are never derived here
 * from gaps between speech intervals — a gap can be a dropout, and feeding
 * dropouts into the ribbon would put a "pause" tick on the glass for a buffer
 * underrun.
 */
import type {
  CoachRibbonEvent,
  CoachRibbonEventType,
  FillerEvent,
  SpeechInterval,
} from '../../contracts/coaching';

/** §10. One pause the cadence lane measured, not a gap someone inferred. */
export interface RibbonPauseInput {
  startMs: number;
  endMs: number;
  takePassId: string;
  /** 0–1 confidence that this was a delivered pause rather than an artefact. */
  confidence?: number;
}

/** §10. A retake the take machinery committed. */
export interface RibbonRetakeInput {
  startMs: number;
  endMs: number;
  takePassId: string;
}

/** §10. A critical fidelity discrepancy the comparator or Luna confirmed. */
export interface RibbonCriticalInput {
  evidenceId: string;
  startMs: number;
  endMs: number;
  takePassId: string;
  confidence: number;
}

/** §12.7.1. A sustained clipping episode from the microphone lane. */
export interface RibbonClippingInput {
  startMs: number;
  endMs: number;
  takePassId: string;
}

export interface RibbonInputs {
  /** Closed VAD runs (§12.5). Open runs are not drawn: they have no end yet. */
  speechIntervals?: readonly SpeechInterval[];
  /** Every detected disfluency; kind and confidence decide what is drawn. */
  fillers?: readonly FillerEvent[];
  pauses?: readonly RibbonPauseInput[];
  retakes?: readonly RibbonRetakeInput[];
  criticalMismatches?: readonly RibbonCriticalInput[];
  clipping?: readonly RibbonClippingInput[];
}

/**
 * The minimum width a zero-length event is drawn with, ms.
 *
 * A clipping episode or a critical mismatch can be stamped with a single
 * instant. Left at zero width the stage draws nothing at all, so the event is
 * silently missing rather than visibly small.
 */
export const RIBBON_MIN_EVENT_MS = 60;

/**
 * Which ribbon shape a disfluency takes, or `null` when it is not drawn.
 *
 * `repetitive_opener` is absent on purpose. §15.3 makes it a session pattern
 * rather than an event, and §2.4 is explicit that a normal word must not be
 * marked as a disfluency on the glass; a tick beside "and" would be exactly
 * that.
 */
export function ribbonTypeForFiller(event: FillerEvent): CoachRibbonEventType | null {
  // §15.5: the author wrote this disfluency deliberately. Never counted, never
  // drawn.
  if (event.authoredIntentional) return null;
  if (event.confidence === 'rejected') return null;

  switch (event.kind) {
    case 'strict_vocalized':
    case 'contextual':
      return event.confidence === 'confirmed' ? 'confirmed_filler' : 'probable_filler';
    case 'repeated_word':
    case 'false_start':
    case 'self_correction':
      // §10: restarts and repetitions share the `repetition` shape. Only a
      // settled one is drawn; a probable restart is usually a transcript
      // artefact.
      return event.confidence === 'confirmed' ? 'repetition' : null;
    case 'repetitive_opener':
      return null;
  }
}

/**
 * Build the ribbon for one take pass.
 *
 * Pure: the same inputs give the same events, in the same order, with the same
 * ids. Windowing and the hard count cap belong to `boundRibbon` in
 * `coach-state.ts` — the producer's job is to say what happened, and the
 * builder's is to decide how much of it fits.
 */
export function buildRibbonEvents(
  inputs: RibbonInputs,
  takePassId: string,
): CoachRibbonEvent[] {
  const out: CoachRibbonEvent[] = [];

  const push = (
    type: CoachRibbonEventType,
    idSeed: string,
    startMs: number,
    endMs: number,
    confidence: number,
  ): void => {
    out.push({
      eventId: `ribbon:${type}:${idSeed}`,
      type,
      startMs,
      endMs: Math.max(endMs, startMs + RIBBON_MIN_EVENT_MS),
      confidence,
      takePassId,
    });
  };

  for (const interval of inputs.speechIntervals ?? []) {
    if (interval.takePassId !== takePassId) continue;
    if (interval.endMs <= interval.startMs) continue;
    push('speech', `${Math.round(interval.startMs)}`, interval.startMs, interval.endMs, 1);
  }

  for (const filler of inputs.fillers ?? []) {
    if (filler.takePassId !== takePassId) continue;
    const type = ribbonTypeForFiller(filler);
    if (type === null) continue;
    // The event id is the *filler's*, so a later revision — a demotion from
    // confirmed to probable, say — replaces the tick rather than adding one
    // beside it (§10.4).
    push(
      type,
      filler.eventId,
      filler.audioStartMs,
      filler.audioEndMs,
      // The ribbon's confidence is about the *detection*, and §16.5's ladder is
      // three-state; mapping it to a number here keeps the stage from having to
      // know the ladder exists.
      filler.confidence === 'confirmed' ? 1 : 0.5,
    );
  }

  for (const pause of inputs.pauses ?? []) {
    if (pause.takePassId !== takePassId) continue;
    push('pause', `${Math.round(pause.startMs)}`, pause.startMs, pause.endMs, pause.confidence ?? 1);
  }

  for (const retake of inputs.retakes ?? []) {
    if (retake.takePassId !== takePassId) continue;
    push('retake', `${Math.round(retake.startMs)}`, retake.startMs, retake.endMs, 1);
  }

  for (const mismatch of inputs.criticalMismatches ?? []) {
    if (mismatch.takePassId !== takePassId) continue;
    push(
      'critical_mismatch',
      mismatch.evidenceId,
      mismatch.startMs,
      mismatch.endMs,
      mismatch.confidence,
    );
  }

  for (const episode of inputs.clipping ?? []) {
    if (episode.takePassId !== takePassId) continue;
    push('clipping', `${Math.round(episode.startMs)}`, episode.startMs, episode.endMs, 1);
  }

  out.sort((a, b) => (a.startMs === b.startMs ? a.type.localeCompare(b.type) : a.startMs - b.startMs));
  return out;
}
