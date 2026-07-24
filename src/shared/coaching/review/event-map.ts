/**
 * §31.3 timeline: the recorded session laid out on one audio-clock axis, with
 * every event resolvable back to the authored passage it happened in.
 *
 * Three things this module refuses to do, each because the alternative would
 * be a quiet fabrication:
 *
 * - **It never interpolates across a gap.** A series is a list of steps with
 *   explicit `[startMs, endMs)` bounds and a `value` that may be `null`. Two
 *   measured points either side of a dropout stay two measured points; nothing
 *   draws a line through the middle claiming a rate we never observed.
 * - **It never invents an anchor.** An event with no script anchor resolves to
 *   `{ resolved: false }` with a reason. Guessing the passage from the clock
 *   would put a filler on the wrong sentence, which is worse than declining.
 * - **It never offers playback that does not exist.** {@link ReviewTimeline}
 *   carries the recording's availability verbatim from the record; there is no
 *   "try it and see" path and no silent fallback (§31.3).
 *
 * Passes are first-class (§11.3): every event carries its `takePassId` and
 * 1-based `passOrdinal`, and the timeline keeps the pass bounds so a reread
 * sentence shows twice rather than once.
 */
import type { FillerEvent } from '../../contracts/coaching';
import { isCountableFiller } from '../disfluency/types';
import type {
  AudioPlaybackAvailability,
  CoachingSessionRecord,
  ReviewScript,
  ReviewScriptPassage,
  TakePassRecord,
} from './types';

/* ---------------------------------------------------------------------------
 * Tracks
 * ------------------------------------------------------------------------- */

/**
 * §31.3's eight tracks, plus `discrepancies`.
 *
 * The ninth is a deliberate addition, not an oversight in reading the spec:
 * §31.2 makes critical script discrepancies a headline card and §31.4 marks
 * them in the script, so leaving them off the one surface that lets you click
 * an event and jump to the passage would be perverse. They are separated from
 * `tips` because a discrepancy is an observation about the take, while a tip
 * is something the presenter was actually shown.
 */
export type TimelineTrackId =
  | 'speech'
  | 'wpm'
  | 'variety'
  | 'fillers'
  | 'pauses'
  | 'retakes'
  | 'tips'
  | 'script_position'
  | 'discrepancies';

export type TimelineEventKind =
  | 'filler_confirmed'
  | 'filler_probable'
  | 'false_start'
  | 'repeated_word'
  | 'self_correction'
  | 'repetitive_opener'
  | 'pause'
  | 'retake'
  | 'tip'
  | 'critical_mismatch';

/** One clickable mark on the timeline. */
export interface TimelineEvent {
  eventId: string;
  track: TimelineTrackId;
  kind: TimelineEventKind;
  startMs: number;
  /** `>= startMs`. Equal to `startMs` for an instantaneous marker. */
  endMs: number;
  takePassId: string;
  passOrdinal: number;
  scriptAnchorTokenId: string | null;
  spanId: string | null;
  /**
   * Authored, safe label. A filler is only ever quoted through its
   * `displayForm` (§25.3); transcript text and model text never reach here.
   */
  label: string;
  /** 0–1 where the producer supplied one, otherwise `null`. */
  confidence: number | null;
}

/** One step of a series. `value` is `null` for an interval we did not measure. */
export interface TimelineStep {
  startMs: number;
  endMs: number;
  value: number | null;
  /** Milliseconds inside the step that carried a measurement. */
  measuredMs: number;
}

/** Speech-activity segment. Only three kinds, all measured; gaps stay gaps. */
export interface SpeechSegment {
  startMs: number;
  endMs: number;
  kind: 'voiced' | 'pause' | 'unmeasured';
}

/** One sample of the script-position track. */
export interface ScriptPositionPoint {
  atMs: number;
  /** 0–1 progress through the planned path, or `null` while re-acquiring. */
  progress: number | null;
  confidence: number;
  spanId: string | null;
}

export interface TimelinePass {
  takePassId: string;
  passOrdinal: number;
  startMs: number;
  endMs: number;
}

export interface ReviewTimeline {
  startMs: number;
  endMs: number;
  durationMs: number;
  passes: readonly TimelinePass[];
  speech: readonly SpeechSegment[];
  wpm: readonly TimelineStep[];
  variety: readonly TimelineStep[];
  scriptPosition: readonly ScriptPositionPoint[];
  /** All events, ascending by `startMs` then `eventId`. */
  events: readonly TimelineEvent[];
  /** §31.3: playback is offered only when a recording genuinely exists. */
  audio: AudioPlaybackAvailability;
}

export interface TimelineOptions {
  /** §33.3 downsampling bound for the chart series. */
  maxSeriesSteps?: number;
}

export const DEFAULT_MAX_SERIES_STEPS = 240;

/* ---------------------------------------------------------------------------
 * Series
 * ------------------------------------------------------------------------- */

/**
 * §33.3. Collapse a series to at most `maxSteps` buckets by duration-weighted
 * mean of the measured part. A bucket with no measured milliseconds keeps a
 * `null` value rather than borrowing its neighbours', and `measuredMs` is
 * carried so a partially-covered bucket can be drawn as partially covered.
 */
export function downsampleSteps(
  steps: readonly TimelineStep[],
  maxSteps: number = DEFAULT_MAX_SERIES_STEPS,
): TimelineStep[] {
  if (maxSteps <= 0) return [];
  if (steps.length <= maxSteps) return steps.map((step) => ({ ...step }));
  const bucketSize = Math.ceil(steps.length / maxSteps);
  const out: TimelineStep[] = [];
  for (let index = 0; index < steps.length; index += bucketSize) {
    const bucket = steps.slice(index, index + bucketSize);
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (first === undefined || last === undefined) continue;
    let weighted = 0;
    let measuredMs = 0;
    for (const step of bucket) {
      if (step.value === null || step.measuredMs <= 0) continue;
      weighted += step.value * step.measuredMs;
      measuredMs += step.measuredMs;
    }
    out.push({
      startMs: first.startMs,
      endMs: last.endMs,
      value: measuredMs > 0 ? weighted / measuredMs : null,
      measuredMs,
    });
  }
  return out;
}

function paceSteps(passes: readonly TakePassRecord[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  for (const pass of passes) {
    for (const sample of pass.paceSamples) {
      const durationMs = Math.max(0, sample.endMs - sample.startMs);
      steps.push({
        startMs: sample.startMs,
        endMs: sample.endMs,
        value: sample.audibleWpm,
        measuredMs: sample.audibleWpm === null ? 0 : durationMs,
      });
    }
  }
  return steps.sort((a, b) => a.startMs - b.startMs);
}

function varietySteps(passes: readonly TakePassRecord[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  for (const pass of passes) {
    for (const sample of pass.varietySamples) {
      const durationMs = Math.max(0, sample.endMs - sample.startMs);
      steps.push({
        startMs: sample.startMs,
        endMs: sample.endMs,
        value: sample.level,
        measuredMs: sample.level === null ? 0 : durationMs,
      });
    }
  }
  return steps.sort((a, b) => a.startMs - b.startMs);
}

function speechSegments(passes: readonly TakePassRecord[]): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  for (const pass of passes) {
    for (const interval of pass.speechIntervals) {
      segments.push({ startMs: interval.startMs, endMs: interval.endMs, kind: 'voiced' });
    }
    for (const pause of pass.pauses) {
      // A manual or system pause is not delivery; it belongs to the unmeasured
      // lane, not the pause lane (§18.2).
      segments.push({
        startMs: pause.startMs,
        endMs: pause.endMs,
        kind: pause.manual === true ? 'unmeasured' : 'pause',
      });
    }
    for (const span of pass.time.unmeasuredSpans) {
      segments.push({ startMs: span.startMs, endMs: span.endMs, kind: 'unmeasured' });
    }
  }
  return segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function scriptPositionPoints(passes: readonly TakePassRecord[]): ScriptPositionPoint[] {
  const points: ScriptPositionPoint[] = [];
  for (const pass of passes) {
    for (const sample of pass.scriptPositions) {
      points.push({
        atMs: sample.atMs,
        // A re-acquiring cursor is not a position; §14.10 is explicit that a
        // twitching projection is worse than none, and the same applies here.
        progress:
          sample.reacquiring || sample.totalUnits <= 0
            ? null
            : Math.min(1, Math.max(0, sample.cursorUnitIndex / sample.totalUnits)),
        confidence: sample.confidence,
        spanId: sample.spanId,
      });
    }
  }
  return points.sort((a, b) => a.atMs - b.atMs);
}

/* ---------------------------------------------------------------------------
 * Events
 * ------------------------------------------------------------------------- */

const DISFLUENCY_KIND: Partial<Record<FillerEvent['kind'], TimelineEventKind>> = {
  false_start: 'false_start',
  repeated_word: 'repeated_word',
  self_correction: 'self_correction',
  repetitive_opener: 'repetitive_opener',
};

function fillerLabel(event: FillerEvent): string {
  if (event.displayForm !== null) return `“${event.displayForm}”`;
  switch (event.kind) {
    case 'false_start':
      return 'False start';
    case 'repeated_word':
      return 'Repeated word';
    case 'self_correction':
      return 'Self-correction';
    case 'repetitive_opener':
      return 'Repeated opener';
    default:
      return 'Filler';
  }
}

function fillerEvents(pass: TakePassRecord): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const filler of pass.fillers) {
    // §15.5: an authored, intentional disfluency is delivery, not an event.
    if (filler.authoredIntentional) continue;
    if (filler.confidence === 'rejected') continue;

    const mapped = DISFLUENCY_KIND[filler.kind];
    const kind: TimelineEventKind =
      mapped !== undefined
        ? mapped
        : isCountableFiller(filler)
          ? 'filler_confirmed'
          : 'filler_probable';
    if (mapped !== undefined && filler.confidence !== 'confirmed') continue;

    events.push({
      eventId: filler.eventId,
      track: 'fillers',
      kind,
      startMs: filler.audioStartMs,
      endMs: filler.audioEndMs,
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      scriptAnchorTokenId: filler.scriptAnchorTokenId,
      spanId: null,
      label: fillerLabel(filler),
      confidence: filler.timingConfidence,
    });
  }
  return events;
}

function passEvents(pass: TakePassRecord): TimelineEvent[] {
  const events: TimelineEvent[] = [...fillerEvents(pass)];

  pass.pauses.forEach((pause, index) => {
    if (pause.manual === true) return;
    events.push({
      eventId: `pause_${pass.takePassId}_${index}`,
      track: 'pauses',
      kind: 'pause',
      startMs: pause.startMs,
      endMs: pause.endMs,
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      scriptAnchorTokenId: null,
      spanId: null,
      label: 'Pause',
      confidence: null,
    });
  });

  for (const tip of pass.tipsShown) {
    events.push({
      eventId: tip.tipId,
      track: 'tips',
      kind: 'tip',
      startMs: tip.shownAtMs,
      endMs: tip.hiddenAtMs ?? tip.shownAtMs,
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      scriptAnchorTokenId: tip.scriptAnchorTokenId,
      spanId: tip.spanId,
      // The authored catalog code, never model-authored copy (§25).
      label: tip.code,
      confidence: null,
    });
  }

  for (const finding of pass.criticalFindings) {
    events.push({
      eventId: finding.findingId,
      track: 'discrepancies',
      kind: 'critical_mismatch',
      startMs: finding.atMs,
      endMs: finding.endMs,
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      scriptAnchorTokenId: finding.scriptAnchorTokenId,
      spanId: finding.spanId,
      // Authored text may be quoted back under §25.5. The spoken text is not
      // put in a label; it is shown beside the authored text in the detail.
      label: finding.authoredFragment,
      confidence: finding.localConfidence,
    });
  }

  if (pass.passOrdinal > 1) {
    events.push({
      eventId: `retake_${pass.takePassId}`,
      track: 'retakes',
      kind: 'retake',
      startMs: pass.time.startMs,
      endMs: pass.time.startMs,
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      scriptAnchorTokenId: null,
      spanId: pass.coveredSpanIds[0] ?? null,
      label: `Take ${pass.passOrdinal}`,
      confidence: null,
    });
  }

  return events;
}

/* ---------------------------------------------------------------------------
 * Building
 * ------------------------------------------------------------------------- */

/** §31.3. Build the synchronized timeline for a recorded session. */
export function buildTimeline(
  record: CoachingSessionRecord,
  options: TimelineOptions = {},
): ReviewTimeline {
  const passes = [...record.passes].sort((a, b) => a.passOrdinal - b.passOrdinal);
  const maxSteps = options.maxSeriesSteps ?? DEFAULT_MAX_SERIES_STEPS;

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const pass of passes) {
    startMs = Math.min(startMs, pass.time.startMs);
    endMs = Math.max(endMs, pass.time.endMs);
  }
  if (passes.length === 0) {
    startMs = 0;
    endMs = 0;
  }

  const events = passes
    .flatMap(passEvents)
    .sort((a, b) => a.startMs - b.startMs || a.eventId.localeCompare(b.eventId));

  return {
    startMs,
    endMs,
    durationMs: Math.max(0, endMs - startMs),
    passes: passes.map((pass) => ({
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      startMs: pass.time.startMs,
      endMs: pass.time.endMs,
    })),
    speech: speechSegments(passes),
    wpm: downsampleSteps(paceSteps(passes), maxSteps),
    variety: downsampleSteps(varietySteps(passes), maxSteps),
    scriptPosition: scriptPositionPoints(passes),
    events,
    audio: record.audio,
  };
}

/** Events on one track, in timeline order. */
export function eventsOnTrack(
  timeline: ReviewTimeline,
  track: TimelineTrackId,
): TimelineEvent[] {
  return timeline.events.filter((event) => event.track === track);
}

/** Events belonging to one take pass — §11.3's "show all passes, separately". */
export function eventsForPass(timeline: ReviewTimeline, takePassId: string): TimelineEvent[] {
  return timeline.events.filter((event) => event.takePassId === takePassId);
}

/* ---------------------------------------------------------------------------
 * Script selection (§31.3 "clicking an event selects the aligned passage")
 * ------------------------------------------------------------------------- */

export interface PassageIndex {
  bySpanId: ReadonlyMap<string, ReviewScriptPassage>;
  byTokenId: ReadonlyMap<string, ReviewScriptPassage>;
}

export function buildPassageIndex(script: ReviewScript): PassageIndex {
  const bySpanId = new Map<string, ReviewScriptPassage>();
  const byTokenId = new Map<string, ReviewScriptPassage>();
  for (const passage of script.passages) {
    bySpanId.set(passage.spanId, passage);
    for (const tokenId of passage.tokenIds) byTokenId.set(tokenId, passage);
  }
  return { bySpanId, byTokenId };
}

export interface ScriptSelection {
  eventId: string;
  takePassId: string;
  passOrdinal: number;
  passage: ReviewScriptPassage;
}

export type SelectionResult =
  | { resolved: true; selection: ScriptSelection }
  | {
      resolved: false;
      reason: 'unknown_event' | 'no_script_anchor' | 'anchor_not_in_script';
    };

/**
 * Resolve a timeline event to the authored passage it happened in.
 *
 * Returns a reason rather than a guess. An unlocalized filler (§16.3.4) has no
 * anchor by design — it is still counted, and it still appears on the timeline,
 * but it may not be dropped onto a sentence it might not belong to.
 */
export function selectPassageForEvent(
  timeline: ReviewTimeline,
  index: PassageIndex,
  eventId: string,
): SelectionResult {
  const event = timeline.events.find((candidate) => candidate.eventId === eventId);
  if (event === undefined) return { resolved: false, reason: 'unknown_event' };

  const bySpan = event.spanId === null ? undefined : index.bySpanId.get(event.spanId);
  const byToken =
    event.scriptAnchorTokenId === null
      ? undefined
      : index.byTokenId.get(event.scriptAnchorTokenId);
  const passage = bySpan ?? byToken;

  if (passage === undefined) {
    const hadAnchor = event.spanId !== null || event.scriptAnchorTokenId !== null;
    return { resolved: false, reason: hadAnchor ? 'anchor_not_in_script' : 'no_script_anchor' };
  }
  return {
    resolved: true,
    selection: {
      eventId: event.eventId,
      takePassId: event.takePassId,
      passOrdinal: event.passOrdinal,
      passage,
    },
  };
}
