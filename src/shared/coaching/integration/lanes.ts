/**
 * The lane bundle the orchestrator drives.
 *
 * Every object here is a lane's *own* public class, constructed from the user's
 * {@link CoachingSettings}. Nothing is re-implemented and nothing is wrapped:
 * the integrator's value is entirely in the order and cadence it calls these
 * in, so anything it hid would be untested behaviour of the real subsystem.
 *
 * The bundle is separated from the orchestrator for two reasons:
 *
 * - the session store can construct it once and hand the same instances to a
 *   post-take review builder, which reads the same trackers; and
 * - a test can substitute one lane with a throwing double and prove the §5.2
 *   isolation policy against the real objects everywhere else.
 *
 * Note the two `SpeechClock`s. They are different classes with the same name
 * and both are needed: `audio/vad`'s is the VAD that *closes* speech runs, and
 * `pace/speech-clock`'s is the accounting clock that answers voiced/delivery
 * time queries. They are aliased here so no call site has to work out which
 * import it got.
 */
import { MicrophoneCandidateSource } from '../audio/mic-candidates';
import { MicrophoneHealthMonitor } from '../audio/microphone-health';
import { PitchTracker } from '../audio/pitch-tracker';
import { SpeechClock as VadSpeechClock } from '../audio/vad';
import { CoachCandidateRegistry } from '../coach/candidate-generator';
import { CoachDiagnosticsCollector } from '../coach/diagnostics';
import { CoachTipPolicy } from '../coach/tip-policy';
import { FillerTracker } from '../disfluency/filler-tracker';
import type { TakeIdentity } from '../disfluency/types';
import { PaceAnalyzer } from '../pace/pace-analyzer';
import { SpeechClock as PaceSpeechClock } from '../pace/speech-clock';
import { CadenceAnalyzer } from '../prosody/cadence-analyzer';
import { EnergyAggregator } from '../prosody/energy-aggregator';
import { PitchAggregator } from '../prosody/pitch-aggregator';
import { VarietyAnalyzer } from '../prosody/variety-score';
import { PauseDeriver } from './pause-derivation';
import type { CoachingSettings } from './types';

export { VadSpeechClock, PaceSpeechClock };

export interface CoachingLanes {
  /** §12.5 the VAD: closes speech runs and owns every coaching timing claim. */
  vad: VadSpeechClock;
  /** §14.1 the accounting clock: voiced, delivery and unmeasured time. */
  clock: PaceSpeechClock;
  microphone: MicrophoneHealthMonitor;
  micCandidates: MicrophoneCandidateSource;
  pitchTracker: PitchTracker;
  pitch: PitchAggregator;
  energy: EnergyAggregator;
  pace: PaceAnalyzer;
  variety: VarietyAnalyzer;
  cadence: CadenceAnalyzer;
  fillers: FillerTracker;
  registry: CoachCandidateRegistry;
  policy: CoachTipPolicy;
  diagnostics: CoachDiagnosticsCollector;
  pauses: PauseDeriver;
}

export interface CoachingLanesOptions {
  settings: CoachingSettings;
  take: TakeIdentity;
  takeStartAudioMs: number;
  targetDurationMs: number | null;
  frameMs: number;
  /** Replace individual lanes. The seam the §5.2 isolation tests inject into. */
  overrides?: Partial<CoachingLanes>;
}

/**
 * Build the lanes from the user's settings.
 *
 * The user's own target bands always win over the delivery-style preset
 * (§14.6: "starting presets, not universal truths"), which is why the profile
 * overrides are applied on top of `style` rather than instead of it.
 */
export function createCoachingLanes(options: CoachingLanesOptions): CoachingLanes {
  const { settings, take, takeStartAudioMs, targetDurationMs, frameMs } = options;
  const overrides = options.overrides ?? {};

  const defaults: CoachingLanes = {
    vad: new VadSpeechClock({ takePassId: take.takePassId, frameMs }),
    clock: new PaceSpeechClock({ frameDurationMs: frameMs }),
    microphone: new MicrophoneHealthMonitor({ frameMs }),
    micCandidates: new MicrophoneCandidateSource(),
    pitchTracker: new PitchTracker({ frameMs }),
    pitch: new PitchAggregator(),
    energy: new EnergyAggregator(),
    pace: new PaceAnalyzer({
      style: settings.deliveryStyle,
      targetDurationMs,
      profile: {
        targetLowWpm: settings.targetWpmLow,
        targetHighWpm: settings.targetWpmHigh,
      },
    }),
    variety: new VarietyAnalyzer({
      style: settings.deliveryStyle,
      profile: {
        targetLow: settings.targetVarietyLow,
        targetHigh: settings.targetVarietyHigh,
        // §25.6: the positive tip is off unless the user asked for it.
        positiveTipEnabled: settings.positiveReinforcementEnabled,
      },
    }),
    cadence: new CadenceAnalyzer(),
    fillers: new FillerTracker({
      take,
      takeStartAudioMs,
      // §29.3/§30.2. `off` is Basic; every other mode makes precision calls, so
      // the tile's `degraded` flag is off for all three. `review_only` counts:
      // the queue still runs, just after the take.
      precisionEnabled: settings.precisionTranscriptionMode !== 'off',
    }),
    registry: new CoachCandidateRegistry(),
    policy: new CoachTipPolicy(),
    diagnostics: new CoachDiagnosticsCollector(),
    pauses: new PauseDeriver({ frameMs }),
  };

  return { ...defaults, ...overrides };
}
