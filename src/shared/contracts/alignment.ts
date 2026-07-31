/**
 * Speech-to-script alignment contract — the seam between the Rust engine
 * (`crates/cc-align`, hosted in `src-tauri/src/align`) and everything that
 * renders or reports on where the presenter is.
 *
 *   on-device STT ──SttFrame──▶ cc_align::Engine ──▶ AlignmentSnapshot
 *        (Rust)                       (Rust)                │
 *                                                           ├──▶ stage: 60 Hz
 *                                                           │    motion from
 *                                                           │    displayAt(now)
 *                                                           └──▶ control:
 *                                                                progress, take
 *                                                                summary
 *
 * ---------------------------------------------------------------------------
 * ONE COORDINATE SYSTEM ON THIS SIDE OF THE WIRE
 * ---------------------------------------------------------------------------
 * The engine works in *atoms* — normalized spoken words, where `$12` is two.
 * Every position here is a fractional **token index** into the compiled
 * script's `spokenTokens`, because that is what the stage has measured
 * rectangles for. The conversion happens once, in Rust, at the point the
 * snapshot is produced. Nothing in TypeScript should ever perform it, and
 * nothing here should ever tokenize, normalize, or judge word similarity: all
 * lexical judgement lives in the engine. The one time that rule was broken the
 * two copies disagreed and the cursor sat at `0 of 26` for a whole take.
 *
 * ---------------------------------------------------------------------------
 * A SNAPSHOT IS NOT A SCROLL COMMAND
 * ---------------------------------------------------------------------------
 * It is a statement of where the reader is, how confident the engine is, and
 * what kind of moment this is. The stage owns all animation. Snapshots arrive
 * about once a second (one per transcript event); the 60 Hz motion loop calls
 * {@link alignmentDisplayAt} between them.
 */

/* ---------------------------------------------------------------------------
 * Vocabulary
 * ------------------------------------------------------------------------- */

/**
 * The user-facing contract. Four states, exhaustive, matched by name against
 * the Rust `state_name` mapping in `src-tauri/src/align/mod.rs` — a rename on
 * either side compiles fine and silently stops the stage following, so a test
 * asserts the two lists agree.
 */
export const ALIGNMENT_STATES = ['searching', 'following', 'holding', 'ambiguous'] as const;

export type AlignmentState = (typeof ALIGNMENT_STATES)[number];

/**
 * Why the engine produced this snapshot. **Diagnostics only.**
 *
 * Do not map these to user-facing text and do not branch product behaviour on
 * them beyond the motion classification in {@link ALIGNMENT_RELOCATIONS} —
 * {@link AlignmentState} is the contract the presenter sees.
 */
export const ALIGNMENT_DECISIONS = [
  'noEvidence',
  'localObserved',
  'localConfirmed',
  'holdLowEvidence',
  'holdOffScript',
  'holdAmbiguous',
  'relocationAccepted',
  'jumpForwardAccepted',
  'retakeAccepted',
  'jumpPending',
  'manualAnchor',
] as const;

export type AlignmentDecision = (typeof ALIGNMENT_DECISIONS)[number];

/**
 * Decisions whose position moved far enough that ordinary smoothing is the
 * wrong animation.
 *
 * These are accepted discontinuities — a skipped section, a retake, a manual
 * move — and the stage flies them as a deliberate relocation. Everything else
 * is ordinary following, including `jumpPending`: a jump that has NOT been
 * accepted must not move the display at all.
 */
export const ALIGNMENT_RELOCATIONS: ReadonlySet<AlignmentDecision> = new Set<AlignmentDecision>([
  'relocationAccepted',
  'jumpForwardAccepted',
  'retakeAccepted',
  'manualAnchor',
]);

/* ---------------------------------------------------------------------------
 * The snapshot
 * ------------------------------------------------------------------------- */

/**
 * One statement of where the reader is. Mirrors the Rust `AlignmentSnapshot`
 * field for field (camelCase both sides).
 */
export interface AlignmentSnapshot {
  /**
   * The transcription generation this alignment belongs to. A snapshot whose
   * generation is not the live one describes a take that has already ended.
   */
  sessionGeneration: number;
  /** Monotone within a session. Consumers drop anything not strictly newer. */
  seq: number;
  state: AlignmentState;
  decision: AlignmentDecision;

  /**
   * Conservative anchor. Monotonic except accepted retakes and manual moves —
   * this is the position to build progress, "words covered" and recovery UI on.
   */
  confirmedToken: number;
  /**
   * Best evidence-supported position right now. **Not the scroll target**:
   * scrolling straight to it reintroduces the freeze-then-lurch the display
   * model exists to remove. Use {@link alignmentDisplayAt}.
   */
  observedToken: number;
  /**
   * Rate for display extrapolation, tokens/second. Already zero whenever
   * extrapolating would be a guess (holding, ambiguous, searching), so
   * consumers must not re-derive that condition.
   *
   * Deliberately BELOW the reader's estimated pace: the display is meant to
   * trail them, never to lead. Do not "correct" it back up to a measured
   * reading speed.
   */
  rateTokensPerSecond: number;


  /** Audio-clock time `observedToken` corresponds to. */
  evidenceAudioMs: number;
  /** Audio-clock time this snapshot was produced. */
  atAudioMs: number;
  /** Hard cap on forward extrapolation beyond `evidenceAudioMs`. */
  maxPredictionMs: number;
  /**
   * Evidence age at which the lead stops growing and eases back: the reader
   * has probably paused. Mirrors the engine's pause model — the stage never
   * re-derives pause detection.
   */
  pauseOnsetMs: number;
  /** Residual lead (ms of reading) kept once paused. Zero: rest on the last
   * word actually heard, not past it. */
  leadFloorMs: number;
  /** Hard cap on how far prediction may carry the display past
   * `observedToken`, in tokens. */
  maxLeadTokens: number;
  /**
   * How far behind its own estimate the display deliberately sits while the
   * reader is flowing, in tokens.
   *
   * This is how caution is bought without buying jerk. `rateTokensPerSecond`
   * cannot separate the two: the display's position is
   * `observed + rate·age`, so a rate below the reader's pace makes the display
   * travel slower than them AND leaves a step of exactly
   * `(1 − gain)·pace·Δt` waiting at the next transcript event. A margin costs
   * distance instead of speed. It fades out through the same settle as the
   * lead, so a display at rest rests on the last word actually heard.
   */
  leadMarginTokens: number;
  /**
   * Corner-rounding widths for the lead profile. The bounds above are
   * unchanged; these decide whether the display arrives at one by decelerating
   * or by stopping in a single frame. Zero restores the old hard corners.
   */
  leadEaseMs: number;
  leadHoldMs: number;
  leadDecayMs: number;
  /**
   * Absolute ceiling for the display: the end of the SENTENCE the reader was
   * last heard in, and never past the end of its paragraph. The engine will not
   * predict across either break — a break is where readers stop for breath, so
   * crossing one on a rate estimate alone is the guess most likely to be wrong
   * and most visible when it is.
   */
  displayLimitToken: number;

  /**
   * Documented heuristic in 0..1 — NOT a calibrated probability. Fine for a
   * debug meter; never gate product behaviour on an exact threshold.
   */
  confidence: number;
  /**
   * A distant candidate that is accumulating evidence but has NOT been
   * accepted: "possible match below — resume here?". The UI may offer it as a
   * quiet affordance. It must never be auto-scrolled to.
   */
  suggestionToken: number | null;
  /**
   * A bounded, reversible dimming frontier inferred from close local
   * spelling/phonetic evidence. It never drives scrolling or progress.
   *
   * Optional for replay fixtures recorded before this field existed; live
   * Rust snapshots always include it.
   */
  provisionalToken?: number | null;
  /** One-shot permission for the renderer to brighten withdrawn speculation. */
  provisionalRetracted?: boolean;
  /** Total spoken tokens — the ceiling for any display position. */
  scriptLenTokens: number;

  /** Atom-space originals. Diagnostics and benchmark parity only. */
  observedAtom: number;
  confirmedAtom: number;
}

/**
 * Where the display should place the reader at audio-clock time `tAudioMs`.
 *
 * The mirror of `Snapshot::display_at` in the engine, and the only position the
 * motion layer should chase. The horizon is clamped at both ends: a clock that
 * has not reached the evidence yet does not rewind the reader, and a stale
 * snapshot cannot scroll the document indefinitely.
 *
 * "Mirror" and not "identical": the engine extrapolates along the ATOM axis and
 * this runs on a single token-space rate, and the two axes are related by a
 * piecewise-linear map (a token like `$12` is two atoms). Wherever a
 * multi-atom token falls inside the prediction horizon the two curves differ
 * mid-flight — by a fraction of a token — while agreeing at both endpoints,
 * which is what the projection in `src-tauri/src/align/mod.rs` is chosen to
 * guarantee. Representing the difference exactly would mean shipping the axis
 * breakpoints to the stage; a fraction of a word of interpolation error inside
 * a bounded horizon does not justify that.
 *
 * Deliberately NOT a second prediction model. The engine has already applied
 * lag compensation and bounded the extrapolation; a stage that layered its own
 * horizon on top would be extrapolating an extrapolation.
 */
export function alignmentDisplayAt(snapshot: AlignmentSnapshot, tAudioMs: number): number {
  const { observedToken, rateTokensPerSecond, scriptLenTokens } = snapshot;
  const ceiling = Math.min(snapshot.displayLimitToken, scriptLenTokens);
  const age = Number.isFinite(tAudioMs) ? Math.max(0, tAudioMs - snapshot.evidenceAudioMs) : 0;
  const onset = Math.min(snapshot.pauseOnsetMs, snapshot.maxPredictionMs);
  /*
   * How far through the settle onto a pause this snapshot is.
   *
   * Computed BEFORE the zero-rate branch, because the margin below depends on
   * it and the margin applies whether or not there is a lead. Returning a bare
   * `observedToken` when the rate is zero — which this used to do — put a step
   * of the whole margin into the reference at every Following→Holding
   * transition: the path below answers `observed - margin` at zero lead, so
   * dropping the margin moved the target FORWARD by a couple of words in one
   * frame, in the one direction that is never safe, at the exact moment the
   * engine had decided it was no longer sure enough to extrapolate.
   */
  const settle = smoothstep(
    (age - (onset + snapshot.leadHoldMs)) / Math.max(1, snapshot.leadDecayMs),
  );
  // Caution as a distance, not as a reduced speed — see `leadMarginTokens`.
  // Fades out through the settle, so a display that has come to rest rests ON
  // the last word heard rather than a word short of it.
  const margin = snapshot.leadMarginTokens * (1 - settle);
  if (!(rateTokensPerSecond > 0)) return clampToScript(observedToken - margin, ceiling);

  // While evidence is fresh the lead grows 1:1 — that is pipeline-lag
  // compensation, not a guess about the future: the words are already said,
  // the recogniser has simply not finished saying so. It eases into a plateau
  // at `onset` rather than arriving there at full speed, holds, and then eases
  // back so the display rests on the last word actually heard.
  //
  // Exact mirror of `Snapshot::display_at`; a Rust test asserts the two agree.
  const rise = softMin(age, onset, snapshot.leadEaseMs);
  const floorMs = Math.min(snapshot.leadFloorMs, onset);
  const leadMs = rise * (1 - settle) + floorMs * settle;
  const lead = softMin(
    (rateTokensPerSecond * leadMs) / 1000,
    snapshot.maxLeadTokens,
    (rateTokensPerSecond * snapshot.leadEaseMs) / 1000,
  );
  return clampToScript(observedToken + lead - margin, ceiling);
}

/**
 * Into the script at both ends. The margin may deliberately carry the display
 * behind `observedToken`, but near the start of a script that can carry it
 * behind the script itself — and a negative position reaches `lastDisplayToken`
 * and the active-token lookup well before the plant's own bounds clamp pixels.
 */
function clampToScript(position: number, ceiling: number): number {
  return Math.min(Math.max(0, position), Math.max(0, ceiling));
}

/**
 * How fast {@link alignmentDisplayAt} is moving at `tAudioMs`, tokens/second —
 * the stage's feed-forward velocity.
 *
 * The DERIVATIVE OF THE PATH, deliberately, and not the engine's rate estimate.
 * They are equal while the reader is flowing and the extrapolation gain is 1,
 * which is the common case; they diverge exactly where it matters, because the
 * path stops advancing when the lead saturates, when a paragraph ceiling is
 * reached, and while it settles onto a pause, and the rate estimate knows about
 * none of that.
 *
 * Feeding the raw pace instead is unsafe rather than merely inaccurate. The
 * §70.5 overshoot guard measures speed RELATIVE to the feed-forward — matching
 * a moving target's speed is not overshoot — so a feed-forward larger than the
 * target's own speed exempts the plant from the guard by exactly that much, and
 * a target that has stopped while the feed-forward has not lets the plant sail
 * past it indefinitely with nothing to arrest it.
 *
 * Numerical rather than analytic: the path is a composition of two eased
 * limits, a settle blend and a fading margin, and a hand-differentiated copy of
 * that is one edit away from disagreeing with the function it claims to
 * differentiate. A forward difference over one frame cannot.
 */
export function alignmentDisplayRateAt(snapshot: AlignmentSnapshot, tAudioMs: number): number {
  const H_MS = 20;
  const here = alignmentDisplayAt(snapshot, tAudioMs);
  const ahead = alignmentDisplayAt(snapshot, tAudioMs + H_MS);
  if (!Number.isFinite(here) || !Number.isFinite(ahead)) return 0;
  // Never negative: ordinary following does not move backward, and a settling
  // path that is easing back would otherwise command a reverse cruise.
  return Math.max(0, ((ahead - here) * 1000) / H_MS);
}

/**
 * Hermite smoothstep, clamped: 0 below 0, 1 above 1, and zero slope at both
 * ends so a transition through it adds no velocity step.
 */
function smoothstep(u: number): number {
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

/**
 * `Math.min(a, cap)` with the corner rounded off over a knee of width `ease`.
 *
 * Equal to `a` well below the cap, asymptotic to the cap above it, and
 * differentiable everywhere between — which is the whole reason it exists. A
 * hard `min` meant the display travelled at full pace right up to a bound and
 * then stopped in a single frame. `ease <= 0` returns the exact hard minimum.
 */
function softMin(a: number, cap: number, easeRaw: number): number {
  if (!(easeRaw > 0) || !Number.isFinite(cap) || !Number.isFinite(a)) return Math.min(a, cap);
  // The knee may never be wider than the cap it rounds, or it straddles the
  // origin and turns a zero cap into a NEGATIVE result. Mirrors the engine.
  const ease = Math.min(easeRaw, Math.abs(cap) * 0.5);
  if (!(ease > 0)) return Math.min(a, cap);
  // Exact outside `cap ± ease`, C¹ across it. Mirrors `soft_min` in the engine
  // — see the note there on why an asymptotic softplus was wrong here.
  const lo = cap - ease;
  if (a <= lo) return a;
  if (a >= cap + ease) return cap;
  const u = (a - lo) / (2 * ease);
  return lo + 2 * ease * (u - (u * u) / 2);
}


/* ---------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

type FieldKind =
  | 'real'
  | 'integer'
  | 'state'
  | 'decision'
  | 'nullableReal'
  | 'optionalNullableReal'
  | 'optionalBoolean';

/**
 * Typed `Record<keyof AlignmentSnapshot, FieldKind>`, so a field added to the
 * contract fails compilation here until it is classified rather than sliding
 * through unvalidated.
 */
const SNAPSHOT_FIELDS: Record<keyof AlignmentSnapshot, FieldKind> = {
  sessionGeneration: 'integer',
  seq: 'integer',
  state: 'state',
  decision: 'decision',
  confirmedToken: 'real',
  observedToken: 'real',
  rateTokensPerSecond: 'real',
  evidenceAudioMs: 'real',
  atAudioMs: 'real',
  maxPredictionMs: 'real',
  pauseOnsetMs: 'real',
  leadFloorMs: 'real',
  maxLeadTokens: 'real',
  leadMarginTokens: 'real',
  leadEaseMs: 'real',
  leadHoldMs: 'real',
  leadDecayMs: 'real',
  displayLimitToken: 'real',
  confidence: 'real',
  suggestionToken: 'nullableReal',
  provisionalToken: 'optionalNullableReal',
  provisionalRetracted: 'optionalBoolean',
  scriptLenTokens: 'real',
  observedAtom: 'real',
  confirmedAtom: 'real',
};

const SNAPSHOT_ENTRIES = Object.entries(SNAPSHOT_FIELDS) as Array<
  [keyof AlignmentSnapshot, FieldKind]
>;

const STATE_SET: ReadonlySet<string> = new Set(ALIGNMENT_STATES);
const DECISION_SET: ReadonlySet<string> = new Set(ALIGNMENT_DECISIONS);

/**
 * Structural validation of a snapshot arriving over the event channel.
 *
 * The stage's motion plant is persistent for the life of a session, so one
 * `NaN` reaching it would poison target → acceleration → velocity → position
 * and every later frame would render `translate3d(0, NaNpx, 0)` forever. The
 * payload crosses a process boundary, which makes it untrusted data however
 * well-typed the producer is.
 *
 * Returns the offending field name, or null when the snapshot is sound.
 */
export function validateAlignmentSnapshot(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'snapshot';
  const snapshot = value as Record<string, unknown>;

  for (const [key, kind] of SNAPSHOT_ENTRIES) {
    const field = snapshot[key];
    switch (kind) {
      case 'real':
        if (typeof field !== 'number' || !Number.isFinite(field)) return key;
        break;
      case 'integer':
        if (typeof field !== 'number' || !Number.isInteger(field)) return key;
        break;
      case 'nullableReal':
        if (field !== null && (typeof field !== 'number' || !Number.isFinite(field))) return key;
        break;
      case 'optionalNullableReal':
        if (
          field !== undefined &&
          field !== null &&
          (typeof field !== 'number' || !Number.isFinite(field))
        ) {
          return key;
        }
        break;
      case 'optionalBoolean':
        if (field !== undefined && typeof field !== 'boolean') return key;
        break;
      case 'state':
        if (typeof field !== 'string' || !STATE_SET.has(field)) return key;
        break;
      case 'decision':
        if (typeof field !== 'string' || !DECISION_SET.has(field)) return key;
        break;
    }
  }
  return null;
}

export function isAlignmentSnapshot(value: unknown): value is AlignmentSnapshot {
  return validateAlignmentSnapshot(value) === null;
}

/* ---------------------------------------------------------------------------
 * Stage → Rust: the viewport prior
 * ------------------------------------------------------------------------- */

/**
 * "This is what I can see." A prior on candidate ranking, never a command.
 *
 * It speeds up locks that start mid-script and makes a far jump to somewhere
 * off-screen require an extra round of evidence before it is accepted. It
 * travels stage → Rust as an event because the stage window holds no invoke
 * permission at all.
 */
export interface AlignmentViewportHint {
  sessionGeneration: number;
  /** First and last visible token indexes. Ignored when `cleared`. */
  firstToken: number;
  lastToken: number;
  /**
   * True when the concept does not apply — a full-script overview, or a
   * viewport the stage cannot currently measure. Clears the prior rather than
   * asserting a bogus one.
   */
  cleared: boolean;
}

/**
 * Debounce interval for viewport hints. The integration note asks for about
 * four a second: often enough that a scroll settles into a fresh prior almost
 * immediately, rare enough that a flung scrollbar does not put a hint on the
 * event bus for every frame of its travel.
 */
export const VIEWPORT_HINT_INTERVAL_MS = 250;
