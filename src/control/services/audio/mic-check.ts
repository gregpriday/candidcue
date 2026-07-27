/**
 * The microphone check that stands between full screen and the first word.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Every failure this product has shipped in the "it just sat there" family has
 * the same shape: the take opened, the transport connected, and the microphone
 * was not delivering audio. The presenter reads a paragraph to a script that
 * never moves, and the only thing the app eventually says is that voice
 * tracking is unavailable — which is both true and useless, because by then
 * the take is already ruined and the cause is three layers away.
 *
 * The Preflight screen has had a level meter for a long time and it did not
 * fix this, for a reason worth writing down: nobody looks at it. It sits on a
 * page full of readiness rows, above a button whose whole purpose is to be
 * pressed, and it is perfectly possible — normal, even — to press that button
 * without ever having made a sound. The meter proves the microphone works only
 * for someone who already suspected it might not.
 *
 * So the check moved to the one place it cannot be skipped past: the stage,
 * full screen, after the surface the presenter will read from is already in
 * front of them and before anything billable has opened. It asks for the one
 * thing a meter cannot ask for — say something — and it does not let the take
 * start until it has heard it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It is a LOCAL signal check. It does not open a transcription session, and it
 * therefore proves nothing about the Inworld key, the network, or the model —
 * Preflight's transcription test already exists for that and it costs money to
 * run. This check is free, instant, and catches the fault that actually
 * happens: no audio, wrong device, muted hardware, or another application
 * holding the input.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND TIME-INJECTED
 * ---------------------------------------------------------------------------
 * Everything here is a fold over level frames with the clock passed in, so the
 * decision — which is the part that can be subtly wrong — is unit-testable
 * without a microphone, a window, or a wall clock. The orchestration that owns
 * the capture and the stage lives in `routes/preflight-mic-check.ts`.
 */
import {
  STAGE_MIC_CHECK_TRACE_SAMPLES,
  type AudioLevelSnapshot,
  type StageMicCheckState,
} from '../../../shared/contracts';
import {
  INITIAL_MIC_ADVICE_STATE,
  METER_REFERENCE_PEAK,
  NO_SIGNAL_AFTER_MS,
  PEAK_HOLD_MS,
  TOO_LOW_PEAK,
  micCondition,
  reduceMicLevel,
  type MicAdviceState,
} from '../../components/mic-advice';

/**
 * How much voice proves the input works.
 *
 * Measured as accumulated SPEAKING time rather than elapsed time, so a
 * presenter who takes a moment to get ready is not failed for it, and a room
 * with a fan in it cannot pass the check by being noisy for long enough —
 * `speaking` is the VAD's decision, not a level threshold.
 *
 * 1.2 s is about four words. Two would be inside the VAD's own attack/release
 * and could be satisfied by a cough; a full sentence would make the presenter
 * perform for the machine. Four words is "testing, one two three".
 */
export const MIC_CHECK_SPEECH_MS = 1200;

/**
 * How long before "start anyway" appears.
 *
 * The check has to be skippable. A presenter with a working rig, an unusual
 * microphone and a deadline is not someone this app gets to refuse, and a
 * gate with no way past it is a gate that eventually gets worked around by not
 * using the product.
 *
 * But it must not be skippable INSTANTLY, or the override becomes the thing
 * you press to make the screen go away — which would restore precisely the
 * failure the check exists to prevent. Four seconds is long enough that
 * pressing it is a decision, and short enough that it never feels like a trap.
 */
export const MIC_CHECK_OVERRIDE_AFTER_MS = 4000;

/**
 * Bars in the waveform. Sized for the trace to read as motion, not as data.
 *
 * Defined on the wire contract so the stage pads to the same number this fills
 * to — see the note there.
 */
export const MIC_CHECK_TRACE_SAMPLES = STAGE_MIC_CHECK_TRACE_SAMPLES;

/**
 * Longest gap between frames that still counts as continuous speech.
 *
 * Frames arrive at ~90 ms. If the stream stalls — the tab is throttled, the
 * device is renegotiating — the next frame can carry a `generatedAtMs` seconds
 * later, and crediting that whole gap as speech would let a stall pass the
 * check on the strength of one frame. Capping the credit at ~3 frames means a
 * stall contributes almost nothing instead of everything.
 */
const MAX_FRAME_CREDIT_MS = 280;

export interface MicCheckState {
  /** Peak-hold / clip-latch history, shared with the Preflight meter. */
  advice: MicAdviceState;
  /**
   * Speech that would actually transcribe — the only evidence that can pass.
   *
   * Qualified per frame (see {@link isUsableSpeech}), not assembled from
   * separate facts. An earlier version accumulated "speaking time" and checked
   * the HELD peak independently, which let three different non-microphones
   * through: sustained clipping (loud, so it cleared the peak gate), quiet
   * speech riding the peak of an unrelated knock three seconds earlier, and a
   * stalled stream whose handful of surviving frames each claimed the maximum
   * credit.
   */
  usableSpeechMs: number;
  /**
   * Speech that is arriving but too quiet to transcribe.
   *
   * Tracked separately so the check can say WHY it is not passing. Without it
   * a quiet microphone produces no usable speech, no progress, and no
   * explanation — the "it just sits there" failure, inside the screen built to
   * abolish it.
   */
  quietSpeechMs: number;
  /**
   * Loudest peak seen *while speaking*, inside the peak-hold window.
   *
   * Deliberately not the meter's own peak hold, and deliberately not the
   * instantaneous frame peak — both are wrong here in opposite directions.
   *
   * The meter's hold remembers the loudest thing of ANY kind in the last three
   * seconds, so a door slam would vouch for the quiet speech that followed it.
   * The instantaneous peak is too strict the other way: measured speech in this
   * codebase runs at an RMS of 0.03–0.12 (see `calibrationPercentile` in
   * audio/defaults.ts), so individual frames dip below the usable-level line
   * between syllables even on a microphone that is working perfectly. Gating
   * frame by frame would credit a working setup only sporadically and could
   * leave a soft speaker unable to pass at all.
   *
   * Scoping the hold to speaking frames takes the tolerance without the hole.
   */
  speechPeak: number;
  speechPeakAtMs: number;
  /** `generatedAtMs` of the previous accepted frame, for the speech credit. */
  lastFrameAtMs: number | null;
  /** Waveform trace, oldest first. */
  levels: number[];
  /** True once {@link MIC_CHECK_SPEECH_MS} of usable speech has been heard. */
  passed: boolean;
}

export const INITIAL_MIC_CHECK_STATE: MicCheckState = {
  advice: INITIAL_MIC_ADVICE_STATE,
  usableSpeechMs: 0,
  quietSpeechMs: 0,
  speechPeak: 0,
  speechPeakAtMs: -Infinity,
  lastFrameAtMs: null,
  levels: [],
  passed: false,
};

/** Every number a frame carries must be real before it is reasoned about. */
function isFiniteFrame(level: AudioLevelSnapshot, nowMs: number): boolean {
  return (
    Number.isFinite(level.rms) &&
    Number.isFinite(level.peak) &&
    Number.isFinite(nowMs)
  );
}

/**
 * Is this frame a voice at all — as opposed to silence, or a noise?
 *
 * The conditions are read from the SAME frame. Evaluating them independently
 * over time is what let unusable audio through: clipping transcribes badly but
 * is loud, so it satisfied any loudness test that was applied separately.
 */
function isSpeechFrame(level: AudioLevelSnapshot): boolean {
  return level.speaking && level.signalPresent && !level.clipped;
}

/**
 * Fold one level frame into the check.
 *
 * `nowMs` is the frame's own `generatedAtMs` at every real call site; it is a
 * parameter so tests can drive the hold windows without waiting for them.
 */
export function reduceMicCheck(
  state: MicCheckState,
  level: AudioLevelSnapshot,
  nowMs: number,
): MicCheckState {
  /*
   * A frame carrying NaN or Infinity is not a quiet microphone, it is a broken
   * reading, and folding it in poisons the peak hold, the waveform and the
   * timestamps at once (NaN compares false against every threshold, so it
   * silently disables them rather than tripping them). Dropped WITHOUT
   * advancing `lastFrameAtMs`, so a stream producing nothing but garbage ages
   * into `unheard` instead of looking healthy forever.
   */
  if (!isFiniteFrame(level, nowMs)) return state;

  /*
   * Frames must arrive in order. An out-of-order one would rewrite
   * `lastFrameAtMs` backwards, which both hands the NEXT frame an inflated gap
   * and makes a live stream look stale to the view.
   */
  if (state.lastFrameAtMs !== null && nowMs < state.lastFrameAtMs) return state;

  const advice = reduceMicLevel(state.advice, level, nowMs);

  /*
   * Credit the gap between frames rather than a fixed per-frame constant: the
   * analysis interval is configurable and the scheduler is not exact, so
   * counting frames would make the threshold mean different amounts of time on
   * different machines.
   *
   * A gap LONGER than the cap earns nothing at all. Capping it instead — which
   * is what this did first — let a stalled capture buy the threshold cheaply:
   * six surviving frames seconds apart each claimed the 280 ms maximum, and
   * 1.4 s of "speech" passed the check on evidence that the stream had died.
   * Time between frames that never arrived is not time anybody spoke.
   */
  const gap = state.lastFrameAtMs === null ? 0 : nowMs - state.lastFrameAtMs;
  const contiguous = gap > 0 && gap <= MAX_FRAME_CREDIT_MS;
  const credit = contiguous ? gap : 0;

  /*
   * Peak hold, scoped to speech (see the field). Only a speaking frame can set
   * it, and it decays like the meter's, so the level a syllable establishes
   * carries across the dip that follows it but not across a pause.
   */
  const speech = isSpeechFrame(level);
  const holdExpired = nowMs - state.speechPeakAtMs > PEAK_HOLD_MS;
  const speechPeak = speech
    ? holdExpired || level.peak >= state.speechPeak
      ? level.peak
      : state.speechPeak
    : holdExpired
      ? 0
      : state.speechPeak;
  const speechPeakAtMs =
    speech && (holdExpired || level.peak >= state.speechPeak) ? nowMs : state.speechPeakAtMs;

  const loudEnough = speechPeak >= TOO_LOW_PEAK;
  const usableSpeechMs = state.usableSpeechMs + (speech && loudEnough ? credit : 0);
  const quietSpeechMs = state.quietSpeechMs + (speech && !loudEnough ? credit : 0);

  /*
   * The level is drawn against the held peak, exactly as the Preflight meter
   * is (see METER_REFERENCE_PEAK): raw RMS from an ordinary microphone at
   * conversational distance sits around 0.05–0.15, and a waveform drawn from
   * that directly is a flat line that says "we cannot hear you" while the
   * microphone is working perfectly. The floor stops a dead input being
   * amplified into a healthy-looking trace. This changes what is DRAWN, never
   * what is judged.
   */
  const reference = Math.max(METER_REFERENCE_PEAK, advice.peak);
  const amplitude =
    Number.isFinite(reference) && reference > 0
      ? Math.min(1, Math.max(0, level.rms) / reference)
      : 0;
  const levels = [...state.levels, amplitude].slice(-MIC_CHECK_TRACE_SAMPLES);

  /*
   * One threshold, over evidence that was already qualified frame by frame.
   * Once passed it stays passed: the presenter falling silent immediately
   * after proving the input works is not evidence against it.
   */
  const passed = state.passed || usableSpeechMs >= MIC_CHECK_SPEECH_MS;

  return {
    advice,
    usableSpeechMs,
    quietSpeechMs,
    speechPeak,
    speechPeakAtMs,
    lastFrameAtMs: nowMs,
    levels,
    passed,
  };
}

/**
 * What the check can currently say.
 *
 * Delegates the acoustic reading to `micCondition` so this screen and the
 * Preflight meter cannot disagree about the same microphone — the states below
 * are that condition re-expressed as a decision about starting.
 */
export function micCheckState(
  state: MicCheckState,
  level: AudioLevelSnapshot | null,
  nowMs: number,
): StageMicCheckState {
  if (state.passed) return 'passed';
  const condition = micCondition(level, state.advice, nowMs);
  /*
   * A check has to explain why it is not passing; a meter does not.
   *
   * `micCondition` ranks `speaking` above `too_low`, which is right for the
   * Preflight meter — while you are talking, "Hearing you" is the more useful
   * of the two readings. Here it is actively harmful: a presenter whose input
   * is too quiet to pass speaks, is told "Hearing you", keeps speaking, and is
   * told "Hearing you" again, forever. That is the "it just sits there"
   * failure this whole screen exists to abolish, reproduced inside it.
   *
   * So once enough speech has arrived that the check WOULD have passed, the
   * only thing still holding it back is level — and the presenter is told the
   * one thing they can act on. Before that threshold nothing is wrong yet and
   * the ordinary reading stands.
   */
  if (condition === 'speaking' && state.quietSpeechMs >= MIC_CHECK_SPEECH_MS) {
    return 'too_low';
  }
  switch (condition) {
    case 'clipping':
      return 'clipping';
    case 'no_signal':
      return 'unheard';
    case 'too_low':
      return 'too_low';
    case 'speaking':
      return 'hearing';
    // 'idle' is "no frame has been measured yet"; 'quiet' is a gap between
    // words. Both are the same thing to the presenter: keep going.
    default:
      return 'waiting';
  }
}

/**
 * Copy. Large line first, then what to do about it.
 *
 * The presenter is reading this from teleprompter distance, off a stage that
 * is about to become the thing they perform against, so the headline is short
 * enough to take in at a glance and the detail never blames them for a state
 * they have not caused yet.
 */
export const MIC_CHECK_COPY: Record<StageMicCheckState, { headline: string; detail: string }> = {
  waiting: {
    headline: 'Say something to check your microphone',
    detail: 'A few words is enough — the take starts as soon as CandidCue hears you.',
  },
  hearing: {
    headline: 'Hearing you',
    detail: 'Keep going for a moment.',
  },
  too_low: {
    headline: 'That is very quiet',
    detail: 'Move closer to the microphone, or raise its input level.',
  },
  clipping: {
    headline: 'That is too loud',
    detail: 'Reduce the microphone gain — clipped audio transcribes badly.',
  },
  unheard: {
    headline: 'CandidCue cannot hear that microphone',
    detail:
      'Check it is not muted, that the right input is selected, and that nothing else is using it.',
  },
  passed: {
    headline: 'Your microphone is working',
    detail: 'Starting the take.',
  },
};

/** Whether "start anyway" should be offered yet (see the constant above). */
export function micCheckCanOverride(elapsedMs: number): boolean {
  return elapsedMs >= MIC_CHECK_OVERRIDE_AFTER_MS;
}

/**
 * Everything the stage needs to draw, in one pure step.
 *
 * The publisher calls this on a fixed cadence rather than per level frame,
 * because the case that matters most is the one where level frames never
 * arrive at all: permission refused below the app, the device pulled, another
 * process holding the input. A view derived only from frames would leave the
 * presenter looking at a blank stage during exactly that failure.
 */
export function micCheckView(
  state: MicCheckState,
  level: AudioLevelSnapshot | null,
  nowMs: number,
  startedAtMs: number,
): {
  state: StageMicCheckState;
  levels: number[];
  headline: string;
  detail: string;
  canOverride: boolean;
} {
  const elapsedMs = nowMs - startedAtMs;
  /*
   * The latch outranks everything below, including staleness.
   *
   * It has to be tested here rather than only inside `micCheckState`: the
   * capture is torn down the moment a pass settles, so the last frame ages
   * past the staleness bound while the "your microphone is working" copy is
   * still on screen. Checked in the wrong order, a successful check spends its
   * final moments accusing the microphone it just approved.
   */
  if (state.passed) {
    const copy = MIC_CHECK_COPY.passed;
    return {
      state: 'passed',
      levels: state.levels,
      headline: copy.headline,
      detail: copy.detail,
      canOverride: micCheckCanOverride(elapsedMs),
    };
  }
  /*
   * No frames, or no frames LATELY — one rule, because they are the same fault
   * to the presenter and neither is reachable through `micCondition`.
   *
   * With no frame at all it reports `idle`, which is indistinguishable from the
   * first 90 ms of a healthy capture: a permission refused below the app, or a
   * device already held by something else, would sit on "say something" forever
   * at a microphone that will never be heard.
   *
   * And a capture that DIES mid-check freezes `level` at whatever it last said.
   * If that final frame happened to carry `signalPresent: true`, every
   * subsequent reading is computed from it and the check reports a healthy-ish
   * quiet input indefinitely — the stream is gone and nothing says so. Ageing
   * the last frame against the clock catches both.
   *
   * `nowMs` and `state.lastFrameAtMs` must therefore be the SAME clock. Frames
   * are stamped with `generatedAtMs`, which the monitor takes from
   * `performance.now()`, so every caller passes a monotonic reading here — not
   * a wall clock.
   */
  const sinceLastFrameMs =
    state.lastFrameAtMs === null ? elapsedMs : nowMs - state.lastFrameAtMs;
  const notHeardLately = sinceLastFrameMs >= NO_SIGNAL_AFTER_MS;
  const resolved: StageMicCheckState = notHeardLately
    ? 'unheard'
    : micCheckState(state, level, nowMs);
  const copy = MIC_CHECK_COPY[resolved];
  return {
    state: resolved,
    levels: state.levels,
    headline: copy.headline,
    detail: copy.detail,
    canOverride: micCheckCanOverride(elapsedMs),
  };
}
