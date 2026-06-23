import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'node:path';
import { SessionOrchestrator, type OrchestratorDeps, type SessionContext } from '@main/interview/orchestrator';
import type { StagePort, SnapshotSink } from '@main/interview/ports';
import { MemoryRepository } from '@main/persistence/memory-repository';
import { FakeInterviewModel, FakeModeration, FakeStt, FakeTts } from '@main/providers/fakes';
import { loadManifest } from '@main/media/manifest-loader';
import type {
  InterviewBrief,
  InterviewerCharacter,
  MediaClip,
  SessionCoverageItem,
} from '@shared/domain';
import type { InterviewModelAdapter, OperatorSessionSnapshot } from '@shared/contracts';

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
}

async function makeHarness(overrides?: {
  model?: InterviewModelAdapter;
  stt?: FakeStt;
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
    endpointMode: 'manual',
    selectedInputDeviceId: 'mic-1',
    selectedOutputDeviceId: null,
    selectedDisplayId: 'disp-1',
    settingsSnapshot: {
      endpointMode: 'manual',
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

  const deps: OrchestratorDeps = {
    repository: repo,
    model: overrides?.model ?? new FakeInterviewModel({ questionTexts: ['So what changed after that?'] }),
    moderation: new FakeModeration(),
    stt: overrides?.stt ?? new FakeStt({ transcript: 'CandidCue gives solo presenters a partner on the teleprompter.' }),
    tts: new FakeTts({ durationMs: 7000 }),
    stage,
    snapshotSink,
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
    captionsEnabled: false,
    selectedOutputDeviceId: null,
    targetQuestionCount: 12,
  };

  return { orch: new SessionOrchestrator(deps, ctx), repo, stage, snapshots, sessionId: session.id };
}

describe('SessionOrchestrator turn pipeline', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

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
});
