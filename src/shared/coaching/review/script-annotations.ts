/**
 * §31.4 script view: the authored script with session-local annotations.
 *
 * ---------------------------------------------------------------------------
 * THE SOURCE MARKDOWN IS NEVER EDITED.
 * ---------------------------------------------------------------------------
 * §31.4 states it outright, and this module honours it structurally rather
 * than by discipline: an {@link AnnotatedPassage} holds the *same object* it
 * was given, and annotations live beside it in a separate array. There is no
 * code path here that produces a string of script text, so there is nothing
 * that could be written back. The tests assert reference identity for exactly
 * this reason — a promise about text is worth less than a promise the text was
 * never re-derived.
 *
 * Annotations are session-local (§11.2 "Marks are session-local unless the user
 * saves a rehearsal report") and are grouped per take pass, never merged, so a
 * sentence read three times shows three passes' worth of marks (§11.3).
 */
import type { FillerEvent } from '../../contracts/coaching';
import type {
  CoachingSessionRecord,
  ReviewScript,
  ReviewScriptPassage,
  TakePassRecord,
} from './types';

export type ScriptAnnotationKind =
  | 'filler_insertion'
  | 'false_start'
  | 'repeated_word'
  | 'self_correction'
  | 'repetitive_opener'
  | 'repeated_passage'
  | 'critical_mismatch'
  | 'boundary_shaped'
  | 'boundary_unshaped'
  | 'emphasis_observation';

export interface ScriptAnnotation {
  annotationId: string;
  kind: ScriptAnnotationKind;
  takePassId: string;
  passOrdinal: number;
  /** Audio-clock time the observation belongs to. */
  atMs: number;
  /** Anchor token, or `null` for a passage-level annotation. */
  scriptAnchorTokenId: string | null;
  /** Authored, safe label. Never raw transcript or model text. */
  label: string;
  /** Authored script text, quotable under §25.5. `null` when not applicable. */
  authoredFragment: string | null;
  /** What was heard. Only ever shown beside `authoredFragment`, never alone. */
  spokenFragment: string | null;
  /** The matching {@link TimelineEvent} id, when there is one. */
  eventId: string | null;
}

export interface AnnotatedPassage {
  /** The authored passage, by reference. Never a copy, never modified. */
  passage: ReviewScriptPassage;
  /** Ascending by `atMs`, then by pass ordinal. */
  annotations: readonly ScriptAnnotation[];
  /** Take passes that read this passage. More than one means it was reread. */
  passOrdinals: readonly number[];
}

export interface AnnotatedScript {
  scriptId: string;
  scriptRevision: number;
  passages: readonly AnnotatedPassage[];
  /**
   * Annotations with no usable anchor — an unlocalized filler (§16.3.4), or an
   * anchor that is not in this revision of the script. Listed honestly rather
   * than dropped onto a nearby sentence.
   */
  unanchored: readonly ScriptAnnotation[];
  /**
   * True when the script revision differs from the one the take was recorded
   * against. Anchors may no longer land where they did; the review still shows
   * them, labelled, because hiding the whole script view would be worse.
   */
  revisionMismatch: boolean;
}

export interface AnnotationOptions {
  /** §31.4 "optional emphasis observations". */
  includeEmphasis?: boolean;
  /** §18.3 boundary shaping marks. */
  includeBoundaries?: boolean;
}

const DISFLUENCY_ANNOTATION: Partial<Record<FillerEvent['kind'], ScriptAnnotationKind>> = {
  strict_vocalized: 'filler_insertion',
  contextual: 'filler_insertion',
  false_start: 'false_start',
  repeated_word: 'repeated_word',
  self_correction: 'self_correction',
  repetitive_opener: 'repetitive_opener',
};

const DISFLUENCY_LABEL: Record<ScriptAnnotationKind, string> = {
  filler_insertion: 'Filler',
  false_start: 'False start',
  repeated_word: 'Repeated word',
  self_correction: 'Self-correction',
  repetitive_opener: 'Repeated opener',
  repeated_passage: 'Read more than once',
  critical_mismatch: 'Critical mismatch',
  boundary_shaped: 'Boundary landed',
  boundary_unshaped: 'Boundary ran on',
  emphasis_observation: 'Emphasis',
};

/**
 * An annotation plus the span it should land in when it has no token anchor.
 * Token anchors always win; the hint exists for span-addressed observations
 * (a critical finding, an emphasis phrase) that never had a token.
 */
interface PlacedAnnotation {
  annotation: ScriptAnnotation;
  spanHint: string | null;
}

function disfluencyAnnotations(pass: TakePassRecord): ScriptAnnotation[] {
  const out: ScriptAnnotation[] = [];
  for (const filler of pass.fillers) {
    // §15.5: an authored, intentional disfluency is delivery, not a defect.
    if (filler.authoredIntentional) continue;
    // §16.1: only confirmed evidence may mark the script. A probable detection
    // sits on the timeline where its uncertainty is visible, not in the text.
    if (filler.confidence !== 'confirmed') continue;
    const kind = DISFLUENCY_ANNOTATION[filler.kind];
    if (kind === undefined) continue;
    out.push({
      annotationId: `ann_${kind}_${filler.eventId}`,
      kind,
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      atMs: filler.audioStartMs,
      scriptAnchorTokenId: filler.scriptAnchorTokenId,
      // §25.3: quote only a fixed-lexicon display form.
      label: filler.displayForm === null ? DISFLUENCY_LABEL[kind] : `“${filler.displayForm}”`,
      authoredFragment: null,
      spokenFragment: null,
      eventId: filler.eventId,
    });
  }
  return out;
}

function fidelityAnnotations(pass: TakePassRecord): PlacedAnnotation[] {
  return pass.criticalFindings.map((finding) => ({
    spanHint: finding.spanId,
    annotation: {
      annotationId: `ann_critical_${finding.findingId}`,
      kind: 'critical_mismatch' as const,
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      atMs: finding.atMs,
      scriptAnchorTokenId: finding.scriptAnchorTokenId,
      label: finding.selfCorrected ? 'Critical mismatch, self-corrected' : 'Critical mismatch',
      authoredFragment: finding.authoredFragment,
      spokenFragment: finding.spokenFragment,
      eventId: finding.findingId,
    },
  }));
}

function boundaryAnnotations(pass: TakePassRecord): ScriptAnnotation[] {
  const out: ScriptAnnotation[] = [];
  pass.boundaries.forEach((boundary, index) => {
    // §18.3 scores eligible boundaries only; a weak one carries no claim.
    if (boundary.strength !== 'strong' && boundary.strength !== 'paragraph') return;
    const kind: ScriptAnnotationKind = boundary.shaped ? 'boundary_shaped' : 'boundary_unshaped';
    out.push({
      annotationId: `ann_boundary_${pass.takePassId}_${index}`,
      kind,
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      atMs: boundary.atMs,
      scriptAnchorTokenId: boundary.scriptAnchorTokenId,
      label: DISFLUENCY_LABEL[kind],
      authoredFragment: null,
      spokenFragment: null,
      eventId: null,
    });
  });
  return out;
}

function emphasisAnnotations(pass: TakePassRecord): PlacedAnnotation[] {
  const out: PlacedAnnotation[] = [];
  for (const measurement of pass.emphasis) {
    // An unmeasurable emphasis span carries no observation at all (§17.11).
    if (!measurement.measurable) continue;
    out.push({
      // Emphasis is span-addressed; it never had a token anchor.
      spanHint: measurement.spanId,
      annotation: {
        annotationId: `ann_emphasis_${pass.takePassId}_${measurement.spanId}`,
        kind: 'emphasis_observation',
        takePassId: pass.takePassId,
        passOrdinal: pass.passOrdinal,
        atMs: pass.time.startMs,
        scriptAnchorTokenId: null,
        label: DISFLUENCY_LABEL.emphasis_observation,
        authoredFragment: null,
        spokenFragment: null,
        eventId: null,
      },
    });
  }
  return out;
}

/**
 * §31.4. Build the annotated script view.
 *
 * The returned structure shares the caller's {@link ReviewScriptPassage}
 * objects. Nothing is copied, rewritten, or re-serialized.
 */
export function annotateScript(
  script: ReviewScript,
  record: CoachingSessionRecord,
  options: AnnotationOptions = {},
): AnnotatedScript {
  const includeEmphasis = options.includeEmphasis ?? true;
  const includeBoundaries = options.includeBoundaries ?? true;
  const passes = [...record.passes].sort((a, b) => a.passOrdinal - b.passOrdinal);

  const byTokenId = new Map<string, string>();
  const spanIds = new Set<string>();
  for (const passage of script.passages) {
    spanIds.add(passage.spanId);
    for (const tokenId of passage.tokenIds) byTokenId.set(tokenId, passage.spanId);
  }

  const bySpan = new Map<string, ScriptAnnotation[]>();
  const unanchored: ScriptAnnotation[] = [];
  const passOrdinalsBySpan = new Map<string, Set<number>>();

  const place = (annotation: ScriptAnnotation, spanHint: string | null): void => {
    const anchored =
      annotation.scriptAnchorTokenId === null
        ? undefined
        : byTokenId.get(annotation.scriptAnchorTokenId);
    const spanId = anchored ?? (spanHint !== null && spanIds.has(spanHint) ? spanHint : undefined);
    if (spanId === undefined) {
      unanchored.push(annotation);
      return;
    }
    const list = bySpan.get(spanId);
    if (list === undefined) bySpan.set(spanId, [annotation]);
    else list.push(annotation);
  };

  for (const pass of passes) {
    for (const spanId of pass.coveredSpanIds) {
      if (!spanIds.has(spanId)) continue;
      const ordinals = passOrdinalsBySpan.get(spanId) ?? new Set<number>();
      ordinals.add(pass.passOrdinal);
      passOrdinalsBySpan.set(spanId, ordinals);
    }

    for (const annotation of disfluencyAnnotations(pass)) place(annotation, null);
    for (const placed of fidelityAnnotations(pass)) place(placed.annotation, placed.spanHint);
    if (includeBoundaries) {
      for (const annotation of boundaryAnnotations(pass)) place(annotation, null);
    }
    if (includeEmphasis) {
      for (const placed of emphasisAnnotations(pass)) place(placed.annotation, placed.spanHint);
    }
  }

  // §31.4 "repeated passages": a span read by more than one take pass.
  for (const [spanId, ordinals] of passOrdinalsBySpan) {
    if (ordinals.size < 2) continue;
    const sorted = [...ordinals].sort((a, b) => a - b);
    const lastOrdinal = sorted[sorted.length - 1] as number;
    const pass = passes.find((candidate) => candidate.passOrdinal === lastOrdinal);
    const annotation: ScriptAnnotation = {
      annotationId: `ann_repeated_${spanId}`,
      kind: 'repeated_passage',
      takePassId: pass?.takePassId ?? '',
      passOrdinal: lastOrdinal,
      atMs: pass?.time.startMs ?? 0,
      scriptAnchorTokenId: null,
      label: `Read in ${sorted.length} passes`,
      authoredFragment: null,
      spokenFragment: null,
      eventId: null,
    };
    const list = bySpan.get(spanId);
    if (list === undefined) bySpan.set(spanId, [annotation]);
    else list.push(annotation);
  }

  return {
    scriptId: script.scriptId,
    scriptRevision: script.scriptRevision,
    passages: script.passages.map((passage) => ({
      passage,
      annotations: (bySpan.get(passage.spanId) ?? []).sort(
        (a, b) => a.atMs - b.atMs || a.passOrdinal - b.passOrdinal,
      ),
      passOrdinals: [...(passOrdinalsBySpan.get(passage.spanId) ?? [])].sort((a, b) => a - b),
    })),
    unanchored,
    revisionMismatch: script.scriptRevision !== record.scriptRevision,
  };
}
