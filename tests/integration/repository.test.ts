import { SqliteRepository } from '@main/persistence/sqlite-repository';
import { MemoryRepository } from '@main/persistence/memory-repository';
import { hashProjectPreparationFromDocuments } from '@shared/utils';
import { newId } from '@shared/domain';
import type {
  CandidCueRepository,
} from '@shared/contracts/repository';
import type {
  SaveProjectInput,
  InterviewPlan,
  InterviewBrief,
  CreateSessionInput,
  SessionCoverageItem,
  SessionSettingsSnapshot,
  InterviewTurn,
  AppendTurnInput,
  QuestionRecord,
  AnswerRecord,
  ProjectId,
  PlanId,
} from '@shared/domain';

// --- fixtures --------------------------------------------------------------

function projectInput(overrides: Partial<SaveProjectInput> = {}): SaveProjectInput {
  return {
    title: 'How we shipped CandidCue',
    audience: 'Indie founders',
    intendedOutcome: 'A narrative case study',
    targetMode: 'question_count',
    targetValue: 12,
    interviewerCharacterId: 'mira',
    notesToInterviewer: 'Keep it warm.',
    documents: [
      {
        kind: 'primary',
        title: 'Brief',
        mimeType: 'text/markdown',
        content: '# The story\nWe started in a garage.',
        sortOrder: 0,
      },
      {
        kind: 'reference',
        title: 'Notes',
        mimeType: 'text/plain',
        content: 'Mention the pivot.',
        sortOrder: 1,
      },
    ],
    ...overrides,
  };
}

function emptyBrief(): InterviewBrief {
  return {
    title: 'How we shipped CandidCue',
    oneSentencePremise: 'A founder reflects on shipping a hard product.',
    audience: 'Indie founders',
    intendedOutcome: 'A narrative case study',
    recommendedTone: 'warm',
    factualAnchors: [],
    terminology: [],
    coverageItems: [],
    arc: [],
    exclusions: [],
    openingQuestion: {
      text: 'Where did this all start?',
      type: 'opening',
      targetCoverageItemIds: [],
      useWhen: 'always first',
    },
    fallbackQuestions: [],
    closingStrategy: 'Thank the guest and recap.',
  };
}

function planFor(projectId: ProjectId, version: number, id: PlanId): InterviewPlan {
  return {
    id,
    projectId,
    version,
    sourceHash: 'hash-' + version,
    status: 'ready',
    brief: emptyBrief(),
    promptVersion: 'preparation@1.0.0',
    createdAt: new Date().toISOString(),
  };
}

function settingsSnapshot(): SessionSettingsSnapshot {
  return {
    endpointMode: 'balanced',
    captionsEnabled: true,
    mirrorStage: false,
    zoom: 1,
    verticalOffsetPercent: 0,
    maxQuestionWords: 42,
    maxQuestionAudioMs: 15000,
    recentTurnCount: 6,
    characterId: 'mira',
    ttsVoiceId: 'mira-voice',
  };
}

function coverageItem(id: string, overrides: Partial<SessionCoverageItem> = {}): SessionCoverageItem {
  return {
    id,
    label: 'Origin story',
    objective: 'Understand the founding moment',
    priority: 'must',
    status: 'not_started',
    evidenceTurnIds: [],
    maxFollowUps: 2,
    sourceRefs: [{ documentId: 'doc-1', startLine: 1, endLine: 3 }],
    followUpCount: 0,
    ...overrides,
  };
}

function sessionInput(
  projectId: ProjectId,
  planId: PlanId,
  coverage: SessionCoverageItem[],
): CreateSessionInput {
  return {
    projectId,
    planVersionId: planId,
    characterId: 'mira',
    endpointMode: 'balanced',
    selectedInputDeviceId: 'mic-1',
    selectedOutputDeviceId: 'spk-1',
    selectedDisplayId: 'display-1',
    settingsSnapshot: settingsSnapshot(),
    coverage,
  };
}

function questionRecord(): QuestionRecord {
  return {
    text: 'Where did this all start?',
    type: 'opening',
    targetCoverageItemIds: ['c1'],
    modelId: 'gpt-5.5',
    promptVersion: 'interviewer@1.0.0',
    generatedAt: new Date().toISOString(),
    ttsProvider: 'inworld',
    ttsVoiceId: 'mira-voice',
    audioDurationMs: 3200,
    mediaPlan: null,
    generationLatencyMs: 800,
    ttsLatencyMs: 600,
    source: 'opening_cache',
  };
}

function fullAnswer(cleaned: string): AnswerRecord {
  return {
    rawTranscript: 'um it started in a garage',
    cleanedTranscript: cleaned,
    userEditedTranscript: null,
    transcriptParagraphs: [cleaned],
    uncertainTerms: [],
    endpointReason: 'automatic',
    speechStartedAt: new Date().toISOString(),
    speechEndedAt: new Date().toISOString(),
    durationMs: 5000,
    sttProvider: 'inworld',
    sttModelId: 'inworld-stt-1',
    cleanupModelId: 'gpt-5.4-mini',
    moderation: null,
    sttLatencyMs: 400,
    cleanupLatencyMs: 700,
    recoveredFromBufferedAudio: false,
  };
}

function turn(
  sessionId: string,
  ordinal: number,
  overrides: Partial<InterviewTurn> = {},
): InterviewTurn {
  return {
    id: newId(),
    sessionId,
    ordinal,
    question: questionRecord(),
    answer: null,
    coverageDelta: [],
    state: 'asked',
    createdAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

// --- shared suite ----------------------------------------------------------

type Factory = () => Promise<{ repo: CandidCueRepository; teardown: () => Promise<void> }>;

const implementations: Array<{ name: string; make: Factory }> = [
  {
    name: 'SqliteRepository(:memory:)',
    make: async () => {
      const repo = new SqliteRepository(':memory:');
      await repo.migrate();
      return { repo, teardown: () => repo.close() };
    },
  },
  {
    name: 'MemoryRepository',
    make: async () => {
      const repo = new MemoryRepository();
      await repo.migrate();
      return { repo, teardown: () => repo.close() };
    },
  },
];

describe.each(implementations)('CandidCueRepository — $name', ({ make }) => {
  let repo: CandidCueRepository;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    const built = await make();
    repo = built.repo;
    teardown = built.teardown;
  });

  afterEach(async () => {
    await teardown();
  });

  // Helper: save a project then attach a ready plan and make it active.
  async function seedProjectWithPlan(): Promise<{
    projectId: ProjectId;
    planId: PlanId;
  }> {
    const aggregate = await repo.saveProject(projectInput());
    const projectId = aggregate.project.id;
    const planId = newId();
    await repo.savePlan(planFor(projectId, 1, planId));
    await repo.setActivePlan(projectId, planId);
    return { projectId, planId };
  }

  it('save + get project round-trips with documents and a computed source hash', async () => {
    const saved = await repo.saveProject(projectInput());

    expect(saved.project.id).toBeTruthy();
    expect(saved.project.status).toBe('draft');
    expect(saved.documents).toHaveLength(2);
    expect(saved.documents.map((d) => d.title)).toEqual(['Brief', 'Notes']);

    // Source hash must match a recompute over the persisted setup + documents.
    expect(saved.project.sourceHash).toBe(
      hashProjectPreparationFromDocuments(
        {
          audience: saved.project.audience,
          intendedOutcome: saved.project.intendedOutcome,
          targetMode: saved.project.targetMode,
          targetValue: saved.project.targetValue,
          interviewerCharacterId: saved.project.interviewerCharacterId,
          notesToInterviewer: saved.project.notesToInterviewer,
        },
        saved.documents,
      ),
    );
    expect(saved.project.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await repo.getProject(saved.project.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.project).toEqual(saved.project);
    expect(fetched?.documents).toEqual(saved.documents);
    expect(fetched?.activePlan).toBeNull();
  });

  it('updates an existing project in place, preserving created_at and id', async () => {
    const first = await repo.saveProject(projectInput());
    const updated = await repo.saveProject({
      ...projectInput({ title: 'Renamed story' }),
      id: first.project.id,
    });

    expect(updated.project.id).toBe(first.project.id);
    expect(updated.project.title).toBe('Renamed story');
    expect(updated.project.createdAt).toBe(first.project.createdAt);

    const all = await repo.listProjects();
    expect(all).toHaveLength(1);
  });

  it('listProjects reports session counts and last session timestamp', async () => {
    const { projectId, planId } = await seedProjectWithPlan();

    let summaries = await repo.listProjects();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.sessionCount).toBe(0);
    expect(summaries[0]?.lastSessionAt).toBeNull();

    const s1 = await repo.createSession(sessionInput(projectId, planId, [coverageItem('c1')]));
    const s2 = await repo.createSession(sessionInput(projectId, planId, [coverageItem('c1')]));

    summaries = await repo.listProjects();
    expect(summaries[0]?.sessionCount).toBe(2);
    const expectedLast =
      s1.createdAt > s2.createdAt ? s1.createdAt : s2.createdAt;
    expect(summaries[0]?.lastSessionAt).toBe(expectedLast);
  });

  it('deleteProject cascades to documents (and the project disappears)', async () => {
    const saved = await repo.saveProject(projectInput());
    await repo.deleteProject(saved.project.id);

    expect(await repo.getProject(saved.project.id)).toBeNull();
    expect(await repo.listProjects()).toHaveLength(0);
  });

  it('savePlan + getLatestPlan returns the highest version; getProject surfaces the active plan', async () => {
    const aggregate = await repo.saveProject(projectInput());
    const projectId = aggregate.project.id;

    const planV1 = planFor(projectId, 1, newId());
    const planV2 = planFor(projectId, 2, newId());
    // Insert out of order to prove ordering is by version, not insertion.
    await repo.savePlan(planV2);
    await repo.savePlan(planV1);

    const latest = await repo.getLatestPlan(projectId);
    expect(latest?.id).toBe(planV2.id);
    expect(latest?.version).toBe(2);

    const byId = await repo.getPlan(planV1.id);
    expect(byId?.id).toBe(planV1.id);
    expect(byId?.brief.openingQuestion.text).toBe('Where did this all start?');

    await repo.setActivePlan(projectId, planV2.id);
    const withActive = await repo.getProject(projectId);
    expect(withActive?.activePlan?.id).toBe(planV2.id);
  });

  it('source hash covers setup fields, not just documents (PROJ-03)', async () => {
    const a = await repo.saveProject(projectInput());
    const sameDocs = a.documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      originalFilename: d.originalFilename,
      mimeType: d.mimeType,
      content: d.content,
      sortOrder: d.sortOrder,
    }));
    // Same documents, only the audience differs → hash must change.
    const b = await repo.saveProject({
      ...projectInput(),
      id: a.project.id,
      documents: sameDocs,
      audience: 'A completely different audience',
    });
    expect(b.project.sourceHash).not.toBe(a.project.sourceHash);
    // Same documents + audience, only the target value differs → hash changes too.
    const c = await repo.saveProject({
      ...projectInput(),
      id: a.project.id,
      documents: sameDocs,
      targetValue: 99,
    });
    expect(c.project.sourceHash).not.toBe(a.project.sourceHash);
  });

  it('derives planState unprepared → ready → stale across source edits (PROJ-01/02)', async () => {
    const saved = await repo.saveProject(projectInput());
    const projectId = saved.project.id;
    const summaryState = async (): Promise<string | undefined> =>
      (await repo.listProjects()).find((p) => p.id === projectId)?.planState;

    // No active plan yet.
    expect(saved.planState).toBe('unprepared');
    expect(await summaryState()).toBe('unprepared');

    // A ready plan whose hash matches the project's source hash → ready.
    const plan = planFor(projectId, 1, newId());
    plan.sourceHash = saved.project.sourceHash;
    await repo.savePlan(plan);
    await repo.setActivePlan(projectId, plan.id);
    expect((await repo.getProject(projectId))?.planState).toBe('ready');
    expect(await summaryState()).toBe('ready');

    // Editing a setup field changes the source hash → the active plan goes stale.
    const sameDocs = saved.documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      originalFilename: d.originalFilename,
      mimeType: d.mimeType,
      content: d.content,
      sortOrder: d.sortOrder,
    }));
    const edited = await repo.saveProject({
      ...projectInput(),
      id: projectId,
      documents: sameDocs,
      audience: 'Newly edited audience',
    });
    expect(edited.planState).toBe('stale');
    expect(await summaryState()).toBe('stale');
  });

  it('createSession persists coverage and starts at preflight with ordinal 0', async () => {
    const { projectId, planId } = await seedProjectWithPlan();
    const session = await repo.createSession(
      sessionInput(projectId, planId, [coverageItem('c1'), coverageItem('c2', { label: 'Pivot' })]),
    );

    expect(session.status).toBe('preflight');
    expect(session.currentTurnOrdinal).toBe(0);
    expect(session.rollingSummary).toBe('');

    const aggregate = await repo.getSession(session.id);
    expect(aggregate?.coverage).toHaveLength(2);
    expect(aggregate?.coverage.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(aggregate?.turns).toHaveLength(0);
  });

  it('appendTurnAtomic persists a turn and updates ordinal + summary atomically', async () => {
    const { projectId, planId } = await seedProjectWithPlan();
    const session = await repo.createSession(
      sessionInput(projectId, planId, [coverageItem('c1')]),
    );

    const t = turn(session.id, 1, { answer: fullAnswer('It started in a garage.') });
    const input: AppendTurnInput = {
      sessionId: session.id,
      turn: t,
      coverage: [coverageItem('c1', { status: 'covered', followUpCount: 1, evidenceTurnIds: [t.id] })],
      rollingSummary: 'Founder opened with the garage origin.',
      currentTurnOrdinal: 1,
    };
    await repo.appendTurnAtomic(input);

    const aggregate = await repo.getSession(session.id);
    expect(aggregate?.session.currentTurnOrdinal).toBe(1);
    expect(aggregate?.session.rollingSummary).toBe('Founder opened with the garage origin.');
    expect(aggregate?.turns).toHaveLength(1);
    expect(aggregate?.turns[0]?.id).toBe(t.id);
    expect(aggregate?.turns[0]?.answer?.cleanedTranscript).toBe('It started in a garage.');
    expect(aggregate?.coverage[0]?.status).toBe('covered');
    expect(aggregate?.coverage[0]?.followUpCount).toBe(1);

    const fetchedTurn = await repo.getTurn(t.id);
    expect(fetchedTurn?.ordinal).toBe(1);
  });

  it('getRecentTurns returns the newest N turns in chronological order', async () => {
    const { projectId, planId } = await seedProjectWithPlan();
    const session = await repo.createSession(
      sessionInput(projectId, planId, [coverageItem('c1')]),
    );

    const created: InterviewTurn[] = [];
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      const t = turn(session.id, ordinal);
      created.push(t);
      await repo.appendTurnAtomic({
        sessionId: session.id,
        turn: t,
        coverage: [coverageItem('c1')],
        rollingSummary: `after ${ordinal}`,
        currentTurnOrdinal: ordinal,
      });
    }

    const recent = await repo.getRecentTurns(session.id, 3);
    expect(recent.map((r) => r.ordinal)).toEqual([3, 4, 5]);
  });

  it('recordRawAnswer writes a minimal answer but never clobbers a fuller one', async () => {
    const { projectId, planId } = await seedProjectWithPlan();
    const session = await repo.createSession(
      sessionInput(projectId, planId, [coverageItem('c1')]),
    );

    // Turn A: no answer yet -> recordRawAnswer should populate the raw answer.
    const a = turn(session.id, 1, { answer: null });
    await repo.appendTurnAtomic({
      sessionId: session.id,
      turn: a,
      coverage: [coverageItem('c1')],
      rollingSummary: '',
      currentTurnOrdinal: 1,
    });
    await repo.recordRawAnswer(session.id, a.id, 'raw words here', 'manual');

    const afterRaw = await repo.getTurn(a.id);
    expect(afterRaw?.answer?.rawTranscript).toBe('raw words here');
    expect(afterRaw?.answer?.cleanedTranscript).toBe('');
    expect(afterRaw?.answer?.endpointReason).toBe('manual');

    // Turn B: already has a full cleaned answer -> recordRawAnswer must no-op.
    const b = turn(session.id, 2, { answer: fullAnswer('A clean sentence.') });
    await repo.appendTurnAtomic({
      sessionId: session.id,
      turn: b,
      coverage: [coverageItem('c1')],
      rollingSummary: '',
      currentTurnOrdinal: 2,
    });
    await repo.recordRawAnswer(session.id, b.id, 'late raw audio', 'recovery');

    const afterNoClobber = await repo.getTurn(b.id);
    expect(afterNoClobber?.answer?.cleanedTranscript).toBe('A clean sentence.');
    expect(afterNoClobber?.answer?.rawTranscript).toBe('um it started in a garage');
  });

  it('saveTurnAnswer and updateUserEditedTranscript update the answer record', async () => {
    const { projectId, planId } = await seedProjectWithPlan();
    const session = await repo.createSession(
      sessionInput(projectId, planId, [coverageItem('c1')]),
    );
    const t = turn(session.id, 1, { answer: null });
    await repo.appendTurnAtomic({
      sessionId: session.id,
      turn: t,
      coverage: [coverageItem('c1')],
      rollingSummary: '',
      currentTurnOrdinal: 1,
    });

    await repo.saveTurnAnswer(t.id, fullAnswer('Cleaned answer.'));
    let fetched = await repo.getTurn(t.id);
    expect(fetched?.answer?.cleanedTranscript).toBe('Cleaned answer.');
    expect(fetched?.completedAt).not.toBeNull();

    await repo.updateUserEditedTranscript(t.id, 'My edited version.');
    fetched = await repo.getTurn(t.id);
    expect(fetched?.answer?.userEditedTranscript).toBe('My edited version.');
    // The cleaned transcript must be untouched by the user edit.
    expect(fetched?.answer?.cleanedTranscript).toBe('Cleaned answer.');
  });

  it('saveCoverage replaces the live coverage snapshot for a session', async () => {
    const { projectId, planId } = await seedProjectWithPlan();
    const session = await repo.createSession(
      sessionInput(projectId, planId, [coverageItem('c1')]),
    );

    await repo.saveCoverage(session.id, [
      coverageItem('c1', { status: 'partial', followUpCount: 2 }),
      coverageItem('c9', { label: 'New topic' }),
    ]);

    const aggregate = await repo.getSession(session.id);
    expect(aggregate?.coverage).toHaveLength(2);
    const c1 = aggregate?.coverage.find((c) => c.id === 'c1');
    expect(c1?.status).toBe('partial');
    expect(c1?.followUpCount).toBe(2);
    expect(aggregate?.coverage.some((c) => c.id === 'c9')).toBe(true);
  });

  it('findResumableSessions filters by active/paused/recovering status', async () => {
    const { projectId, planId } = await seedProjectWithPlan();

    // preflight (not resumable)
    await repo.createSession(sessionInput(projectId, planId, [coverageItem('c1')]));

    const active = await repo.createSession(sessionInput(projectId, planId, [coverageItem('c1')]));
    await repo.updateSession({ ...active, status: 'active' });

    const paused = await repo.createSession(sessionInput(projectId, planId, [coverageItem('c1')]));
    await repo.updateSession({ ...paused, status: 'paused' });

    const completed = await repo.createSession(sessionInput(projectId, planId, [coverageItem('c1')]));
    await repo.updateSession({ ...completed, status: 'completed' });

    const resumable = await repo.findResumableSessions();
    const ids = resumable.map((s) => s.id).sort();
    expect(ids).toEqual([active.id, paused.id].sort());
    expect(resumable.every((s) => ['active', 'paused', 'recovering'].includes(s.status))).toBe(true);
  });

  it('listSessions returns a project\'s sessions newest-first', async () => {
    const { projectId, planId } = await seedProjectWithPlan();
    const s1 = await repo.createSession(sessionInput(projectId, planId, [coverageItem('c1')]));
    const s2 = await repo.createSession(sessionInput(projectId, planId, [coverageItem('c1')]));
    const sessions = await repo.listSessions(projectId);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.id))).toEqual(new Set([s1.id, s2.id]));
  });

  it('getSetting / setSetting round-trip typed JSON values', async () => {
    expect(await repo.getSetting('missing')).toBeNull();

    await repo.setSetting('audio', { input: 'mic-1', gain: 0.8, muted: false });
    const audio = await repo.getSetting<{ input: string; gain: number; muted: boolean }>('audio');
    expect(audio).toEqual({ input: 'mic-1', gain: 0.8, muted: false });

    // Overwrite is an upsert.
    await repo.setSetting('audio', { input: 'mic-2', gain: 1, muted: true });
    const updated = await repo.getSetting<{ input: string }>('audio');
    expect(updated?.input).toBe('mic-2');
  });
});

// --- non-shared: migrate() idempotency (SQLite-specific) -------------------

describe('SqliteRepository.migrate()', () => {
  it('creates the schema and is idempotent when run twice', async () => {
    const repo = new SqliteRepository(':memory:');
    await repo.migrate();
    // Second migrate must not throw and must not double-apply.
    await expect(repo.migrate()).resolves.toBeUndefined();

    // The schema is usable: a project round-trips after a double-migrate.
    const saved = await repo.saveProject(projectInput());
    expect(await repo.getProject(saved.project.id)).not.toBeNull();
    await repo.close();
  });

  it('records each applied migration version exactly once', async () => {
    // Reach through to the raw handle to inspect the ledger.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const repo = new SqliteRepository(db as never);
    await repo.migrate();
    await repo.migrate();

    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(rows.map((r) => r.version)).toEqual([1]);
    await repo.close();
  });
});
