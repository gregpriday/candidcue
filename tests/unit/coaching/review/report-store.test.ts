/**
 * §36 persistence and §32 privacy.
 *
 * The interesting assertions are all about what is *not* stored. Each one
 * searches the serialized payload for the string that must not be there, so
 * they fail if a future refactor spreads a record instead of projecting it —
 * which is exactly how this class of leak happens.
 */
import { describe, expect, it } from 'vitest';
import {
  buildStoredReport,
  InMemoryReviewReportPersistence,
  ReportStore,
  retentionStatement,
  REPORT_SQL_SCHEMA,
} from '../../../../src/shared/coaching/review/report-store';
import { makeFiller, makePass, makeRecord } from './support';
import type {
  CriticalFindingRecord,
  RetentionConsent,
} from '../../../../src/shared/coaching/review/types';

const finding: CriticalFindingRecord = {
  findingId: 'f1',
  kind: 'critical_number_mismatch',
  atMs: 1_000,
  endMs: 1_500,
  takePassId: 'pass-1',
  spanId: 'span-b',
  scriptAnchorTokenId: 't4',
  authoredFragment: 'forty percent',
  spokenFragment: 'fourteen percent and then I lost my place',
  localConfidence: 0.9,
  selfCorrected: false,
};

function recordWith(consent: RetentionConsent) {
  return makeRecord(
    [
      makePass({
        fillers: [
          makeFiller({ atMs: 1_000, normalizedForm: 'um' }),
          makeFiller({
            atMs: 2_000,
            kind: 'contextual',
            normalizedForm: 'basically',
            scriptAnchorTokenId: 't1',
          }),
        ],
        criticalFindings: [finding],
        transcript: [
          { startMs: 0, endMs: 4_000, text: 'fourteen percent and then I lost my place', final: true },
        ],
      }),
    ],
    { consent },
  );
}

describe('§32.2 consent is applied in both directions', () => {
  it('saves nothing and removes anything earlier when report consent is off', async () => {
    const backend = new InMemoryReviewReportPersistence();
    const store = new ReportStore(backend);
    backend.noteAudioRecording('session-1');

    await store.save(recordWith({ saveReport: true, saveTranscript: true, saveAudio: true }));
    expect(await store.load('session-1')).not.toBeNull();

    const outcome = await store.save(
      recordWith({ saveReport: false, saveTranscript: false, saveAudio: false }),
    );
    expect(outcome).toEqual({ saved: false, reason: 'report_consent_not_given' });
    expect(await store.load('session-1')).toBeNull();
    expect(await store.loadTranscript('session-1')).toBeNull();
    expect(backend.hasAudioRecording('session-1')).toBe(false);
  });

  it('saves the report without the transcript when only metrics are consented', async () => {
    const backend = new InMemoryReviewReportPersistence();
    const store = new ReportStore(backend);
    const outcome = await store.save(
      recordWith({ saveReport: true, saveTranscript: false, saveAudio: false }),
    );
    expect(outcome.saved).toBe(true);
    expect(outcome.saved && outcome.transcriptSaved).toBe(false);
    expect(await store.loadTranscript('session-1')).toBeNull();
    expect(await store.load('session-1')).not.toBeNull();
  });

  it('saves the transcript separately when that consent is given', async () => {
    const backend = new InMemoryReviewReportPersistence();
    const store = new ReportStore(backend);
    const outcome = await store.save(
      recordWith({ saveReport: true, saveTranscript: true, saveAudio: false }),
    );
    expect(outcome.saved && outcome.transcriptSaved).toBe(true);
    const transcript = await store.loadTranscript('session-1');
    expect(transcript?.passes[0]?.segments[0]?.text).toBe(
      'fourteen percent and then I lost my place',
    );
  });

  it('deletes the audio recording when audio consent is off, and keeps it when on', async () => {
    const backend = new InMemoryReviewReportPersistence();
    const store = new ReportStore(backend);
    backend.noteAudioRecording('session-1');
    await store.save(recordWith({ saveReport: true, saveTranscript: false, saveAudio: false }));
    expect(backend.hasAudioRecording('session-1')).toBe(false);

    backend.noteAudioRecording('session-1');
    await store.save(recordWith({ saveReport: true, saveTranscript: false, saveAudio: true }));
    expect(backend.hasAudioRecording('session-1')).toBe(true);
  });

  it('records audioSaved only when a recording actually existed', async () => {
    const withAudio = buildStoredReport(
      makeRecord([makePass()], {
        consent: { saveReport: true, saveTranscript: false, saveAudio: true },
        audio: { available: true, recordingId: 'rec-1', durationMs: 1_000 },
      }),
    );
    expect(withAudio.header.audioSaved).toBe(true);

    const withoutAudio = buildStoredReport(
      makeRecord([makePass()], {
        consent: { saveReport: true, saveTranscript: false, saveAudio: true },
        audio: { available: false, reason: 'recording_not_enabled' },
      }),
    );
    expect(withoutAudio.header.audioSaved).toBe(false);
  });
});

describe('transcript-derived text is redacted without transcript consent', () => {
  const metricsOnly = buildStoredReport(
    recordWith({ saveReport: true, saveTranscript: false, saveAudio: false }),
  );
  const serialized = JSON.stringify(metricsOnly);

  it('keeps no spoken fragment anywhere in the stored report', () => {
    expect(serialized).not.toContain('fourteen percent');
    expect(serialized).not.toContain('lost my place');
  });

  it('keeps the authored script fragment, which is the user’s own document', () => {
    expect(serialized).toContain('forty percent');
  });

  it('keeps no contextual filler word, which is transcript text', () => {
    expect(serialized).not.toContain('basically');
  });

  it('keeps the fixed-lexicon form, which is not transcript text (§25.3)', () => {
    expect(serialized).toContain('"um"');
  });

  it('keeps the counts intact — a metrics-only report is still complete', () => {
    expect(metricsOnly.summary.metrics.fillers.confirmedCount).toBe(2);
    expect(metricsOnly.summary.metrics.fidelity.criticalDiscrepancyCount).toBe(1);
    expect(metricsOnly.summary.metrics.fillers.byForm).toHaveLength(2);
  });

  it('keeps the spoken fragment when transcript consent is given', () => {
    const full = buildStoredReport(
      recordWith({ saveReport: true, saveTranscript: true, saveAudio: false }),
    );
    expect(JSON.stringify(full)).toContain('fourteen percent');
    expect(JSON.stringify(full)).toContain('basically');
  });
});

describe('§32.3 nothing beyond the allowlist is stored', () => {
  it('drops an inferred label a producer hung off the record', () => {
    const record = recordWith({ saveReport: true, saveTranscript: true, saveAudio: false });
    const contaminated = {
      ...record,
      inferredConfidenceProfile: 'anxious presenter',
      profile: { ...record.profile, inferredAgeBand: '35-44' },
      passes: record.passes.map((pass) => ({
        ...pass,
        fillers: pass.fillers.map((filler) => ({ ...filler, inferredMood: 'nervous' })),
      })),
    };
    const serialized = JSON.stringify(
      buildStoredReport(contaminated as unknown as typeof record),
    );
    expect(serialized).not.toContain('anxious presenter');
    expect(serialized).not.toContain('inferredAgeBand');
    expect(serialized).not.toContain('nervous');
    expect(serialized).not.toContain('inferredMood');
  });
});

describe('§36.3 provenance travels with every report', () => {
  it('stores the schema, algorithm, tip-policy and prompt versions', () => {
    const report = buildStoredReport(
      recordWith({ saveReport: true, saveTranscript: false, saveAudio: false }),
    );
    expect(report.header.schemaVersion).toBe(1);
    expect(report.header.algorithmVersion).toBe('alg-1');
    expect(report.header.tipPolicyVersion).toBe('tip-1');
    expect(report.header.lunaPromptVersion).toBe('luna-1');
    expect(report.summary.versions.transcriptionModels).toEqual(['gpt-realtime-mini']);
  });
});

describe('§36.2 events', () => {
  it('projects one row per recorded event, typed', () => {
    const report = buildStoredReport(
      makeRecord([
        makePass({
          passOrdinal: 1,
          fillers: [makeFiller({ atMs: 1_000 })],
          pauses: [{ startMs: 2_000, endMs: 2_400, location: 'sentence_boundary' }],
          boundaries: [
            { atMs: 2_400, strength: 'strong', shaped: true, spanId: 'span-a', scriptAnchorTokenId: 't3' },
          ],
          criticalFindings: [finding],
          tipsShown: [
            {
              tipId: 'tip-1',
              code: 'PACE_EASE_BACK',
              textKey: 'pace.ease_back',
              interpolations: {},
              severity: 'gentle',
              shownAtMs: 3_000,
              hiddenAtMs: 6_000,
              takePassId: 'pass-1',
              scriptAnchorTokenId: null,
              spanId: null,
            },
          ],
        }),
      ]),
    );
    expect(report.events.map((event) => event.eventType)).toEqual([
      'filler',
      'pause',
      'boundary',
      'tip_shown',
      'critical_finding',
    ]);
    expect(report.events.every((event) => event.sessionId === 'session-1')).toBe(true);
    expect(report.events.every((event) => event.takePassId === 'pass-1')).toBe(true);
  });

  it('emits a retake row for every pass after the first', () => {
    const report = buildStoredReport(
      makeRecord([
        makePass({ takePassId: 'p1', passOrdinal: 1, startMs: 0, endMs: 10_000 }),
        makePass({ takePassId: 'p2', passOrdinal: 2, startMs: 10_000, endMs: 20_000 }),
      ]),
    );
    const retakes = report.events.filter((event) => event.eventType === 'retake');
    expect(retakes).toHaveLength(1);
    expect(retakes[0]?.takePassId).toBe('p2');
    expect(retakes[0]?.startMs).toBe(10_000);
  });
});

describe('round trip and history', () => {
  it('loads back what it stored and lists newest first', async () => {
    const backend = new InMemoryReviewReportPersistence();
    const store = new ReportStore(backend);
    await store.save(
      makeRecord([makePass()], {
        sessionId: 'older',
        startedAtIso: '2026-07-01T09:00:00.000Z',
        consent: { saveReport: true, saveTranscript: false, saveAudio: false },
      }),
    );
    await store.save(
      makeRecord([makePass()], {
        sessionId: 'newer',
        startedAtIso: '2026-07-02T09:00:00.000Z',
        consent: { saveReport: true, saveTranscript: false, saveAudio: false },
      }),
    );
    const headers = await store.list();
    expect(headers.map((header) => header.sessionId)).toEqual(['newer', 'older']);
    const loaded = await store.load('older');
    expect(loaded?.summary.metrics.pace.audibleWpm.value).toBe(150);
  });

  it('forgets everything for a session on request', async () => {
    const backend = new InMemoryReviewReportPersistence();
    const store = new ReportStore(backend);
    backend.noteAudioRecording('session-1');
    await store.save(recordWith({ saveReport: true, saveTranscript: true, saveAudio: true }));
    await store.forget('session-1');
    expect(await store.load('session-1')).toBeNull();
    expect(await store.loadTranscript('session-1')).toBeNull();
    expect(backend.hasAudioRecording('session-1')).toBe(false);
  });
});

describe('§32.2 the UI must state exactly what is retained', () => {
  it('states metrics-only retention', () => {
    expect(
      retentionStatement({ saveReport: true, saveTranscript: false, saveAudio: false }, false).lines,
    ).toEqual([
      'Your coaching measurements for this take are saved on this device.',
      'The transcript is not saved, and words heard but not scripted are not kept.',
      'No audio is saved.',
    ]);
  });

  it('says so plainly when nothing at all is retained', () => {
    const statement = retentionStatement(
      { saveReport: false, saveTranscript: false, saveAudio: false },
      true,
    );
    expect(statement.lines).toEqual([
      'Your coaching measurements are not saved.',
      'The transcript is not saved, and words heard but not scripted are not kept.',
      'No audio is saved.',
      'Closing this review discards everything from the take.',
    ]);
    expect(statement.audio).toBe(false);
  });

  it('keeps the three toggles independent rather than collapsing them', () => {
    // Audio kept, metrics discarded, is a legitimate combination under §32.2.
    const statement = retentionStatement(
      { saveReport: false, saveTranscript: false, saveAudio: true },
      true,
    );
    expect(statement.audio).toBe(true);
    expect(statement.report).toBe(false);
    expect(statement.lines).toContain('Your coaching measurements are not saved.');
    expect(statement.lines).toContain('The audio recording of this take is saved.');
    expect(statement.lines).not.toContain('Closing this review discards everything from the take.');
  });

  it('does not claim audio is saved when no recording was made', () => {
    const statement = retentionStatement(
      { saveReport: true, saveTranscript: true, saveAudio: true },
      false,
    );
    expect(statement.audio).toBe(false);
    expect(statement.lines).toContain('No audio recording was made for this take.');
  });
});

describe('the declared schema', () => {
  it('names every column the store actually writes', () => {
    for (const column of [
      'schema_version',
      'algorithm_version',
      'tip_policy_version',
      'luna_prompt_version',
      'summary_json',
      'transcript_saved',
      'audio_saved',
      'payload_json',
      'take_pass_id',
    ]) {
      expect(REPORT_SQL_SCHEMA).toContain(column);
    }
    // §32.2: the transcript is a separate table so consent can be revoked
    // with one delete.
    expect(REPORT_SQL_SCHEMA).toContain('coaching_transcripts');
  });
});
