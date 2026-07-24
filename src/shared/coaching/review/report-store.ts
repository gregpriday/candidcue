/**
 * §36 persistence and §32 privacy for post-take reports.
 *
 * ---------------------------------------------------------------------------
 * THE STORE OWNS THE RULES; THE BACKEND OWNS THE BYTES.
 * ---------------------------------------------------------------------------
 * {@link ReviewReportPersistence} is injected. This module never calls Tauri,
 * never opens SQLite, and never touches the filesystem, so the consent rules
 * below are testable in memory and cannot be bypassed by a backend that means
 * well. {@link InMemoryReviewReportPersistence} is the reference backend used
 * by the tests; the real one maps onto the §36.2 tables described in
 * {@link REPORT_SQL_SCHEMA}.
 *
 * ---------------------------------------------------------------------------
 * §32.2 — THREE CONSENTS, ENFORCED SEPARATELY.
 * ---------------------------------------------------------------------------
 * "Saving a coaching report does not imply saving audio." Every save applies
 * all three toggles, in both directions:
 *
 * - `saveReport: false` → the report is deleted, not merely not written. A
 *   toggle the user turned off must remove what an earlier session left.
 * - `saveTranscript: false` → no transcript row is written *and* every
 *   transcript-derived string is redacted out of the report itself. This is
 *   the part that is easy to get wrong: a `spokenFragment` on a critical
 *   finding is transcript text wearing a different field name, and storing it
 *   under "metrics only" consent would be a quiet breach.
 * - `saveAudio: false` → the store asks the backend to delete the recording.
 *   It never writes audio itself.
 *
 * §32.3 is honoured by construction: the stored report is built field by field
 * from an allowlist, so a producer that starts attaching an inferred label to
 * an event cannot leak it into storage by accident.
 */
import type { SessionSummary } from './session-summary';
import { summarizeSession } from './session-summary';
import type {
  CoachingSessionRecord,
  RetentionConsent,
  TakePassRecord,
  TranscriptSegmentRecord,
} from './types';
import { REVIEW_SCHEMA_VERSION } from './types';

/* ---------------------------------------------------------------------------
 * Stored shapes (§36.2)
 * ------------------------------------------------------------------------- */

export interface StoredReportHeader {
  sessionId: string;
  scriptId: string;
  scriptRevision: number;
  /** Wall clock, for listing and ordering only. */
  startedAtIso: string;
  endedAtIso: string | null;
  durationMs: number;
  /** §36.3 provenance, so a report is never reinterpreted under a new formula. */
  schemaVersion: number;
  algorithmVersion: string;
  tipPolicyVersion: string;
  lunaPromptVersion: string;
  transcriptSaved: boolean;
  audioSaved: boolean;
}

/** One row of §36.2's `coaching_events`. */
export interface StoredCoachingEvent {
  id: string;
  sessionId: string;
  takePassId: string;
  eventType:
    | 'filler'
    | 'pause'
    | 'boundary'
    | 'terminal_rush'
    | 'tip_shown'
    | 'critical_finding'
    | 'retake';
  startMs: number;
  endMs: number;
  /** 0–1. `1` for an event that carries no confidence of its own. */
  confidence: number;
  scriptTokenId: string | null;
  /** Serialized to `payload_json`. Built from an allowlist, never spread. */
  payload: Readonly<Record<string, unknown>>;
}

export interface StoredCoachingReport {
  header: StoredReportHeader;
  /** Serialized to `coaching_sessions.summary_json`. */
  summary: SessionSummary;
  events: readonly StoredCoachingEvent[];
}

export interface StoredTranscript {
  sessionId: string;
  passes: ReadonlyArray<{
    takePassId: string;
    segments: readonly TranscriptSegmentRecord[];
  }>;
}

export interface ReportListQuery {
  scriptId?: string;
  /** Most recent first. */
  limit?: number;
}

/**
 * The backend seam. Every method is allowed to throw; the store does not
 * swallow errors, because a save that silently failed is worse than a visible
 * one when the user has just been told what is retained.
 */
export interface ReviewReportPersistence {
  saveReport(report: StoredCoachingReport): Promise<void>;
  loadReport(sessionId: string): Promise<StoredCoachingReport | null>;
  listReports(query?: ReportListQuery): Promise<StoredReportHeader[]>;
  deleteReport(sessionId: string): Promise<void>;
  saveTranscript(transcript: StoredTranscript): Promise<void>;
  loadTranscript(sessionId: string): Promise<StoredTranscript | null>;
  deleteTranscript(sessionId: string): Promise<void>;
  /**
   * Audio is written by the recorder, never by this store. The store only ever
   * asks for it to be removed.
   */
  deleteAudioRecording(sessionId: string): Promise<void>;
}

/* ---------------------------------------------------------------------------
 * Redaction (§32.2, §32.3)
 * ------------------------------------------------------------------------- */

/** Placeholder for a transcript-derived form that may not be retained. */
export function redactedForm(index: number): string {
  return `redacted_${index}`;
}

/**
 * Strip every transcript-derived string from a summary.
 *
 * Two things are transcript text even though neither field says so:
 * - `fidelity.findings[].spokenFragment` — literally what was heard;
 * - `fillers.byForm[].normalizedForm` where there is no `displayForm`, which is
 *   a contextual word lifted from the transcript (§25.3 already forbids
 *   showing it; §32.2 forbids keeping it).
 *
 * Counts, rates and timings survive intact, which is the point: a metrics-only
 * report is still a complete report.
 */
export function redactTranscriptDerived(summary: SessionSummary): SessionSummary {
  let redactionIndex = 0;
  const redactForms = (
    forms: SessionSummary['metrics']['fillers']['byForm'],
  ): SessionSummary['metrics']['fillers']['byForm'] =>
    forms.map((form) => {
      if (form.displayForm !== null) return form;
      redactionIndex += 1;
      return { ...form, normalizedForm: redactedForm(redactionIndex) };
    });

  const redactMetrics = (metrics: SessionSummary['metrics']): SessionSummary['metrics'] => {
    const byForm = redactForms(metrics.fillers.byForm);
    const top = metrics.fillers.mostFrequent.value;
    return {
      ...metrics,
      fillers: {
        ...metrics.fillers,
        byForm,
        mostFrequent:
          top === null || top.displayForm !== null
            ? metrics.fillers.mostFrequent
            : {
                value:
                  byForm.find((form) => form.count === top.count && form.firstAtMs === top.firstAtMs) ??
                  { ...top, normalizedForm: redactedForm(0) },
                absent: null,
              },
      },
      fidelity: {
        ...metrics.fidelity,
        findings: metrics.fidelity.findings.map((finding) => ({
          ...finding,
          spokenFragment: '',
        })),
      },
    };
  };

  return {
    ...summary,
    metrics: redactMetrics(summary.metrics),
    passes: summary.passes.map((pass) => ({ ...pass, metrics: redactMetrics(pass.metrics) })),
    transcriptAvailable: false,
  };
}

/* ---------------------------------------------------------------------------
 * Event projection (§36.2)
 * ------------------------------------------------------------------------- */

function passEvents(
  sessionId: string,
  pass: TakePassRecord,
  keepTranscriptText: boolean,
): StoredCoachingEvent[] {
  const events: StoredCoachingEvent[] = [];
  let redactionIndex = 0;

  for (const filler of pass.fillers) {
    if (filler.displayForm === null) redactionIndex += 1;
    events.push({
      id: filler.eventId,
      sessionId,
      takePassId: pass.takePassId,
      eventType: 'filler',
      startMs: filler.audioStartMs,
      endMs: filler.audioEndMs,
      confidence: filler.timingConfidence,
      scriptTokenId: filler.scriptAnchorTokenId,
      payload: {
        kind: filler.kind,
        // §32.2: a contextual form is transcript text.
        normalizedForm:
          filler.displayForm !== null || keepTranscriptText
            ? filler.normalizedForm
            : redactedForm(redactionIndex),
        displayForm: filler.displayForm,
        detectionConfidence: filler.confidence,
        evidenceSources: [...filler.evidenceSources],
        authoredIntentional: filler.authoredIntentional,
        countedLive: filler.countedLive,
      },
    });
  }

  pass.pauses.forEach((pause, index) => {
    events.push({
      id: `pause_${pass.takePassId}_${index}`,
      sessionId,
      takePassId: pass.takePassId,
      eventType: 'pause',
      startMs: pause.startMs,
      endMs: pause.endMs,
      confidence: 1,
      scriptTokenId: null,
      payload: {
        location: pause.location,
        explained: pause.explained === true,
        manual: pause.manual === true,
      },
    });
  });

  pass.boundaries.forEach((boundary, index) => {
    events.push({
      id: `boundary_${pass.takePassId}_${index}`,
      sessionId,
      takePassId: pass.takePassId,
      eventType: 'boundary',
      startMs: boundary.atMs,
      endMs: boundary.atMs,
      confidence: 1,
      scriptTokenId: boundary.scriptAnchorTokenId,
      payload: { strength: boundary.strength, shaped: boundary.shaped, spanId: boundary.spanId },
    });
  });

  pass.terminalRushSentences.forEach((sentence, index) => {
    events.push({
      id: `rush_${pass.takePassId}_${index}`,
      sessionId,
      takePassId: pass.takePassId,
      eventType: 'terminal_rush',
      startMs: sentence.startMs,
      endMs: sentence.endMs,
      confidence: 1,
      scriptTokenId: sentence.scriptAnchorTokenId,
      payload: {
        ratio: sentence.ratio,
        measurable: sentence.measurable,
        reason: sentence.reason,
        wordCount: sentence.wordCount,
      },
    });
  });

  for (const tip of pass.tipsShown) {
    events.push({
      id: tip.tipId,
      sessionId,
      takePassId: pass.takePassId,
      eventType: 'tip_shown',
      startMs: tip.shownAtMs,
      endMs: tip.hiddenAtMs ?? tip.shownAtMs,
      confidence: 1,
      scriptTokenId: tip.scriptAnchorTokenId,
      payload: {
        code: tip.code,
        textKey: tip.textKey,
        severity: tip.severity,
        interpolations: { ...tip.interpolations },
      },
    });
  }

  for (const finding of pass.criticalFindings) {
    events.push({
      id: finding.findingId,
      sessionId,
      takePassId: pass.takePassId,
      eventType: 'critical_finding',
      startMs: finding.atMs,
      endMs: finding.endMs,
      confidence: finding.localConfidence,
      scriptTokenId: finding.scriptAnchorTokenId,
      payload: {
        kind: finding.kind,
        // Authored script text is the user's own document and is retained.
        authoredFragment: finding.authoredFragment,
        // What was heard is transcript text (§32.2).
        spokenFragment: keepTranscriptText ? finding.spokenFragment : '',
        selfCorrected: finding.selfCorrected,
        spanId: finding.spanId,
      },
    });
  }

  if (pass.passOrdinal > 1) {
    events.push({
      id: `retake_${pass.takePassId}`,
      sessionId,
      takePassId: pass.takePassId,
      eventType: 'retake',
      startMs: pass.time.startMs,
      endMs: pass.time.startMs,
      confidence: 1,
      scriptTokenId: null,
      payload: { passOrdinal: pass.passOrdinal },
    });
  }

  return events;
}

/* ---------------------------------------------------------------------------
 * The store
 * ------------------------------------------------------------------------- */

export type SaveSkipReason = 'report_consent_not_given';

export type SaveOutcome =
  | {
      saved: true;
      report: StoredCoachingReport;
      transcriptSaved: boolean;
      audioRetained: boolean;
    }
  | { saved: false; reason: SaveSkipReason };

/** §32.2. Exactly what a save did and did not keep, for the UI to state. */
export interface RetentionStatement {
  report: boolean;
  transcript: boolean;
  audio: boolean;
  /** Authored sentences, in the order the UI should show them. */
  lines: readonly string[];
}

/**
 * §32.2 "The UI must state exactly what is retained."
 *
 * One line per toggle, always, whatever the combination. The three consents
 * really are independent — a user may keep the audio of a take whose metrics
 * they discard — so a statement that collapses them into "nothing is saved"
 * the moment the report toggle goes off would be wrong, and wrong in the
 * direction that matters.
 */
export function retentionStatement(
  consent: RetentionConsent,
  audioAvailable: boolean,
): RetentionStatement {
  const audio = consent.saveAudio && audioAvailable;
  const lines: string[] = [
    consent.saveReport
      ? 'Your coaching measurements for this take are saved on this device.'
      : 'Your coaching measurements are not saved.',
    consent.saveTranscript
      ? 'The transcript of what you said is saved.'
      : 'The transcript is not saved, and words heard but not scripted are not kept.',
    audio
      ? 'The audio recording of this take is saved.'
      : consent.saveAudio
        ? 'No audio recording was made for this take.'
        : 'No audio is saved.',
  ];
  if (!consent.saveReport && !consent.saveTranscript && !audio) {
    lines.push('Closing this review discards everything from the take.');
  }
  return { report: consent.saveReport, transcript: consent.saveTranscript, audio, lines };
}

export class ReportStore {
  constructor(private readonly persistence: ReviewReportPersistence) {}

  /**
   * §36. Persist a finished session, applying §32.2 consent in both
   * directions: a toggle that is off removes what an earlier save left.
   */
  async save(record: CoachingSessionRecord): Promise<SaveOutcome> {
    const { consent } = record;

    if (!consent.saveAudio) {
      await this.persistence.deleteAudioRecording(record.sessionId);
    }
    if (!consent.saveTranscript) {
      await this.persistence.deleteTranscript(record.sessionId);
    }
    if (!consent.saveReport) {
      await this.persistence.deleteReport(record.sessionId);
      return { saved: false, reason: 'report_consent_not_given' };
    }

    const report = buildStoredReport(record);
    await this.persistence.saveReport(report);

    let transcriptSaved = false;
    if (consent.saveTranscript) {
      const passes = record.passes
        .filter((pass) => pass.transcript !== null)
        .map((pass) => ({
          takePassId: pass.takePassId,
          segments: pass.transcript ?? [],
        }));
      if (passes.length > 0) {
        await this.persistence.saveTranscript({ sessionId: record.sessionId, passes });
        transcriptSaved = true;
      }
    }

    return {
      saved: true,
      report,
      transcriptSaved,
      audioRetained: consent.saveAudio && record.audio.available,
    };
  }

  load(sessionId: string): Promise<StoredCoachingReport | null> {
    return this.persistence.loadReport(sessionId);
  }

  /**
   * The transcript, when one was retained. Returns `null` rather than
   * throwing, so a report renders fine without it (§32.2).
   */
  loadTranscript(sessionId: string): Promise<StoredTranscript | null> {
    return this.persistence.loadTranscript(sessionId);
  }

  /** §31.6 history, most recent first. */
  list(query?: ReportListQuery): Promise<StoredReportHeader[]> {
    return this.persistence.listReports(query);
  }

  /** Remove everything for one session — report, transcript and audio. */
  async forget(sessionId: string): Promise<void> {
    await this.persistence.deleteAudioRecording(sessionId);
    await this.persistence.deleteTranscript(sessionId);
    await this.persistence.deleteReport(sessionId);
  }
}

/**
 * Build the stored report from a record, by explicit projection.
 *
 * Nothing is spread from the input record at the top level: every field is
 * named. A producer that starts attaching extra properties — an inferred
 * label, a demographic guess (§32.3) — cannot leak them into storage here.
 */
export function buildStoredReport(record: CoachingSessionRecord): StoredCoachingReport {
  const keepTranscriptText = record.consent.saveTranscript;
  const summary = summarizeSession(record);
  const durationMs = summary.metrics.time.spanMs;
  return {
    header: {
      sessionId: record.sessionId,
      scriptId: record.scriptId,
      scriptRevision: record.scriptRevision,
      startedAtIso: record.startedAtIso,
      endedAtIso: record.endedAtIso,
      durationMs,
      schemaVersion: REVIEW_SCHEMA_VERSION,
      algorithmVersion: record.versions.algorithmVersion,
      tipPolicyVersion: record.versions.tipPolicyVersion,
      lunaPromptVersion: record.versions.lunaPromptVersion,
      transcriptSaved: keepTranscriptText && record.passes.some((pass) => pass.transcript !== null),
      audioSaved: record.consent.saveAudio && record.audio.available,
    },
    summary: keepTranscriptText ? summary : redactTranscriptDerived(summary),
    events: record.passes.flatMap((pass) =>
      passEvents(record.sessionId, pass, keepTranscriptText),
    ),
  };
}

/* ---------------------------------------------------------------------------
 * Reference backend
 * ------------------------------------------------------------------------- */

/** In-memory backend. Used by tests and by a session with saving turned off. */
export class InMemoryReviewReportPersistence implements ReviewReportPersistence {
  private readonly reports = new Map<string, StoredCoachingReport>();
  private readonly transcripts = new Map<string, StoredTranscript>();
  private readonly audio = new Set<string>();

  /** Test seam: pretend the recorder wrote audio for this session. */
  noteAudioRecording(sessionId: string): void {
    this.audio.add(sessionId);
  }

  hasAudioRecording(sessionId: string): boolean {
    return this.audio.has(sessionId);
  }

  async saveReport(report: StoredCoachingReport): Promise<void> {
    // Round-trip through JSON so the in-memory backend behaves like a real
    // one: a value that cannot be serialized fails here, not in production.
    this.reports.set(report.header.sessionId, JSON.parse(JSON.stringify(report)));
  }

  async loadReport(sessionId: string): Promise<StoredCoachingReport | null> {
    return this.reports.get(sessionId) ?? null;
  }

  async listReports(query: ReportListQuery = {}): Promise<StoredReportHeader[]> {
    const headers = [...this.reports.values()]
      .map((report) => report.header)
      .filter((header) => query.scriptId === undefined || header.scriptId === query.scriptId)
      .sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso));
    return query.limit === undefined ? headers : headers.slice(0, query.limit);
  }

  async deleteReport(sessionId: string): Promise<void> {
    this.reports.delete(sessionId);
  }

  async saveTranscript(transcript: StoredTranscript): Promise<void> {
    this.transcripts.set(transcript.sessionId, JSON.parse(JSON.stringify(transcript)));
  }

  async loadTranscript(sessionId: string): Promise<StoredTranscript | null> {
    return this.transcripts.get(sessionId) ?? null;
  }

  async deleteTranscript(sessionId: string): Promise<void> {
    this.transcripts.delete(sessionId);
  }

  async deleteAudioRecording(sessionId: string): Promise<void> {
    this.audio.delete(sessionId);
  }
}

/* ---------------------------------------------------------------------------
 * §36.2 schema
 * ------------------------------------------------------------------------- */

/**
 * The SQLite schema this store expects, as an addition to §36.2. Kept here as
 * a string so the Rust side and these tests cannot drift on the column names,
 * and so the reason for each deviation from §36.2 travels with it:
 *
 * - `coaching_sessions` gains the §36.3 provenance columns (`schema_version`,
 *   `algorithm_version`, `tip_policy_version`, `luna_prompt_version`), because
 *   §36.3 requires them on every stored report and §36.2's sketch has nowhere
 *   to put them.
 * - `coaching_transcripts` is a separate table, not a column, so revoking
 *   transcript consent is one `DELETE` that cannot orphan the report (§32.2).
 * - There is no audio table. Audio is a file the recorder owns; the store only
 *   records whether one was kept.
 */
export const REPORT_SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS coaching_sessions (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  script_revision INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  tip_policy_version TEXT NOT NULL,
  luna_prompt_version TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  transcript_saved INTEGER NOT NULL DEFAULT 0,
  audio_saved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS coaching_events (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  take_pass_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  confidence REAL NOT NULL,
  script_token_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY(session_id) REFERENCES coaching_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_coaching_events_session_time
  ON coaching_events(session_id, start_ms);

CREATE TABLE IF NOT EXISTS coaching_transcripts (
  session_id TEXT PRIMARY KEY,
  passes_json TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES coaching_sessions(id) ON DELETE CASCADE
);
`;
