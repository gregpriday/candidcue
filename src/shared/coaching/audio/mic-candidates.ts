/**
 * §12.7 / §25.1. The producer of the `system_critical` band.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * {@link MicrophoneHealthMonitor} produces {@link MicrophoneCoachState} — the
 * *tile*. The catalog authors `MIC_CLIPPING`, `MIC_LEVEL_LOW`, `NOISE_HIGH`,
 * `TRANSCRIPTION_DEGRADED` and `MIC_DISCONNECTED`, the confidence floors exist,
 * and `COACH_PRIORITY_BANDS.system_critical` is the highest band in the
 * subsystem. Nothing constructed the {@link CoachCandidate} that joins the two,
 * so the entire band was unreachable: the loudest alert the rail can raise
 * could never be raised. Rule 1a in the contract exists because of exactly this
 * failure, and this module is the named producer it demands.
 *
 * ---------------------------------------------------------------------------
 * SUSTAINED, NOT INSTANTANEOUS (§12.7)
 * ---------------------------------------------------------------------------
 * A candidate is emitted only from a *sustained* condition. The monitor already
 * does the leaky accumulation and only sets a non-`ok` status once the
 * condition's hold has crossed its threshold, so this module reads
 * `status`/`sustained` rather than re-deriving thresholds it does not own. A
 * single clipped frame moves `conditionHold` and nothing else, which is the
 * §12.7.1 requirement stated as code.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REPEAT MEANS HERE
 * ---------------------------------------------------------------------------
 * The §26.3 repetition rules gate a re-showing on a *new evidence cluster*, so
 * evidence ids must be stable while one episode continues and different once a
 * new episode begins. An episode is a maximal run of consecutive updates in
 * which the condition held; the id is stamped with the episode's start. That is
 * what makes "clipping recurring five minutes later shows the alert again" and
 * "clipping continuing for thirty seconds does not re-alarm every 20 ms" the
 * same rule rather than two competing ones.
 *
 * Clock: audio time only, supplied by the caller (contract Rule 3).
 */
import type { CoachCandidate, CoachCandidateType, MicrophoneCoachState } from '../../contracts/coaching';

/** The conditions this producer can raise, in §12.7 precedence order. */
const CONDITION_ORDER = [
  'system_mic_disconnected',
  'system_mic_clipping',
  'system_mic_low',
  'system_noise_high',
  'system_transcription_degraded',
] as const;

export type MicrophoneCandidateType = (typeof CONDITION_ORDER)[number];

export interface MicrophoneCandidateContext {
  /** Monotonic audio-clock time of this update, ms (§5.4). */
  audioTimeMs: number;
  trackingEpoch: number;
  takePassId: string;
}

export interface MicrophoneCandidateOptions {
  /**
   * How long a condition must have been continuously true *at the producer* on
   * top of the monitor's own sustain, ms. Zero by default: the monitor already
   * enforces §12.7's sustain windows and doubling them would delay a genuine
   * hardware alert for no gain. Present so a caller with a jittery source can
   * add hysteresis without reaching into the monitor.
   */
  additionalSustainMs?: number;
  /**
   * Audio-clock gap after which a condition that returns counts as a *new*
   * episode rather than a continuation, ms. Default 2 000 — §25.1's "persists
   * until clear for 2 seconds" for clipping.
   */
  episodeGapMs?: number;
}

interface Episode {
  startedAtMs: number;
  lastSeenAtMs: number;
  heldMs: number;
  emitted: boolean;
}

const DEFAULT_EPISODE_GAP_MS = 2_000;

/**
 * Which conditions the state currently asserts.
 *
 * `no_signal` maps to `MIC_LEVEL_LOW` rather than to a code of its own: §25.1
 * authors no "no signal" copy, and "move a little closer to the mic" is the
 * honest advice when a connected device is delivering nothing. A *disconnected*
 * device is a different claim and has its own code.
 */
export function activeMicrophoneConditions(
  state: MicrophoneCoachState,
): MicrophoneCandidateType[] {
  const active: MicrophoneCandidateType[] = [];
  if (state.status === 'disconnected') {
    // Device loss outranks and replaces every acoustic reading: the levels the
    // tile still holds describe a microphone that is no longer there.
    return ['system_mic_disconnected'];
  }
  if (state.status === 'clipping') active.push('system_mic_clipping');
  if (state.status === 'low_level' || state.status === 'no_signal') {
    active.push('system_mic_low');
  }
  if (state.status === 'noisy') active.push('system_noise_high');
  if (state.transcriptionDegraded) active.push('system_transcription_degraded');
  return active;
}

/**
 * Turns the microphone tile's state into `system_critical` candidates.
 *
 * One instance per session; `reset()` on a new take pass, because episode
 * identity is what the §26.3 evidence-cluster test is measured against and an
 * episode never spans two performances.
 */
export class MicrophoneCandidateSource {
  private readonly episodes = new Map<MicrophoneCandidateType, Episode>();
  private readonly additionalSustainMs: number;
  private readonly episodeGapMs: number;

  constructor(options: MicrophoneCandidateOptions = {}) {
    this.additionalSustainMs = options.additionalSustainMs ?? 0;
    this.episodeGapMs = options.episodeGapMs ?? DEFAULT_EPISODE_GAP_MS;
  }

  reset(): void {
    this.episodes.clear();
  }

  /** The episode start for a condition, or `null` when it is not held. */
  episodeStartMs(type: MicrophoneCandidateType): number | null {
    return this.episodes.get(type)?.startedAtMs ?? null;
  }

  /**
   * Fold one microphone-state update in and return the candidates it justifies.
   *
   * Returns at most one candidate per condition, and only on the update that
   * first satisfies the sustain — never once per frame while the condition
   * continues. A continuing condition is already on the glass; re-proposing it
   * fifty times a second would consume the policy's budget describing something
   * the presenter is looking at.
   */
  update(
    state: MicrophoneCoachState,
    context: MicrophoneCandidateContext,
  ): CoachCandidate[] {
    const active = new Set(activeMicrophoneConditions(state));
    const out: CoachCandidate[] = [];

    for (const type of CONDITION_ORDER) {
      const existing = this.episodes.get(type);
      if (!active.has(type)) {
        // §25.1: the condition has to be *clear* for a while before a return
        // counts as a new episode, so a condition flickering at the threshold
        // does not manufacture fresh evidence ids.
        if (existing !== undefined && context.audioTimeMs - existing.lastSeenAtMs >= this.episodeGapMs) {
          this.episodes.delete(type);
        }
        continue;
      }

      const continuing =
        existing !== undefined && context.audioTimeMs - existing.lastSeenAtMs < this.episodeGapMs;
      const episode: Episode = continuing
        ? {
            startedAtMs: (existing as Episode).startedAtMs,
            lastSeenAtMs: context.audioTimeMs,
            heldMs:
              (existing as Episode).heldMs +
              Math.max(0, context.audioTimeMs - (existing as Episode).lastSeenAtMs),
            emitted: (existing as Episode).emitted,
          }
        : { startedAtMs: context.audioTimeMs, lastSeenAtMs: context.audioTimeMs, heldMs: 0, emitted: false };
      this.episodes.set(type, episode);

      if (episode.emitted) continue;
      if (episode.heldMs < this.additionalSustainMs) continue;
      episode.emitted = true;
      out.push(this.candidate(type, episode, state, context));
    }

    return out;
  }

  private candidate(
    type: MicrophoneCandidateType,
    episode: Episode,
    state: MicrophoneCoachState,
    context: MicrophoneCandidateContext,
  ): CoachCandidate {
    return {
      // Stable for the episode, distinct across episodes: exactly what §26.3's
      // "new evidence cluster" test needs to tell a recurrence from a
      // continuation.
      evidenceId: `mic:${type}:${context.takePassId}:${Math.round(episode.startedAtMs)}`,
      type: type as CoachCandidateType,
      // §12.7 conditions are measurements, not semantic guesses; the catalog's
      // `localConfidenceFloor` for system codes is 0 for the same reason. The
      // value is still short of 1 because a sustained acoustic condition is a
      // claim about the signal, not about the hardware.
      localConfidence: 0.95,
      stamp: {
        audioStartMs: episode.startedAtMs,
        audioEndMs: context.audioTimeMs,
        // Derived purely from local audio: there is no commit behind it (§5.4).
        commitSequence: null,
        trackingEpoch: context.trackingEpoch,
        takePassId: context.takePassId,
      },
      // A hardware fault is not scoped to a sentence. Leaving these `null` is
      // what keeps §26.5's out-of-scope cancellation away from it.
      scriptSpanId: null,
      scriptAnchorTokenId: null,
      contributingEventIds: [],
      detailCode: detailCodeFor(type, state),
      // §25.1 copy takes no substitution, and nothing the presenter said is
      // relevant to their microphone.
      spokenFragment: '',
      authoredFragment: '',
      // Local acoustic measurement is never revised by a later transcript.
      finalEvidence: true,
    };
  }
}

/**
 * A short, non-quoted description of the measurement behind the alert.
 * Diagnostics and the post-take report read this; it never reaches the glass.
 */
function detailCodeFor(type: MicrophoneCandidateType, state: MicrophoneCoachState): string {
  switch (type) {
    case 'system_mic_disconnected':
      return 'device_lost';
    case 'system_mic_clipping':
      return state.levelDbfs === null ? 'clipping' : `clipping_${state.levelDbfs.toFixed(1)}dbfs`;
    case 'system_mic_low':
      return state.levelDbfs === null ? 'low_level' : `low_level_${state.levelDbfs.toFixed(1)}dbfs`;
    case 'system_noise_high':
      return state.snrDb === null ? 'noisy' : `noisy_snr_${state.snrDb.toFixed(1)}db`;
    case 'system_transcription_degraded':
      return 'transcription_degraded';
  }
}
