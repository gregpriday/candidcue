/**
 * The voice pill — "CandidCue is picking up what you say", in the corner of the
 * stage.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHY
 * ---------------------------------------------------------------------------
 * There was a full-screen microphone check here: it opened its own capture
 * between the stage going full screen and the transport opening, and it refused
 * to start the take until it had heard a voice it approved of.
 *
 * It was too eager to be believed. Two and a half seconds of silence — which is
 * how long it takes to read the sentence asking you to speak — and it announced
 * that it could not hear the microphone. One clipped frame, the plosive at the
 * front of "testing", and it announced that you were too loud. Both readings
 * were about a rig that was working perfectly, delivered at teleprompter scale,
 * in front of a script the presenter was not allowed to start.
 *
 * A gate has to be right about a microphone in a couple of seconds or it is
 * worse than nothing. A readout does not: it can be patient, because it is not
 * standing in anybody's way. So the take starts immediately and this watches
 * it — the waveform moves while it listens, a tick lands when recogniser text
 * comes back, a cross appears if the audio or the transcription stops. It
 * proves the same thing the check was trying to prove, and it proves it with
 * the real session rather than with a rehearsal of one.
 *
 * ---------------------------------------------------------------------------
 * THE TWO FAULTS IT CAN ACTUALLY SEE
 * ---------------------------------------------------------------------------
 * Deliberately few, because every fault state is an interruption:
 *
 *   • no audio — the input is gone (§28.6 reports it), the level frames have
 *     stopped arriving, or none ever did;
 *   • not heard — several seconds of SPEECH have gone by with no recogniser
 *     text at all. That is the failure this whole idea exists for: the mic
 *     works, the meter moves, and the script does not follow because nothing is
 *     coming back off the socket.
 *
 * What it deliberately does NOT report: quiet audio, hot audio, gaps between
 * words. Those are Preflight's job, on a screen with room to explain them, and
 * the presenter mid-take can act on none of them.
 *
 * Pure and time-injected, so the decision — which is the part that can be
 * subtly wrong — is unit-testable without a microphone or a wall clock. The
 * orchestration that owns the level feed and the publish timer lives in
 * `stores/session.ts`.
 */
import {
  STAGE_VOICE_PILL_TRACE_SAMPLES,
  type AudioLevelSnapshot,
  type StageVoicePillReading,
} from '../../../shared/contracts';
import { METER_REFERENCE_PEAK, PEAK_HOLD_MS } from '../../components/mic-advice';

/** Bars in the trace. Sized on the contract; see the note there. */
export const VOICE_PILL_TRACE_SAMPLES = STAGE_VOICE_PILL_TRACE_SAMPLES;

/**
 * How long the pill stays up after it confirms, before it fades away.
 *
 * The presenter has to actually SEE the tick or the confirmation is worth
 * nothing — and they are reading, so it has to survive a glance that may not
 * come immediately. Two and a half seconds is long enough to catch in
 * peripheral vision and short enough that it is gone before the second
 * sentence.
 */
export const VOICE_PILL_CONFIRM_HOLD_MS = 2500;

/**
 * How much SPEECH may arrive with nothing coming back before that is a fault.
 *
 * Measured in speech, not in elapsed time, so a presenter collecting their
 * thoughts is never accused of anything: the clock only runs while they are
 * talking. Four seconds is far longer than the ~1.2–1.7 s Inworld takes to
 * finalise an utterance and longer than the ~1 s its first partial takes, so a
 * healthy session confirms itself several times over before this can trip.
 */
export const VOICE_PILL_UNHEARD_SPEECH_MS = 4000;

/**
 * How long a gap in the level frames means the capture has died.
 *
 * Frames arrive at ~90 ms whether or not anyone is speaking — the monitor reads
 * the analyser on a timer, so silence still produces frames. A gap this long is
 * therefore not a quiet room, it is a graph that has stopped being pulled.
 */
export const VOICE_PILL_STALE_FRAME_MS = 2500;

/**
 * How long to wait for the FIRST frame before reporting no audio.
 *
 * Longer than the stale bound above, because this window contains
 * `getUserMedia` (~900 ms uncontended, and slower behind a permission prompt)
 * plus the analyser graph coming up. Reporting a fault while the device is
 * still being acquired would put a cross on the screen of every take that
 * started slowly.
 */
export const VOICE_PILL_NO_CAPTURE_MS = 8000;

/**
 * Longest gap between frames that still counts as continuous speech.
 *
 * A stalled stream must not be able to buy the unheard threshold with a handful
 * of surviving frames seconds apart: time between frames that never arrived is
 * not time anybody spoke. Capping the credit at ~3 frames makes a stall
 * contribute almost nothing instead of everything.
 */
const MAX_FRAME_CREDIT_MS = 280;

/** Why the pill is showing a cross. */
export type VoicePillFault = 'no_audio' | 'not_heard' | 'offline';

/** What the session knows that the level frames cannot say on their own. */
export interface VoicePillConditions {
  /**
   * §28.6 — the DEVICE is gone: unplugged, muted in hardware, refused.
   *
   * Deliberately NOT the session's `inputDeviceLost` flag, which is also raised
   * by `SilentInputDetector` after five seconds without signal. Wiring that
   * here put the old microphone check's worst behaviour straight back on the
   * stage: a presenter who pauses to think in a quiet room hits five seconds of
   * silence easily, and the app would answer with a cross and "No audio" about
   * a microphone that was working perfectly. Silence is not a fault. Only a
   * device that has actually gone is.
   */
  deviceLost: boolean;
  /**
   * The transcription transport is down for good (not merely reconnecting).
   *
   * Without it a pill that had already confirmed and faded would stay silently
   * confirmed through a dead socket until four more seconds of speech happened
   * to accumulate — and if the presenter stopped before that, forever.
   * Reconnecting is deliberately excluded: it is usually over in a second, and
   * the Live status line already reports it.
   */
  transportOffline: boolean;
  /**
   * The take is paused, so audio is deliberately not being transcribed.
   *
   * Load-bearing: a soft pause captures audio and stops sending it, so a
   * presenter who pauses and keeps talking would otherwise accumulate the
   * unheard threshold and be told the app cannot hear them — while the app was
   * doing exactly what they asked.
   */
  suspended: boolean;
}

export interface VoicePillState {
  /** Waveform trace, oldest first. */
  levels: number[];
  /** Decaying peak hold, so the trace is drawn against a live reference. */
  peak: number;
  peakAtMs: number;
  /** `generatedAtMs` of the last accepted frame; null before the first. */
  lastFrameAtMs: number | null;
  /** Speech that has arrived since the last recogniser text (see the constant). */
  speechSinceTextMs: number;
  /** True once any non-empty recogniser text has arrived this take. */
  heardText: boolean;
  /** The resolved reading, updated by {@link tickVoicePill}. */
  reading: StageVoicePillReading;
  fault: VoicePillFault | null;
  /** When the reading last BECAME 'confirmed'; -Infinity while it is not. */
  confirmedAtMs: number;
  /** Whether the last tick found the take paused (see {@link voicePillVisible}). */
  suspended: boolean;
  /** When the take started, for the first-frame window. */
  startedAtMs: number;
}

export function initialVoicePillState(startedAtMs: number): VoicePillState {
  return {
    levels: [],
    peak: 0,
    peakAtMs: -Infinity,
    lastFrameAtMs: null,
    speechSinceTextMs: 0,
    heardText: false,
    reading: 'listening',
    fault: null,
    confirmedAtMs: -Infinity,
    suspended: false,
    startedAtMs,
  };
}

/**
 * Fold one level frame in.
 *
 * `nowMs` is the frame's own `generatedAtMs` at every real call site; it is a
 * parameter so tests can drive the hold windows without waiting for them, and
 * it must be the same monotonic clock every other timestamp here is on.
 */
export function reduceVoicePillLevel(
  state: VoicePillState,
  level: AudioLevelSnapshot,
  nowMs: number,
): VoicePillState {
  /*
   * A frame carrying NaN or Infinity is not a quiet microphone, it is a broken
   * reading, and folding it in poisons the peak hold, the trace and the
   * timestamps at once (NaN compares false against every threshold, so it
   * silently disables them rather than tripping them). Dropped WITHOUT
   * advancing `lastFrameAtMs`, so a stream producing nothing but garbage ages
   * into a fault instead of looking healthy forever.
   */
  if (!Number.isFinite(level.rms) || !Number.isFinite(level.peak) || !Number.isFinite(nowMs)) {
    return state;
  }
  /*
   * Frames must arrive in order. An out-of-order one would rewrite
   * `lastFrameAtMs` backwards, which both hands the next frame an inflated gap
   * and makes a live stream look stale.
   */
  if (state.lastFrameAtMs !== null && nowMs < state.lastFrameAtMs) return state;

  const gap = state.lastFrameAtMs === null ? 0 : nowMs - state.lastFrameAtMs;
  const credit = gap > 0 && gap <= MAX_FRAME_CREDIT_MS ? gap : 0;

  const expired = nowMs - state.peakAtMs > PEAK_HOLD_MS;
  const rising = level.peak >= state.peak;
  const peak = expired || rising ? level.peak : state.peak;
  const peakAtMs = expired || rising ? nowMs : state.peakAtMs;

  /*
   * The trace is drawn against the held peak, exactly as the Preflight meter is
   * (see METER_REFERENCE_PEAK): raw RMS from an ordinary microphone at
   * conversational distance sits around 0.05–0.15, and a waveform drawn from
   * that directly is a flat line that says "we cannot hear you" while the
   * microphone is working perfectly. The floor stops a dead input being
   * amplified into a healthy-looking trace. This changes what is DRAWN, never
   * what is judged.
   */
  const reference = Math.max(METER_REFERENCE_PEAK, peak);
  const amplitude =
    Number.isFinite(reference) && reference > 0
      ? Math.min(1, Math.max(0, level.rms) / reference)
      : 0;

  return {
    ...state,
    levels: [...state.levels, amplitude].slice(-VOICE_PILL_TRACE_SAMPLES),
    peak,
    peakAtMs,
    lastFrameAtMs: nowMs,
    speechSinceTextMs: state.speechSinceTextMs + (level.speaking ? credit : 0),
  };
}

/**
 * Fold recogniser text in — the only evidence that can confirm anything.
 *
 * Partials count. A partial means the audio reached the model and the model
 * answered, which is the entire claim being made; waiting for a final would
 * hold the tick back by another second for no additional proof.
 *
 * Empty text is not evidence: the transport emits empty partials while an
 * utterance is opening, and treating those as words coming back would confirm a
 * session that has transcribed nothing.
 */
export function reduceVoicePillText(state: VoicePillState, text: string): VoicePillState {
  if (text.trim().length === 0) return state;
  return { ...state, heardText: true, speechSinceTextMs: 0 };
}

/** Which fault, if any, the evidence supports right now. */
function resolveFault(
  state: VoicePillState,
  conditions: VoicePillConditions,
  nowMs: number,
): VoicePillFault | null {
  if (conditions.deviceLost) return 'no_audio';
  const sinceFrameMs =
    state.lastFrameAtMs === null ? nowMs - state.startedAtMs : nowMs - state.lastFrameAtMs;
  const bound =
    state.lastFrameAtMs === null ? VOICE_PILL_NO_CAPTURE_MS : VOICE_PILL_STALE_FRAME_MS;
  if (sinceFrameMs >= bound) return 'no_audio';
  if (conditions.transportOffline) return 'offline';
  if (state.speechSinceTextMs >= VOICE_PILL_UNHEARD_SPEECH_MS) return 'not_heard';
  return null;
}

/**
 * Resolve the reading. Called on the publish cadence, not per frame.
 *
 * The cadence matters: the case that matters most is the one where level frames
 * never arrive at all — permission refused below the app, the device pulled,
 * another process holding the input — and a reading derived only from frames
 * would report "listening" forever during exactly that failure.
 */
export function tickVoicePill(
  state: VoicePillState,
  conditions: VoicePillConditions,
  nowMs: number,
): VoicePillState {
  /*
   * A pause FREEZES the pill rather than resolving it.
   *
   * Nothing is being transcribed because the presenter asked for nothing to be
   * transcribed, so there is no reading to take — and resolving one anyway had
   * a nasty second-order effect: a fault that cleared while the pill was hidden
   * would spend its whole confirm-hold behind a pause, so the presenter came
   * back from a ten-second break to no indication that the thing that had
   * broken was fixed. Freezing keeps the pre-pause reading intact, so the
   * transition — and the tick that announces it — happens where it can be seen.
   *
   * The unheard clock is not merely stopped but reset: speech that arrived
   * during a pause was never going to be transcribed, and carrying it forward
   * would fault the session moments after it resumed.
   */
  if (conditions.suspended) {
    return { ...state, suspended: true, speechSinceTextMs: 0 };
  }

  /*
   * Coming back from a pause is a fresh acquisition, not a stalled one.
   *
   * A hard pause tears the capture down, so on resume there are no frames until
   * the device has been opened again. Judged against the stale-frame bound that
   * reads as a dead microphone and puts a cross on screen for the second or so
   * the pipeline needs — so the first-frame window (which exists for exactly
   * this: waiting on `getUserMedia`) is rebased instead.
   */
  const base: VoicePillState = state.suspended
    ? { ...state, suspended: false, lastFrameAtMs: null, startedAtMs: nowMs, speechSinceTextMs: 0 }
    : state;

  const fault = resolveFault(base, conditions, nowMs);
  const reading: StageVoicePillReading = fault
    ? 'fault'
    : base.heardText
      ? 'confirmed'
      : 'listening';
  /*
   * The hold restarts every time the pill comes BACK to confirmed, which is
   * what makes "fades once proven, returns on trouble" work: a fault brings it
   * on screen, and the recovery is then shown for its own full hold rather than
   * inheriting an expired one and vanishing the instant it is fixed.
   */
  const confirmedAtMs =
    reading !== 'confirmed'
      ? -Infinity
      : base.reading === 'confirmed'
        ? base.confirmedAtMs
        : nowMs;
  return { ...base, reading, fault, confirmedAtMs, suspended: false };
}

/**
 * Whether the pill should be on screen.
 *
 * Everything except a settled confirmation is worth showing. A confirmation is
 * worth showing for as long as it takes to notice and then it is in the way —
 * the stage belongs to the script, and an indicator that never leaves is an
 * indicator nobody reads.
 */
export function voicePillVisible(state: VoicePillState, nowMs: number): boolean {
  /*
   * Nothing at all while the take is paused. The question the pill answers —
   * "is your voice getting through?" — has no answer during a pause, and a
   * hard pause has muted the microphone outright: "Listening" would be a claim
   * about a device that is deliberately switched off. The Live screen owns
   * saying that a take is paused.
   */
  if (state.suspended) return false;
  if (state.reading !== 'confirmed') return true;
  return nowMs - state.confirmedAtMs < VOICE_PILL_CONFIRM_HOLD_MS;
}

/**
 * The reading in words (§20: colour is never the only signal).
 *
 * Short enough to sit inside a pill, and phrased as an observation rather than
 * an instruction — the presenter is mid-take and there is nothing here they are
 * being asked to do.
 */
export function voicePillLabel(state: VoicePillState): string {
  if (state.reading === 'fault') {
    if (state.fault === 'no_audio') return 'No audio';
    return state.fault === 'offline' ? 'Not connected' : 'Not hearing you';
  }
  return state.reading === 'confirmed' ? 'Hearing you' : 'Listening';
}

/** Everything the stage needs to draw, in one pure step. */
export function voicePillView(
  state: VoicePillState,
  nowMs: number,
): { reading: StageVoicePillReading; levels: number[]; label: string; visible: boolean } {
  return {
    reading: state.reading,
    levels: state.levels,
    label: voicePillLabel(state),
    visible: voicePillVisible(state, nowMs),
  };
}
