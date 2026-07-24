/**
 * Prepared semantic landmark cache and bounded retrieval (companion §37.2,
 * §37.3, §39.3).
 *
 * Landmarks are opaque IDs with a concise proposition. Token ranges are joined
 * from local compiler data and are NEVER accepted from Luna. Retrieval is
 * restricted to the current hard section plus the ordinary sequential boundary
 * corridor already allowed by the section graph — a semantic match in a distant
 * chapter is not a reason to send that chapter (§37.2).
 */
import { landmarkSetHash } from './hash';
import type {
  LandmarkAnnotation,
  SemanticCandidateWindow,
  SemanticLandmarkPreparationResult,
} from './types';

export type LandmarkLevel = 'paragraph' | 'sentence';

/** A span the local compiler knows the exact position of. */
export interface LandmarkSpan {
  spanId: string;
  sectionId: string;
  level: LandmarkLevel;
  startTokenIndex: number;
  endTokenIndex: number;
  /** Exact script text, used to build a preparation request. */
  text: string;
}

/** A prepared landmark: local geometry joined with the model's annotation. */
export interface PreparedLandmark extends LandmarkSpan {
  annotation: LandmarkAnnotation;
}

export interface LandmarkRetrievalOptions {
  /** Hard section the presenter is currently in. */
  currentSectionId: string;
  /**
   * The single next section the section graph already permits by sequential
   * reading, if any. Anything else is ineligible (§37.2, §4.6).
   */
  boundarySectionId?: string;
  /** Prefer paragraph landmarks near this token index. */
  cursorTokenIndex: number;
  /** Hard cap on landmarks in one request (keeps context compact, §37.5). */
  maxLandmarks?: number;
  level: LandmarkLevel;
}

export interface LandmarkRetrievalSet {
  landmarks: PreparedLandmark[];
  landmarkSetHash: string;
}

const DEFAULT_MAX_LANDMARKS = 24;

/**
 * Per-script landmark store. One index instance is valid for exactly one
 * `scriptCompileHash`; a recompile must build a new one.
 */
export class SemanticLandmarkIndex {
  private readonly bySection = new Map<string, PreparedLandmark[]>();
  private readonly byId = new Map<string, PreparedLandmark>();
  private readonly preparedSections = new Set<string>();

  constructor(readonly scriptCompileHash: string) {}

  /** Sections with a valid prepared index (§37.4 prohibits recovery without one). */
  hasSection(sectionId: string): boolean {
    return this.preparedSections.has(sectionId);
  }

  get preparedSectionCount(): number {
    return this.preparedSections.size;
  }

  /**
   * Join a validated preparation result with local spans (§39.3). Annotations
   * for unknown span IDs are ignored; spans without an annotation are simply
   * absent, which callers treat as "not prepared".
   */
  ingest(result: SemanticLandmarkPreparationResult, spans: readonly LandmarkSpan[]): number {
    if (result.scriptCompileHash !== this.scriptCompileHash) return 0;
    const spansById = new Map(spans.map((s) => [s.spanId, s]));
    const accepted: PreparedLandmark[] = [];
    for (const annotation of result.annotations) {
      const span = spansById.get(annotation.spanId);
      if (span === undefined) continue;
      if (span.sectionId !== result.sectionId) continue;
      const landmark: PreparedLandmark = { ...span, annotation };
      accepted.push(landmark);
      this.byId.set(landmark.spanId, landmark);
    }
    if (accepted.length === 0) return 0;
    const existing = this.bySection.get(result.sectionId) ?? [];
    const merged = [
      ...existing.filter((l) => !accepted.some((a) => a.spanId === l.spanId)),
      ...accepted,
    ].sort((a, b) => a.startTokenIndex - b.startTokenIndex);
    this.bySection.set(result.sectionId, merged);
    this.preparedSections.add(result.sectionId);
    return accepted.length;
  }

  /** Spans in a section that still need annotation, for a preparation request. */
  pendingSpans(spans: readonly LandmarkSpan[]): LandmarkSpan[] {
    return spans.filter((s) => !this.byId.has(s.spanId));
  }

  /**
   * Build a bounded, eligible landmark set for a retrieval request.
   * Paragraph-level landmarks are queried first and sentence-level second
   * (§37.2), and the set is centred on the reading cursor.
   */
  retrievalSet(options: LandmarkRetrievalOptions): LandmarkRetrievalSet | null {
    if (!this.hasSection(options.currentSectionId)) return null;
    const limit = Math.max(1, options.maxLandmarks ?? DEFAULT_MAX_LANDMARKS);

    const eligibleSections = [options.currentSectionId];
    if (
      options.boundarySectionId !== undefined &&
      options.boundarySectionId !== options.currentSectionId &&
      this.hasSection(options.boundarySectionId)
    ) {
      eligibleSections.push(options.boundarySectionId);
    }

    const pool: PreparedLandmark[] = [];
    for (const sectionId of eligibleSections) {
      for (const landmark of this.bySection.get(sectionId) ?? []) {
        if (landmark.level === options.level) pool.push(landmark);
      }
    }
    if (pool.length === 0) return null;

    const ranked = [...pool].sort(
      (a, b) =>
        distanceTo(a, options.cursorTokenIndex) - distanceTo(b, options.cursorTokenIndex) ||
        a.startTokenIndex - b.startTokenIndex,
    );
    const landmarks = ranked
      .slice(0, limit)
      .sort((a, b) => a.startTokenIndex - b.startTokenIndex);

    return {
      landmarks,
      landmarkSetHash: landmarkSetHash(
        landmarks.map((l) => ({ id: l.spanId, proposition: l.annotation.proposition })),
      ),
    };
  }

  /**
   * Turn validated landmark IDs into exact candidate windows (§37.3 step 3).
   * IDs outside the eligible sections are dropped — a landmark result can
   * never open a window the section graph prohibits.
   */
  resolveWindows(
    landmarkIds: readonly string[],
    eligibleSectionIds: readonly string[],
    paddingTokens = 40,
  ): SemanticCandidateWindow[] {
    const eligible = new Set(eligibleSectionIds);
    const windows: SemanticCandidateWindow[] = [];
    for (const id of landmarkIds) {
      const landmark = this.byId.get(id);
      if (landmark === undefined) continue;
      if (!eligible.has(landmark.sectionId)) continue;
      windows.push({
        landmarkId: id,
        sectionId: landmark.sectionId,
        startTokenIndex: Math.max(0, landmark.startTokenIndex - paddingTokens),
        endTokenIndex: landmark.endTokenIndex + paddingTokens,
      });
    }
    return windows;
  }

  get(landmarkId: string): PreparedLandmark | undefined {
    return this.byId.get(landmarkId);
  }
}

function distanceTo(landmark: PreparedLandmark, cursorTokenIndex: number): number {
  if (cursorTokenIndex < landmark.startTokenIndex) return landmark.startTokenIndex - cursorTokenIndex;
  if (cursorTokenIndex > landmark.endTokenIndex) return cursorTokenIndex - landmark.endTokenIndex;
  return 0;
}
