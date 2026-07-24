/**
 * §12.3 / §12.5. Adaptive background-noise-floor estimate, in dBFS.
 *
 * The rule this module exists to enforce is the last bullet of §12.5:
 * **never train the noise floor on frames currently classified as voiced
 * speech**. A floor trained on speech climbs to the speaker's own level, SNR
 * collapses to ~0, the VAD stops opening, and every downstream metric quietly
 * dies while the pipeline still looks healthy. `update()` therefore takes the
 * frame's speech/voicing decision and simply does not adapt on speech.
 *
 * Adaptation is asymmetric and time-constant based, so it behaves identically
 * at 44.1 and 48 kHz: the floor falls quickly toward a quieter room (a fan
 * switching off is real) and rises slowly (a slammed door is not the new
 * floor). §12.5: "adapt thresholds slowly to background noise".
 *
 * Stateless with respect to wall-clock time: everything is driven by the frame
 * duration the caller passes in (Rule 3).
 */
import { DBFS_FLOOR } from './frame-features';

export interface NoiseFloorOptions {
  /** Duration of one analysis frame, ms. Sets the adaptation rates. */
  frameMs: number;
  /** Time constant for a falling floor, ms. Default 400. */
  fallTimeMs?: number;
  /** Time constant for a rising floor, ms. Default 4000. */
  riseTimeMs?: number;
  /**
   * Frames of non-speech observed before the estimate is trusted. Until then
   * the floor tracks the minimum seen, so start-up does not begin at -100 dBFS
   * and report a fictitious 60 dB SNR on the first syllable.
   */
  primingFrames?: number;
  /** Highest floor the estimator will report, dBFS. Default -25. */
  maximumFloorDbfs?: number;
  /**
   * Safety leak, dB per second, applied *only* while the floor sits within
   * {@link NoiseFloorEstimator.LEAK_GUARD_DB} of the current speech level — i.e.
   * only while the reported SNR is too poor for the VAD to work at all.
   * Default 1.
   *
   * Without it there is a genuine trap: a take that starts mid-sentence primes
   * the floor at the speaker's own level, SNR reads 0, every frame is therefore
   * classified as speech, and a floor that only learns from non-speech frames
   * can never be corrected — the pipeline wedges permanently and silently.
   * The leak only ever moves the floor *down*, so it cannot cause the collapse
   * §12.5 is guarding against, and the guard band means a healthy floor
   * (speech comfortably above the room) never leaks at all.
   */
  leakDbPerSecond?: number;
}

export class NoiseFloorEstimator {
  private floorDbfs: number;
  private primedFrames = 0;
  private readonly fallAlpha: number;
  private readonly riseAlpha: number;
  private readonly primingFrames: number;
  private readonly maximumFloorDbfs: number;
  private readonly leakPerFrameDb: number;

  /** The floor only leaks while it is this close to the measured level. */
  static readonly LEAK_GUARD_DB = 12;

  constructor(options: NoiseFloorOptions) {
    const frameMs = Math.max(options.frameMs, 1);
    this.fallAlpha = 1 - Math.exp(-frameMs / (options.fallTimeMs ?? 400));
    this.riseAlpha = 1 - Math.exp(-frameMs / (options.riseTimeMs ?? 4000));
    this.primingFrames = options.primingFrames ?? 10;
    this.maximumFloorDbfs = options.maximumFloorDbfs ?? -25;
    this.leakPerFrameDb = ((options.leakDbPerSecond ?? 1) * frameMs) / 1000;
    this.floorDbfs = DBFS_FLOOR;
  }

  get valueDbfs(): number {
    return this.floorDbfs;
  }

  get primed(): boolean {
    return this.primedFrames >= this.primingFrames;
  }

  reset(): void {
    this.floorDbfs = DBFS_FLOOR;
    this.primedFrames = 0;
  }

  /**
   * Fold one frame in and return the floor to use for *this* frame's SNR.
   *
   * The returned value is the floor as it stood before the frame's own
   * contribution, which is what makes `estimatedSnrDb === max(0, rms - floor)`
   * an exact identity in `frame-features.ts` rather than an approximation.
   *
   * `isSpeech` covers both the VAD probability and voicing; a dropout frame
   * must be passed as `isSpeech = true` (i.e. "do not learn from this"), since
   * a dropout's level is an artefact, not the room.
   */
  update(rmsDbfs: number, isSpeech: boolean): number {
    const floorForFrame = this.floorDbfs;
    if (isSpeech) {
      if (rmsDbfs - this.floorDbfs < NoiseFloorEstimator.LEAK_GUARD_DB) {
        this.floorDbfs = Math.max(this.floorDbfs - this.leakPerFrameDb, DBFS_FLOOR);
      }
      return floorForFrame;
    }

    if (this.primedFrames < this.primingFrames) {
      // Track the minimum while priming, and report the *updated* floor: the
      // initial -100 dBFS placeholder would otherwise claim a 60 dB SNR on the
      // very first frame of the take.
      this.primedFrames += 1;
      const candidate = this.primedFrames === 1 ? rmsDbfs : Math.min(this.floorDbfs, rmsDbfs);
      this.floorDbfs = Math.min(candidate, this.maximumFloorDbfs);
      return this.floorDbfs;
    }

    const alpha = rmsDbfs < this.floorDbfs ? this.fallAlpha : this.riseAlpha;
    const next = this.floorDbfs + alpha * (rmsDbfs - this.floorDbfs);
    this.floorDbfs = Math.min(Math.max(next, DBFS_FLOOR), this.maximumFloorDbfs);
    return floorForFrame;
  }

  /** §12.4 `estimatedSnrDb`: a **positive** difference, 0 when at or below the floor. */
  static snrDb(rmsDbfs: number, noiseFloorDbfs: number): number {
    const difference = rmsDbfs - noiseFloorDbfs;
    return difference > 0 ? difference : 0;
  }
}
