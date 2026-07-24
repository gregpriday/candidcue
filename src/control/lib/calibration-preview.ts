/**
 * §30.3 calibration preview — the pure half.
 *
 * ---------------------------------------------------------------------------
 * §12.7.4 — THERE IS NO ABSOLUTE LOUDNESS MEASUREMENT HERE.
 * ---------------------------------------------------------------------------
 * Without a calibrated microphone and a known distance, CandidCue measures
 * *relative digital level*, not sound pressure. Nothing in this module returns
 * a decibel figure and nothing in it may be rendered as one. `rms`, `peak` and
 * `noiseFloor` on an `AudioLevelSnapshot` are 0–1 digital magnitudes; they are
 * converted into words and into a 0–100 percentage of the meter, and never
 * into "you are speaking at 68 dB".
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS SHOWN THAT IS NOT MEASURED.
 * ---------------------------------------------------------------------------
 * Every reading is `null` until the evidence for it exists, and the preview
 * renders the honest sentence instead. In particular:
 *
 * - sample pace needs both enough voiced time and enough words, because
 *   dividing four words by 1.2 seconds produces a confident-looking 200 wpm
 *   that describes nothing;
 * - pitch confidence and vocal variety need a pitch source, and the control
 *   window's audio seam (`VoiceFacade.observeLevels`) does not carry one. The
 *   preview therefore says it is not measured here rather than deriving a
 *   plausible-looking number from loudness — §17.5 is explicit that a variety
 *   score must not be fabricated from the remaining features when pitch
 *   reliability is insufficient.
 *
 * The whole preview is optional and advisory: §30.3 says live adaptation
 * remains authoritative, so nothing here may gate starting a session.
 */
import type { AudioLevelSnapshot } from '../../shared/contracts';

export interface CalibrationState {
  /** Voiced time accumulated from the level stream, milliseconds. */
  speakingMs: number;
  /** Wall time the preview has been listening, milliseconds. */
  listeningMs: number;
  /** Highest RMS seen, 0–1 relative digital magnitude. Never a dB SPL figure. */
  peakRms: number;
  /** Slowly-tracked quiet-time magnitude, 0–1 relative. */
  noiseFloor: number;
  /** Latched: a clip anywhere in the sample is worth reporting for the sample. */
  everClipped: boolean;
  /** Frames observed, so "no signal at all" is distinguishable from "not started". */
  frames: number;
  lastFrameAtMs: number | null;
}

export const INITIAL_CALIBRATION: CalibrationState = {
  speakingMs: 0,
  listeningMs: 0,
  peakRms: 0,
  noiseFloor: 0,
  everClipped: false,
  frames: 0,
  lastFrameAtMs: null,
};

/**
 * Frames arrive about every 90 ms. A gap larger than this is a stall, a tab
 * throttle or a device change — counting it as speech would inflate the
 * sample's voiced time and deflate the pace it implies.
 */
const MAX_FRAME_GAP_MS = 400;

export function reduceCalibration(
  state: CalibrationState,
  level: AudioLevelSnapshot,
): CalibrationState {
  const previous = state.lastFrameAtMs;
  const rawDelta = previous === null ? 0 : level.generatedAtMs - previous;
  const delta = rawDelta > 0 && rawDelta <= MAX_FRAME_GAP_MS ? rawDelta : 0;
  return {
    speakingMs: state.speakingMs + (level.speaking ? delta : 0),
    listeningMs: state.listeningMs + delta,
    peakRms: Math.max(state.peakRms, level.rms),
    // The monitor already reports a noise floor; take the quietest it has
    // claimed, which is the most conservative "this room is this quiet".
    noiseFloor: state.frames === 0 ? level.noiseFloor : Math.min(state.noiseFloor, level.noiseFloor),
    everClipped: state.everClipped || level.clipped,
    frames: state.frames + 1,
    lastFrameAtMs: level.generatedAtMs,
  };
}

/* ---------------------------------------------------------------------------
 * Sample pace (§14.1 articulation WPM)
 * ------------------------------------------------------------------------- */

/** Below this the divisor is too small for the quotient to mean anything. */
export const MIN_SAMPLE_SPEAKING_MS = 5_000;
/** And below this the numerator is. */
export const MIN_SAMPLE_WORDS = 12;

export interface SamplePace {
  /**
   * §14.1 **articulation** WPM: spoken words over active voiced time. It is
   * deliberately not the audible WPM the live rail shows, which includes the
   * pauses; over a short read the two differ enough that presenting this as
   * "your pace" would be a different number wearing the rail's name.
   */
  articulationWpm: number;
  wordCount: number;
  speakingSeconds: number;
}

export function countSampleWords(transcript: string): number {
  return transcript.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The measured sample pace, or `null` when there is not enough of a sample. */
export function samplePace(state: CalibrationState, transcript: string): SamplePace | null {
  const wordCount = countSampleWords(transcript);
  if (state.speakingMs < MIN_SAMPLE_SPEAKING_MS || wordCount < MIN_SAMPLE_WORDS) return null;
  const speakingSeconds = state.speakingMs / 1000;
  return {
    articulationWpm: Math.round((wordCount / speakingSeconds) * 60),
    wordCount,
    speakingSeconds: Math.round(speakingSeconds * 10) / 10,
  };
}

/** What the preview says while the sample is still too thin. */
export function samplePaceShortfall(state: CalibrationState, transcript: string): string {
  const words = countSampleWords(transcript);
  if (state.frames === 0) return 'Start the microphone test and read a few sentences.';
  if (state.speakingMs < MIN_SAMPLE_SPEAKING_MS) {
    const remaining = Math.ceil((MIN_SAMPLE_SPEAKING_MS - state.speakingMs) / 1000);
    return `Keep reading — about ${remaining} more second${remaining === 1 ? '' : 's'} of speech.`;
  }
  const remaining = MIN_SAMPLE_WORDS - words;
  return `Keep reading — ${remaining} more word${remaining === 1 ? '' : 's'} in the transcript.`;
}

/* ---------------------------------------------------------------------------
 * Relative level and room description (§12.7.4)
 * ------------------------------------------------------------------------- */

export type LevelVerdict = 'no_signal' | 'very_quiet' | 'quiet' | 'good' | 'hot' | 'clipping';

export function levelVerdict(state: CalibrationState, live: AudioLevelSnapshot | null): LevelVerdict {
  if (state.frames === 0) return 'no_signal';
  if (state.everClipped || live?.clipped) return 'clipping';
  if (state.peakRms < 0.02) return 'no_signal';
  if (state.peakRms < 0.08) return 'very_quiet';
  if (state.peakRms < 0.18) return 'quiet';
  if (state.peakRms > 0.85) return 'hot';
  return 'good';
}

/** Words only. Never a number with `dB` after it (§12.7.4). */
export const LEVEL_LABEL: Record<LevelVerdict, string> = {
  no_signal: 'No signal',
  very_quiet: 'Very quiet',
  quiet: 'Quiet',
  good: 'Good level',
  hot: 'Hot',
  clipping: 'Clipping',
};

export const LEVEL_ADVICE: Record<LevelVerdict, string> = {
  no_signal: 'Nothing is reaching the microphone yet.',
  very_quiet: 'Move closer, or raise the input gain in your system sound settings.',
  quiet: 'Usable, but a little more level would help filler detection.',
  good: 'This is a good working level.',
  hot: 'Close to the ceiling. Back off slightly or lower the input gain.',
  clipping: 'The signal hit the ceiling and distorted. Lower the input gain.',
};

export type RoomVerdict = 'unknown' | 'quiet' | 'some_background' | 'noisy';

/**
 * How far the speaking level sits above the quiet-time level — a *ratio* of two
 * relative magnitudes, which is a legitimate comparison, unlike either
 * magnitude on its own.
 */
export function headroomRatio(state: CalibrationState): number | null {
  if (state.frames === 0 || state.peakRms <= 0) return null;
  if (state.noiseFloor <= 0.0005) return null;
  return state.peakRms / state.noiseFloor;
}

export function roomVerdict(state: CalibrationState): RoomVerdict {
  const ratio = headroomRatio(state);
  if (ratio === null) return state.frames === 0 ? 'unknown' : 'quiet';
  if (ratio >= 12) return 'quiet';
  if (ratio >= 5) return 'some_background';
  return 'noisy';
}

export const ROOM_LABEL: Record<RoomVerdict, string> = {
  unknown: 'Not measured yet',
  quiet: 'Quiet room',
  some_background: 'Some background sound',
  noisy: 'Noisy — your voice is close to the room',
};

/* ---------------------------------------------------------------------------
 * The readings this preview cannot take
 * ------------------------------------------------------------------------- */

/**
 * §13, §17.5. Pitch confidence and vocal variety need a pitch estimator on the
 * raw audio, and the control window's audio seam does not expose one: the voice
 * facade offers `observeLevels`, whose snapshot carries loudness only.
 *
 * This constant is what the preview says instead of a number. It is deliberately
 * a sentence and not a dash — a dash reads as "zero" to some people, and a
 * fabricated zero is exactly the failure §17.5 forbids.
 */
export const PITCH_NOT_MEASURED_HERE =
  'Not measured in this preview — it needs the pitch analyzer, which runs during a take. Vocal variety is measured live and appears in the rail once there is enough voiced speech.';

/** Shown when a pitch source IS wired but its confidence is too low to score. */
export const PITCH_CONFIDENCE_TOO_LOW =
  'Pitch is not reliable enough to score variety yet. CandidCue will show a variety reading only once it has evidence for one.';

export type PitchConfidenceVerdict = 'unavailable' | 'too_low' | 'usable' | 'strong';

/**
 * Grade an optional pitch-confidence reading, 0–1.
 *
 * `null` means no pitch source at all, which is a different statement from
 * "the source says it is unsure" — and the preview says the different thing.
 */
export function pitchConfidenceVerdict(confidence: number | null): PitchConfidenceVerdict {
  if (confidence === null || !Number.isFinite(confidence)) return 'unavailable';
  if (confidence < 0.35) return 'too_low';
  if (confidence < 0.7) return 'usable';
  return 'strong';
}

export const PITCH_CONFIDENCE_LABEL: Record<PitchConfidenceVerdict, string> = {
  unavailable: 'Not measured here',
  too_low: 'Too low to score variety',
  usable: 'Usable',
  strong: 'Strong',
};
