import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { SessionOrchestrator, type OrchestratorDeps, type SessionContext } from '@main/interview/orchestrator';
import { NOOP_LOGGER, type StagePort, type SnapshotSink } from '@main/interview/ports';
import { MemoryRepository } from '@main/persistence/memory-repository';
import { FakeInterviewModel, FakeModeration, FakeStt, FakeTts } from '@main/providers/fakes';
import { loadManifest } from '@main/media/manifest-loader';
import { AppController } from '@main/app-controller';
import { bridgeSttToOrchestrator } from '@main/interview/stt-bridge';
import type { CredentialStore } from '@main/security/secrets';
import type { EndpointMode } from '@shared/domain';
import type {
  InterviewBrief,
  InterviewerCharacter,
  MediaClip,
  SessionCoverageItem,
} from '@shared/domain';
import type {
  InterviewModelAdapter,
  OperatorSessionSnapshot,
  GenerateNextActionInput,
} from '@shared/contracts';

const CLIPS: MediaClip[] = loadManifest(join(process.cwd(), 'videos', 'mira')).clips;

function brief(): InterviewBrief {
  return {
    title: 'Introducing CandidCue',
    oneSentencePremise: 'CandidCue helps solo presenters record natural answers.',
    audience: 'Solo creators',
    intendedOutcome: 'Explain the product',
    recommendedTone: 'Clear and practical',
    factualAnchors: [],
    terminology: [],
    coverageItems: [
      {
        id: 'cov-problem',
        label: 'Problem and audience',
        objective: 'Explain who needs a conversational partner.',
        priority: 'must',
        status: 'not_started',
        evidenceTurnIds: [],
        maxFollowUps: 2,
        sourceRefs: [],
      },
    ],
    arc: [],
    exclusions: [],
    openingQuestion: {
      text: 'What problem does CandidCue solve for someone recording a video alone?',
      type: 'opening',
      targetCoverageItemIds: ['cov-problem'],
      useWhen: 'Session start',
    },
    fallbackQuestions: [
      {
        text: 'What happens after the speaker finishes an answer?',
        type: 'mechanism',
        targetCoverageItemIds: ['cov-problem'],
        useWhen: 'Core loop uncovered',
      },
    ],
    closingStrategy: 'Ask for the single most important takeaway.',
  };
}

function character(): InterviewerCharacter {
  return {
    id: 'mira',
    displayName: 'Mira',
    shortDescription: 'Test',
    profileImagePath: 'mira/profile.png',
    mediaRootPath: 'mira',
    listeningPath: 'mira/listening',
    speakingPath: 'mira/speaking',
    posterPath: 'mira/poster.webp',
    voice: { provider: 'inworld', voiceId: 'Ashley', style: 'neutral', speakingRate: 1, sampleRate: 24000 },
    systemPrompt: 'You are Mira.',
    systemPromptVersion: '1.0.0',
    video: { fit: 'cover', mirrorByDefault: false, defaultZoom: 1, defaultVerticalOffsetPercent: 0, allowedPlaybackRate: { min: 0.92, max: 1.08 } },
  };
}

function coverageFromBrief(b: InterviewBrief): SessionCoverageItem[] {
  return b.coverageItems.map((c) => ({ ...c, followUpCount: 0 }));
}

interface Harness {
  orch: SessionOrchestrator;
  repo: MemoryRepository;
  stage: StagePort & { openMicGate: ReturnType<typeof vi.fn>; closeMicGate: ReturnType<typeof vi.fn> };
  snapshots: OperatorSessionSnapshot[];
  sessionId: string;
  stt: FakeStt;
}

async function makeHarness(overrides?: {
  model?: InterviewModelAdapter;
  stt?: FakeStt;
  endpointMode?: EndpointMode;
  captionsEnabled?: boolean;
  clock?: () => number;
}): Promise<Harness> {
  const repo = new MemoryRepository();
  await repo.migrate();

  const b = brief();
  const project = await repo.saveProject({
    title: b.title,
    targetMode: 'question_count',
    targetValue: 12,
    interviewerCharacterId: 'mira',
    documents: [{ kind: 'primary', title: 'Brief', mimeType: 'text/markdown', content: '# Topic', sortOrder: 0 }],
  });
  const plan = {
    id: 'plan-1',
    projectId: project.project.id,
    version: 1,
    sourceHash: project.project.sourceHash,
    status: 'ready' as const,
    brief: b,
    promptVersion: '1.0.0',
    createdAt: new Date().toISOString(),
  };
  await repo.savePlan(plan);

  const coverage = coverageFromBrief(b);
  const session = await repo.createSession({
    projectId: project.project.id,
    planVersionId: plan.id,
    characterId: 'mira',
    endpointMode: overrides?.endpointMode ?? 'manual',
    selectedInputDeviceId: 'mic-1',
    selectedOutputDeviceId: null,
    selectedDisplayId: 'disp-1',
    settingsSnapshot: {
      endpointMode: overrides?.endpointMode ?? 'manual',
      captionsEnabled: false,
      mirrorStage: false,
      zoom: 1,
      verticalOffsetPercent: 0,
      maxQuestionWords: 42,
      maxQuestionAudioMs: 15000,
      recentTurnCount: 6,
      characterId: 'mira',
      ttsVoiceId: 'Ashley',
    },
    coverage,
  });

  const snapshots: OperatorSessionSnapshot[] = [];
  const stage = {
    openMicGate: vi.fn(),
    closeMicGate: vi.fn(),
    preloadSpeechPlan: vi.fn(async () => {}),
    playSpeechPlan: vi.fn(async () => {}), // resolves immediately = audio ended
    setVisualState: vi.fn(),
  };
  const snapshotSink: SnapshotSink = { publish: (s) => snapshots.push(s) };

  const stt =
    overrides?.stt ??
    new FakeStt({ transcript: 'CandidCue gives solo presenters a partner on the teleprompter.' });
  const deps: OrchestratorDeps = {
    repository: repo,
    model: overrides?.model ?? new FakeInterviewModel({ questionTexts: ['So what changed after that?'] }),
    moderation: new FakeModeration(),
    stt,
    tts: new FakeTts({ durationMs: 7000 }),
    stage,
    snapshotSink,
    clock: overrides?.clock,
  };

  const ctx: SessionContext = {
    session,
    brief: b,
    character: character(),
    composedSystemPrompt: 'rules + persona',
    coverage,
    clips: CLIPS,
    models: { interviewer: 'gpt-5.5', cleanup: 'gpt-5.4-mini', endpoint: 'gpt-5.4-nano', repair: 'gpt-5.4-mini', stt: 'inworld-stt-1' },
    voiceId: 'Ashley',
    ttsSampleRate: 24000,
    captionsEnabled: overrides?.captionsEnabled ?? false,
    selectedOutputDeviceId: null,
    targetQuestionCount: 12,
  };

  return { orch: new SessionOrchestrator(deps, ctx), repo, stage, snapshots, sessionId: session.id, stt };
}

describe('SessionOrchestrator turn pipeline', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => {
    // Release any running auto-endpoint interval so it can't leak across tests.
    h.orch.dispose();
  });

  const lastSnapshot = (): OperatorSessionSnapshot => {
    const snap = h.snapshots.at(-1);
    if (!snap) throw new Error('no snapshot published yet');
    return snap;
  };

  it('prepares the opening question and reaches READY', async () => {
    await h.orch.prepareOpening();
    expect(h.orch.getState()).toBe('READY');
  });

  it('plays the opening and arms the user turn (mic opens only after speech)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.stage.closeMicGate).toHaveBeenCalled(); // never open during Mira speech
    expect(h.stage.openMicGate).toHaveBeenCalledTimes(1);
  });

  it('commits a manual answer, stores raw transcript, and plays the next question', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    expect(agg).not.toBeNull();
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.answer?.rawTranscript).toContain('CandidCue gives solo presenters');
    expect(turn1.state).toBe('answered');
    // A second (next) question was generated and is now armed.
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(true);
    expect(h.orch.getState()).toBe('USER_ARMED');
  });

  it('does not create duplicate turns from a duplicate commit', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await Promise.allSettled([h.orch.commitUserTurn('manual'), h.orch.commitUserTurn('manual')]);
    const agg = await h.repo.getSession(h.sessionId);
    const ordinal1 = agg!.turns.filter((t) => t.ordinal === 1);
    expect(ordinal1).toHaveLength(1);
  });

  it('falls back to a bank question when the model fails', async () => {
    const failingModel = new FakeInterviewModel();
    // Force generateNextAction to reject so the deadline fallback engages.
    failingModel.generateNextAction = vi.fn(async () => {
      throw new Error('model down');
    });
    h = await makeHarness({ model: failingModel });

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    const turn2 = agg!.turns.find((t) => t.ordinal === 2);
    expect(turn2?.question.text).toBe('What happens after the speaker finishes an answer?');
    expect(turn2?.question.source).toBe('model');
  });

  it('ends the session after the current turn when End After Turn is set', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    h.orch.endAfterTurn();
    await h.orch.commitUserTurn('manual');

    expect(h.orch.getState()).toBe('COMPLETED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    // No second question after a closing turn.
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);
  });

  it('preserves the turn and pauses on an empty answer instead of inventing one', async () => {
    h = await makeHarness({ stt: new FakeStt({ transcript: '' }) });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(2000);
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('PAUSED');
  });

  // --- round-1 correctness regressions -------------------------------------

  it('marks the session active and stamps startedAt on begin (CORR-07)', async () => {
    await h.orch.prepareOpening();
    let agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('preflight');
    expect(agg!.session.startedAt).toBeNull();

    await h.orch.begin();

    agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('active');
    expect(agg!.session.startedAt).not.toBeNull();

    // startedAt is preserved (not reset/cleared) when the session later completes.
    await h.orch.endNow();
    agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    expect(agg!.session.startedAt).not.toBeNull();
  });

  it('resumes the open user turn without replaying the question (CORR-01)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000); // USER_SPEAKING — mic was open
    expect(h.orch.getState()).toBe('USER_SPEAKING');

    h.orch.pause();
    expect(h.orch.getState()).toBe('PAUSED');

    vi.mocked(h.stage.preloadSpeechPlan).mockClear();
    h.stage.openMicGate.mockClear();
    await h.orch.resume();

    // Back to the user turn with the mic reopened; the question is NOT replayed.
    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.stage.openMicGate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.stage.preloadSpeechPlan)).not.toHaveBeenCalled();
  });

  it('persists the computed coverage delta on the answered turn (CORR-09)', async () => {
    const model = new FakeInterviewModel({
      questionTexts: ['So what changed after that?'],
      scriptedActions: [
        { coverageUpdates: [{ coverageItemId: 'cov-problem', status: 'covered', evidenceTurnIds: [] }] },
      ],
    });
    h = await makeHarness({ model });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.coverageDelta).toHaveLength(1);
    expect(turn1.coverageDelta[0]).toMatchObject({
      coverageItemId: 'cov-problem',
      fromStatus: 'not_started',
      toStatus: 'covered',
    });
    // The freshly-asked next turn carries no delta.
    const turn2 = agg!.turns.find((t) => t.ordinal === 2);
    expect(turn2?.coverageDelta).toEqual([]);
  });

  it('feeds the last committed answer into a subsequent skip (CORR-08)', async () => {
    const model = new FakeInterviewModel({ questionTexts: ['Q two?', 'Q three?'] });
    const captured: string[] = [];
    const original = model.generateNextAction.bind(model);
    model.generateNextAction = vi.fn((input: GenerateNextActionInput, signal?: AbortSignal) => {
      captured.push(input.currentAnswer);
      return original(input, signal);
    });
    h = await makeHarness({ model });

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual'); // commit turn 1 → generates turn 2

    await h.orch.skipQuestion(); // skip turn 2 → generates turn 3 from the prior answer

    // The skip's next-action call received the committed answer, not '' (was a stub).
    expect(captured.at(-1)).toContain('CandidCue gives solo presenters');
  });

  it('exposes the real persisted turn id in the review projection and round-trips edits (CORR-02)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    const persisted = agg!.turns.find((t) => t.ordinal === 1)!;

    const controller = new AppController({
      repository: h.repo,
      credentials: {} as unknown as CredentialStore,
      logger: NOOP_LOGGER,
      videosRoot: '',
      getControl: () => null,
      getStage: () => null,
      ensureStageWindow: () => {
        throw new Error('stage window is not used by review/editTranscript');
      },
    });

    const review = await controller.review(h.sessionId);
    const reviewed = review!.turns.find((t) => t.ordinal === 1)!;
    expect(reviewed.id).toBe(persisted.id); // real id, not the ordinal

    // Editing by that id actually persists (previously the ordinal was sent and
    // the update silently matched no row).
    await controller.editTranscript(reviewed.id, 'Edited answer text.');
    const after = await h.repo.getTurn(persisted.id);
    expect(after!.answer!.userEditedTranscript).toBe('Edited answer text.');
  });

  // --- round-2 live wiring (MIC-* / MEDIA-* / CORR-10/11) ------------------

  it('wires live STT events to the orchestrator via the bridge (MIC-04)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED
    const offs = bridgeSttToOrchestrator(h.stt, h.orch, () => 1000);
    try {
      h.stt.emit('speechStarted');
      expect(h.orch.getState()).toBe('USER_SPEAKING');

      h.stt.emit('partial', 'CandidCue gives');
      expect(lastSnapshot().partialTranscript).toBe('CandidCue gives');

      h.stt.emit('finalSegment', 'CandidCue gives solo presenters a partner.');
      const snap = lastSnapshot();
      expect(snap.finalTranscriptSoFar).toContain('solo presenters a partner');
      expect(snap.partialTranscript).toBe(''); // interim cleared on a final segment

      h.stt.emit('speechStopped');
      expect(h.orch.getState()).toBe('ENDPOINT_CANDIDATE');
    } finally {
      offs.forEach((off) => off());
    }
  });

  it('surfaces live mic meter readings in the snapshot (MIC-06/07)', async () => {
    await h.orch.prepareOpening();
    h.orch.reportMeter({ peak: 0.8, average: 0.42, clipping: false });
    let snap = lastSnapshot();
    expect(snap.mic.level).toBeCloseTo(0.42);
    expect(snap.mic.clipping).toBe(false);

    h.orch.reportMeter({ peak: 1, average: 0.9, clipping: true });
    snap = lastSnapshot();
    expect(snap.mic.clipping).toBe(true);
  });

  it('reflects STT connection state in provider health (CORR-11)', async () => {
    await h.orch.prepareOpening();
    h.orch.setSttConnected(false);
    expect(lastSnapshot().providerStatus.inworldStt).toBe('down');
    h.orch.setSttConnected(true);
    expect(lastSnapshot().providerStatus.inworldStt).toBe('ok');
  });

  it('shows the spoken question as a caption while speaking when captions are on (CORR-10)', async () => {
    h = await makeHarness({ captionsEnabled: true });
    await h.orch.prepareOpening();
    await h.orch.begin();
    const projections = vi.mocked(h.stage.setVisualState).mock.calls.map((c) => c[0]);
    const speaking = projections.find((p) => p.visualState === 'speaking');
    expect(speaking?.captions).toBe(
      'What problem does CandidCue solve for someone recording a video alone?',
    );
  });

  it('omits stage captions when captions are disabled', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    const projections = vi.mocked(h.stage.setVisualState).mock.calls.map((c) => c[0]);
    const speaking = projections.find((p) => p.visualState === 'speaking');
    expect(speaking).toBeDefined();
    expect(speaking?.captions).toBeNull();
  });

  it('drives endpoint evaluation from the silence timer in an auto mode (MIC-05)', async () => {
    h = await makeHarness({ endpointMode: 'balanced' });
    await h.orch.prepareOpening();
    await h.orch.begin();
    vi.useFakeTimers();
    try {
      h.orch.onSpeechStarted(Date.now());
      h.orch.onSpeechStopped(Date.now()); // → ENDPOINT_CANDIDATE, starts the loop
      expect(h.orch.getState()).toBe('ENDPOINT_CANDIDATE');
      const spy = vi.spyOn(h.orch, 'evaluateEndpoint');
      await vi.advanceTimersByTimeAsync(300); // fire ≥1 tick of the 250ms interval
      expect(spy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not run the endpoint loop in manual mode', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    vi.useFakeTimers();
    try {
      h.orch.onSpeechStarted(Date.now());
      h.orch.onSpeechStopped(Date.now());
      const spy = vi.spyOn(h.orch, 'evaluateEndpoint');
      await vi.advanceTimersByTimeAsync(1000);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the endpoint loop when the session is ended immediately', async () => {
    h = await makeHarness({ endpointMode: 'balanced' });
    await h.orch.prepareOpening();
    await h.orch.begin();
    vi.useFakeTimers();
    try {
      h.orch.onSpeechStarted(Date.now());
      h.orch.onSpeechStopped(Date.now()); // starts the loop in ENDPOINT_CANDIDATE
      await h.orch.endNow(); // must clear the loop even from ENDPOINT_CANDIDATE
      const spy = vi.spyOn(h.orch, 'evaluateEndpoint');
      await vi.advanceTimersByTimeAsync(1000);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
