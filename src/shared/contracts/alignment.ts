/**
 * Speech-to-script alignment contract — the seam between the Rust engine
 * (`crates/cc-align`, hosted in `src-tauri/src/align`) and everything that
 * renders or reports on where the presenter is.
 *
 *   Inworld socket ──SttFrame──▶ cc_align::Engine ──▶ AlignmentSnapshot
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
   * Reading rate for display extrapolation, tokens/second. Already zero
   * whenever extrapolating would be a guess (holding, ambiguous, searching), so
   * consumers must not re-derive that condition.
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
  /** Residual lead (ms of reading) kept once paused — "one word ahead". */
  leadFloorMs: number;

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
  if (!(rateTokensPerSecond > 0) || !Number.isFinite(tAudioMs)) return observedToken;
  const age = Math.max(0, tAudioMs - snapshot.evidenceAudioMs);
  const onset = Math.min(snapshot.pauseOnsetMs, snapshot.maxPredictionMs);
  // While evidence is fresh the lead grows 1:1 (pipeline-lag compensation).
  // Once it goes stale — the reader has probably paused — the lead eases
  // back to a one-word rest instead of parking five words ahead of someone
  // who stopped talking. Exact mirror of `Snapshot::display_at`.
  const lead =
    age <= onset ? age : Math.max(onset - (age - onset), Math.min(snapshot.leadFloorMs, onset));
  return Math.min(observedToken + (rateTokensPerSecond * lead) / 1000, scriptLenTokens);
}

/* ---------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

type FieldKind = 'real' | 'integer' | 'state' | 'decision' | 'nullableReal';

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
  confidence: 'real',
  suggestionToken: 'nullableReal',
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
