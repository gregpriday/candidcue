import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { SessionOrchestrator, type OrchestratorDeps, type SessionContext } from '@main/interview/orchestrator';
import { NOOP_LOGGER, type Logger, type StagePort, type SnapshotSink } from '@main/interview/ports';
import { MemoryRepository } from '@main/persistence/memory-repository';
import { FakeInterviewModel, FakeModeration, FakeStt, FakeTts } from '@main/providers/fakes';
import { loadManifest } from '@main/media/manifest-loader';
import { AppController } from '@main/app-controller';
import { bridgeSttToOrchestrator } from '@main/interview/stt-bridge';
import { AppError } from '@shared/errors/app-error';
import type { CredentialStore } from '@main/security/secrets';
import type { EndpointMode, EndpointDecision } from '@shared/domain';
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
  stage: StagePort & {
    openMicGate: ReturnType<typeof vi.fn>;
    closeMicGate: ReturnType<typeof vi.fn>;
    results: { preload: boolean; play: boolean };
  };
  snapshots: OperatorSessionSnapshot[];
  sessionId: string;
  stt: FakeStt;
  tts: FakeTts;
}

async function makeHarness(overrides?: {
  model?: InterviewModelAdapter;
  stt?: FakeStt;
  tts?: FakeTts;
  endpointMode?: EndpointMode;
  captionsEnabled?: boolean;
  clock?: () => number;
  logger?: Logger;
  targetQuestionCount?: number;
}): Promise<Harness> {
  const repo = new MemoryRepository();
  await repo.migrate();

  const b = brief();
  const project = await repo.saveProject({
    title: b.title,
    targetMode: 'question_count',
    targetValue: overrides?.targetQuestionCount ?? 12,
    interviewerCharacterId: 'mira',
    documents: [{ title: 'Brief', mimeType: 'text/markdown', content: '# Topic', sortOrder: 0 }],
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
  // Stage confirms playback by default; tests flip these to simulate a stage
  // error / deadline timeout (preload or play not confirmed).
  const stageResults = { preload: true, play: true };
  const stage = {
    openMicGate: vi.fn(),
    closeMicGate: vi.fn(),
    preloadSpeechPlan: vi.fn(async () => stageResults.preload),
    playSpeechPlan: vi.fn(async () => stageResults.play), // resolves immediately = audio ended
    setVisualState: vi.fn(),
    results: stageResults,
  };
  const snapshotSink: SnapshotSink = { publish: (s) => snapshots.push(s) };

  const stt =
    overrides?.stt ??
    new FakeStt({ transcript: 'CandidCue gives solo presenters a partner on the teleprompter.' });
  const tts = overrides?.tts ?? new FakeTts({ durationMs: 7000 });
  const deps: OrchestratorDeps = {
    repository: repo,
    model: overrides?.model ?? new FakeInterviewModel({ questionTexts: ['So what changed after that?'] }),
    moderation: new FakeModeration(),
    stt,
    tts,
    stage,
    snapshotSink,
    clock: overrides?.clock,
    logger: overrides?.logger,
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
    targetQuestionCount: overrides?.targetQuestionCount ?? 12,
  };

  return { orch: new SessionOrchestrator(deps, ctx), repo, stage, snapshots, sessionId: session.id, stt, tts };
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
    expect(h.stt.beginTurnCalls).toBe(1); // STT armed for the user turn
  });

  it('does NOT arm the mic when stage playback fails (play not confirmed)', async () => {
    // Simulate a stage error / deadline timeout: playSpeechPlan resolves false.
    h.stage.results.play = false;
    await h.orch.prepareOpening();
    await h.orch.begin();
    // Mira never spoke: must not reach USER_ARMED, mic stays closed, STT not armed.
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.stage.openMicGate).not.toHaveBeenCalled();
    expect(h.stt.beginTurnCalls).toBe(0);
    // The warning must only advertise always-legal recovery: skip is illegal
    // from PAUSED, so canSkip is false and the text must not mention "skip".
    const snap = lastSnapshot();
    expect(snap.recoverableWarning).toBe('Stage playback failed. Resume to retry.');
    expect(snap.recoverableWarning).not.toMatch(/skip/i);
    expect(snap.controls.canSkip).toBe(false);
  });

  it('does NOT arm the mic when stage preload fails (ready not confirmed)', async () => {
    h.stage.results.preload = false;
    await h.orch.prepareOpening();
    await h.orch.begin();
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.stage.playSpeechPlan).not.toHaveBeenCalled();
    expect(h.stage.openMicGate).not.toHaveBeenCalled();
    expect(h.stt.beginTurnCalls).toBe(0);
    // Same guard: warning advertises only resume, skip stays disabled.
    const snap = lastSnapshot();
    expect(snap.recoverableWarning).toBe('Stage playback failed. Resume to retry.');
    expect(snap.recoverableWarning).not.toMatch(/skip/i);
    expect(snap.controls.canSkip).toBe(false);
  });

  it('does NOT arm a turn whose generation was bumped (pause) while play was in flight', async () => {
    // Make playSpeechPlan resolve only when we choose, so we can bump the
    // generation (pause) while the stage "play" await is still pending — the
    // exact race where a late audioEnded must NOT advance a cancelled turn.
    let resolvePlay!: (confirmed: boolean) => void;
    const playDeferred = new Promise<boolean>((resolve) => {
      resolvePlay = resolve;
    });
    vi.mocked(h.stage.playSpeechPlan).mockImplementationOnce(async () => playDeferred);

    await h.orch.prepareOpening();
    // begin() awaits playSpeechPlan, so run it concurrently; it stays parked on
    // the deferred play promise until we resolve it below.
    const begun = h.orch.begin();
    // Let begin() drive through preload + stageReady and park on the deferred
    // playSpeechPlan await (so myGen is already captured before we pause).
    await vi.waitFor(() => {
      expect(h.orch.getState()).toBe('INTERVIEWER_SPEAKING');
    });
    expect(h.stage.playSpeechPlan).toHaveBeenCalled();

    // Operator pauses mid-speech: bumps generationId, closes the mic gate.
    h.orch.pause();
    expect(h.orch.getState()).toBe('PAUSED');

    const openCallsBeforeLatePlay = h.stage.openMicGate.mock.calls.length;
    const beginCallsBeforeLatePlay = h.stt.beginTurnCalls;

    // The stage now (late) confirms audio ended for the superseded turn.
    resolvePlay(true);
    await begun;

    // The generation guard must have silently bailed: no audioEnded-driven
    // arming, mic never (re)opened, STT not armed for the cancelled turn.
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.stage.openMicGate.mock.calls.length).toBe(openCallsBeforeLatePlay);
    expect(h.stt.beginTurnCalls).toBe(beginCallsBeforeLatePlay);
  });

  it('does NOT arm a turn whose generation was bumped (pause) while PRELOAD setup was in flight', async () => {
    // Park on the persistAskedTurn await — the FIRST cancelable await in
    // playCurrentTurn, which runs BEFORE the stage preload. myGen must be
    // captured right after entering INTERVIEWER_BUFFERING (before this await),
    // so a pause that bumps generationId here is seen by the later guard. If
    // myGen were sampled only after persist/buildPlan (the old code), the bump
    // would fold into the new generation and the guard would wrongly pass,
    // arming a turn the operator already cancelled — exactly the regression.
    let resolvePersist!: () => void;
    const persistDeferred = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    // appendTurnAtomic is the cancelable await inside persistAskedTurn. Defer the
    // first (the "asked" persist) so we can pause while it is pending.
    const realAppend = h.repo.appendTurnAtomic.bind(h.repo);
    vi.spyOn(h.repo, 'appendTurnAtomic').mockImplementationOnce(async (args) => {
      await persistDeferred;
      return realAppend(args);
    });

    await h.orch.prepareOpening();
    // begin() awaits persistAskedTurn, so run it concurrently; it stays parked on
    // the deferred persist promise until we resolve it below.
    const begun = h.orch.begin();
    // Let begin() drive into INTERVIEWER_BUFFERING and park on the deferred
    // persist await (myGen is already captured at that point).
    await vi.waitFor(() => {
      expect(h.repo.appendTurnAtomic).toHaveBeenCalled();
    });
    expect(h.orch.getState()).toBe('INTERVIEWER_BUFFERING');
    // The stage has not been touched yet: persist precedes preload.
    expect(h.stage.preloadSpeechPlan).not.toHaveBeenCalled();

    // Operator pauses while the persist is in flight: bumps generationId, closes
    // the mic gate. This bump happens BEFORE the old (late) myGen capture point.
    h.orch.pause();
    expect(h.orch.getState()).toBe('PAUSED');

    const openCallsBeforeLatePersist = h.stage.openMicGate.mock.calls.length;
    const beginCallsBeforeLatePersist = h.stt.beginTurnCalls;

    // The persist now (late) completes for the superseded turn; playCurrentTurn
    // proceeds to preload and the post-preload guard runs.
    resolvePersist();
    await begun;

    // The generation guard must have silently bailed: never transitioned to
    // stageReady / SPEAKING, never played, mic never (re)opened, STT not armed.
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.stage.playSpeechPlan).not.toHaveBeenCalled();
    expect(h.stage.openMicGate.mock.calls.length).toBe(openCallsBeforeLatePersist);
    expect(h.stt.beginTurnCalls).toBe(beginCallsBeforeLatePersist);
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
    // Two commits in the same tick (double-click / duplicate IPC). Without the
    // synchronous commitInFlight claim, both pass the guard and enqueue: the
    // first commits turn 1, the second commits the freshly-armed turn 2 (#16).
    await Promise.allSettled([h.orch.commitUserTurn('manual'), h.orch.commitUserTurn('manual')]);

    const agg = await h.repo.getSession(h.sessionId);
    const ordinal1 = agg!.turns.filter((t) => t.ordinal === 1);
    expect(ordinal1).toHaveLength(1);
    expect(ordinal1[0]!.state).toBe('answered');
    // The duplicate must be a no-op: exactly one turn is answered and only the
    // armed next turn (turn 2) was added — the duplicate did NOT commit it.
    expect(agg!.turns.filter((t) => t.state === 'answered')).toHaveLength(1);
    expect(agg!.turns).toHaveLength(2);
    expect(h.orch.getState()).toBe('USER_ARMED');

    // The flag was released, not permanently latched: a subsequent commit on the
    // armed turn still works and advances the interview (guards the early-return
    // reset in commitPipeline that the claim-at-enqueue fix made load-bearing).
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg2 = await h.repo.getSession(h.sessionId);
    expect(agg2!.turns.find((t) => t.ordinal === 2)!.state).toBe('answered');
    expect(agg2!.turns.some((t) => t.ordinal === 3)).toBe(true);
    expect(h.orch.getState()).toBe('USER_ARMED');
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

  it('ends the session at the hard question-count cap when the model never self-terminates', async () => {
    // Without a backstop, a model that always returns `ask` never self-terminates.
    // The hard cap (ceil(target * factor)) forces completion after enough answers.
    const model = new FakeInterviewModel({
      questionTexts: [
        'What first drew you to this work',
        'Can you walk me through a concrete example',
        'What surprised you most along the way',
        'How did you measure success there',
        'Where would you like to take this next',
        'What else should people know about this',
      ],
    });
    h = await makeHarness({ model, targetQuestionCount: 3 }); // cap = ceil(3 * 1.5) = 5

    await h.orch.prepareOpening();
    await h.orch.begin();

    // Drive 5 answered turns; the model asks every time.
    for (let i = 0; i < 5; i++) {
      h.orch.onSpeechStarted(1000 * (i + 1));
      h.orch.onSpeechStopped(1000 * (i + 1) + 3000);
      await h.orch.commitUserTurn('manual');
      // Turns 1-4 stay under the cap: the session keeps going and arms a next
      // question. Guards the off-by-one — the cap fires on ordinal 5, not 4.
      if (i < 4) expect(h.orch.getState()).toBe('USER_ARMED');
    }

    // The 5th answered turn tripped the cap → forced completion, no runaway turn 6.
    expect(h.orch.getState()).toBe('COMPLETED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    expect(agg!.session.currentTurnOrdinal).toBe(5);
    expect(agg!.turns.some((t) => t.ordinal === 6)).toBe(false);
    // The operator snapshot surfaces WHY the interview ended automatically.
    expect(lastSnapshot().recoverableWarning).toMatch(/safety question limit/i);
  });

  it('attributes the close to the model when it also completes on the cap turn', async () => {
    // On the 5th (cap) turn the model independently returns `complete`. The cap's
    // OR term collapses with the model's close — no duplicate transition, and the
    // close is attributed to the model (no cap warning surfaced).
    const model = new FakeInterviewModel({
      scriptedActions: [
        { action: 'ask', spokenText: 'What first drew you to this work' },
        { action: 'ask', spokenText: 'Can you walk me through a concrete example' },
        { action: 'ask', spokenText: 'What surprised you most along the way' },
        { action: 'ask', spokenText: 'How did you measure success there' },
        { action: 'complete', spokenText: '' },
      ],
    });
    h = await makeHarness({ model, targetQuestionCount: 3 });

    await h.orch.prepareOpening();
    await h.orch.begin();
    for (let i = 0; i < 5; i++) {
      h.orch.onSpeechStarted(1000 * (i + 1));
      h.orch.onSpeechStopped(1000 * (i + 1) + 3000);
      await h.orch.commitUserTurn('manual');
    }

    expect(h.orch.getState()).toBe('COMPLETED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    expect(agg!.session.currentTurnOrdinal).toBe(5);
    // Attributed to the model's `complete`, not the cap → no safety-limit warning.
    expect(lastSnapshot().recoverableWarning).toBeNull();
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

  // The three cases below isolate each arm of skipQuestion's shouldClose guard so
  // a regression that drops any single arm is caught (#13).

  it('closes the session instead of synthesizing an empty question when the model completes on skip (#13)', async () => {
    // Isolates the `action === 'complete'` arm: shouldCloseAfterAnswer is false.
    const model = new FakeInterviewModel({
      scriptedActions: [{ action: 'complete', spokenText: '', shouldCloseAfterAnswer: false }],
    });
    h = await makeHarness({ model });
    await h.orch.prepareOpening();
    await h.orch.begin();
    const ttsBefore = h.tts.seen.length;

    await h.orch.skipQuestion();

    expect(h.orch.getState()).toBe('COMPLETED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    // The empty 'complete' action must not be voiced or persisted as a turn.
    expect(h.tts.seen.length).toBe(ttsBefore);
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);
  });

  it('closes the session when a skip action requests close-after-answer (#13)', async () => {
    // Isolates the `shouldCloseAfterAnswer` arm: still an 'ask' with real text,
    // which the buggy path would have voiced as a second question.
    const model = new FakeInterviewModel({
      scriptedActions: [{ action: 'ask', spokenText: 'One more thing?', shouldCloseAfterAnswer: true }],
    });
    h = await makeHarness({ model });
    await h.orch.prepareOpening();
    await h.orch.begin();
    const ttsBefore = h.tts.seen.length;

    await h.orch.skipQuestion();

    expect(h.orch.getState()).toBe('COMPLETED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    expect(h.tts.seen.length).toBe(ttsBefore);
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);
  });

  it('closes the session when End After Turn is armed before a skip (#13)', async () => {
    // Isolates the `endAfterTurnRequested` arm: the model deliberately does NOT
    // echo the close signal, so only the orchestrator's own flag can close.
    const model = new FakeInterviewModel({
      scriptedActions: [{ action: 'ask', spokenText: 'One more thing?', shouldCloseAfterAnswer: false }],
    });
    h = await makeHarness({ model });
    await h.orch.prepareOpening();
    await h.orch.begin();
    const ttsBefore = h.tts.seen.length;
    h.orch.endAfterTurn();

    await h.orch.skipQuestion();

    expect(h.orch.getState()).toBe('COMPLETED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    expect(h.tts.seen.length).toBe(ttsBefore);
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

    // The user spoke (onSpeechStarted) before the silence, so userHasSpoken is
    // true: neither Skip nor Repeat is legal here. The warning must advertise
    // only the always-legal action (Resume) so it can't promise an action the
    // operator can't take.
    const snap = h.snapshots.at(-1)!;
    expect(snap.recoverableWarning).toBe('No speech was captured. Resume to try again.');
    expect(snap.recoverableWarning).not.toMatch(/skip/i);
    expect(snap.recoverableWarning).not.toMatch(/repeat/i);
    expect(snap.controls.canSkip).toBe(false);
  });

  it('persists recoveredFromBufferedAudio=false when the finalize deadline fallback engages', async () => {
    // The finalize fallback reuses the already-streamed live transcript; no
    // buffered-audio batch recovery (stt.recoverFromAudio) actually runs, so the
    // answer must NOT be flagged as recovered-from-buffered-audio.
    const stt = new FakeStt({ transcript: 'streamed transcript' });
    // Force endTurn to reject so withDeadlineFallback reports timedOut=true and
    // falls back to the live turn.rawTranscript (set via the finalSegment below).
    stt.endTurn = vi.fn(async () => {
      throw new Error('finalize failed');
    });
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    // Populate the live turn's rawTranscript so the deadline fallback (which
    // reuses turn.rawTranscript) yields a non-empty answer instead of the
    // empty-answer pause path.
    h.orch.onSttFinalSegment('CandidCue gives solo presenters a partner.');
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.state).toBe('answered');
    expect(turn1.answer?.rawTranscript).toContain('CandidCue gives solo presenters');
    expect(turn1.answer?.recoveredFromBufferedAudio).toBe(false);
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

  it('resumes a live user turn without re-beginning STT, preserving pre-pause speech (BUG-1)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    const turnId = h.stt.currentTurnId; // armed by playCurrentTurn
    expect(turnId).not.toBeNull();
    const beginCallsBeforePause = h.stt.beginTurnCalls;

    // The user speaks and the live stream captures some words before the pause.
    h.orch.onSpeechStarted(1000); // USER_SPEAKING — mic was open
    h.stt.pushTranscript('words captured before the pause');
    expect(h.orch.getState()).toBe('USER_SPEAKING');

    h.orch.pause();
    // A real STT client would deactivate its turn on pause; mirror that so the
    // test proves resume() restores it. Without the fix, currentTurnId stays
    // null and every subsequent partial/final is dropped by the client.
    h.stt.currentTurnId = null;

    await h.orch.resume();

    // (a) STT is active for the SAME turn again via resumeTurn — NOT a second
    // beginTurn (which would reset the accumulator and drop the pre-pause words).
    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.stt.resumeTurnCalls).toBe(1);
    expect(h.stt.lastResumedTurnId).toBe(turnId);
    expect(h.stt.currentTurnId).toBe(turnId);
    expect(h.stt.beginTurnCalls).toBe(beginCallsBeforePause); // no second beginTurn

    // (c) The user already spoke: speechStartedAt was NOT reset, so userHasSpoken
    // stays true and Skip/Repeat remain illegal (they require a fresh turn).
    expect(h.orch.getCommandContext().userHasSpoken).toBe(true);
    const resumedSnap = h.snapshots.at(-1)!;
    expect(resumedSnap.controls.canSkip).toBe(false);
    expect(resumedSnap.controls.canRepeat).toBe(false);

    // (b) A subsequent commit includes the pre-pause words, proving the captured
    // transcript survived the resume (was dropped before the fix).
    await h.orch.commitUserTurn('manual');
    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.answer?.rawTranscript).toContain('words captured before the pause');
  });

  it('routes a failed STT re-activation through RECOVERING and auto-reconnects (issue #14)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();

    // The user speaks, then we pause a live user turn.
    h.orch.onSpeechStarted(1000); // USER_SPEAKING — mic was open
    expect(h.orch.getState()).toBe('USER_SPEAKING');
    h.orch.pause();
    expect(h.orch.getState()).toBe('PAUSED');

    // Simulate the STT transport having dropped: resumeTurn now throws. Hold the
    // reconnect open so RECOVERING is observable before it auto-resolves.
    h.stt.failResume = true;
    let releaseReconnect!: () => void;
    h.stt.reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    h.stage.openMicGate.mockClear();

    // resume() must not reject; the failed re-activation routes into RECOVERING
    // (mic still shut, never "armed but deaf") and kicks off the auto-reconnect.
    await expect(h.orch.resume()).resolves.toBeUndefined();
    expect(h.stt.resumeTurnCalls).toBe(1);
    expect(h.orch.getState()).toBe('RECOVERING'); // NOT USER_ARMED, NOT a bare PAUSED
    expect(h.stage.openMicGate).not.toHaveBeenCalled();
    expect(h.snapshots.at(-1)!.recoverableWarning).toMatch(/reconnect/i);

    // The held reconnect resolves and the session lands back in PAUSED, warning cleared.
    releaseReconnect();
    await vi.waitFor(() => expect(h.orch.getState()).toBe('PAUSED'));
    expect(h.stt.reconnectCalls).toBe(1);
    const recoveredSnap = h.snapshots.at(-1)!;
    expect(recoveredSnap.state).toBe('PAUSED');
    expect(recoveredSnap.mic.gate).toBe('closed');
    expect(recoveredSnap.recoverableWarning).toBeNull();

    // The pre-recovery USER_SPEAKING context survived: a resume now re-arms the
    // mic via resumeTurn (which succeeds again — the reconnect restored the stream).
    await h.orch.resume();
    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.stt.resumeTurnCalls).toBe(2);
    expect(h.stage.openMicGate).toHaveBeenCalledTimes(1);
    expect(h.snapshots.at(-1)!.recoverableWarning).toBeNull();
  });

  it('exhausts reconnect into ERROR, then RETRY_RECOVERY recovers (issue #14)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000); // USER_SPEAKING — mic was open
    h.orch.pause();
    expect(h.orch.getState()).toBe('PAUSED');

    // The transport is down AND every reconnect attempt fails.
    h.stt.failResume = true;
    h.stt.failReconnect = true;

    await h.orch.resume(); // → RECOVERING → (reconnect fails) → ERROR
    await vi.waitFor(() => expect(h.orch.getState()).toBe('ERROR'));
    const errSnap = h.snapshots.at(-1)!;
    expect(errSnap.controls.canRetry).toBe(true);
    expect(errSnap.recoverableWarning).toMatch(/reconnect/i);
    expect(errSnap.providerStatus.inworldStt).toBe('down');

    // Operator retries; this time the transport comes back.
    h.stt.failReconnect = false;
    h.orch.retryRecovery(); // ERROR → RECOVERING
    expect(h.orch.getState()).toBe('RECOVERING');
    await vi.waitFor(() => expect(h.orch.getState()).toBe('PAUSED'));
    expect(h.snapshots.at(-1)!.recoverableWarning).toBeNull();

    // The original USER_SPEAKING context survived the ERROR round-trip: resume re-arms.
    await h.orch.resume();
    expect(h.orch.getState()).toBe('USER_ARMED');
  });

  it('routes an STT_DISCONNECTED pipeline failure into RECOVERING (issue #14)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.stt.pushTranscript('a captured answer');

    // Hold the reconnect so RECOVERING is observable before it auto-resolves.
    let releaseReconnect!: () => void;
    h.stt.reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });

    // The commit pipeline throws STT_DISCONNECTED after finalize (the transport
    // dropped mid-commit). It must route into RECOVERING, not a bare pause.
    vi.spyOn(h.repo, 'recordRawAnswer').mockRejectedValueOnce(
      new AppError('STT_DISCONNECTED', { message: 'dropped mid-commit' }),
    );
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('RECOVERING');

    // Auto-reconnect resolves into PAUSED.
    releaseReconnect();
    await vi.waitFor(() => expect(h.orch.getState()).toBe('PAUSED'));
    expect(h.stt.reconnectCalls).toBe(1);
  });

  it('END_NOW during RECOVERING completes the session; a late reconnect cannot revive it (issue #14)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.pause();
    h.stt.failResume = true;

    // Hold the reconnect open so the session stays in RECOVERING while we END_NOW.
    let releaseReconnect!: () => void;
    h.stt.reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });

    await h.orch.resume();
    expect(h.orch.getState()).toBe('RECOVERING');

    // Operator ends the session mid-reconnect (END_NOW is legal from RECOVERING).
    await h.orch.endNow();
    expect(h.orch.getState()).toBe('COMPLETED');

    // The held reconnect now resolves; its stale resolution must NOT transition
    // out of COMPLETED, nor run its success side-effects (the generation guard
    // discards it).
    releaseReconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.orch.getState()).toBe('COMPLETED');
    const finalSnap = h.snapshots.at(-1)!;
    expect(finalSnap.providerStatus.inworldStt).toBe('degraded'); // not flipped back to 'ok'
    expect(finalSnap.recoverableWarning).toMatch(/reconnect/i); // not cleared by the stale reconnect
  });

  it('routes a failed beginTurn (dropped transport) through RECOVERING, never armed-but-deaf (issue #14)', async () => {
    // STT drops in the window between Mira's audio ending and the turn arming, so
    // beginTurn throws STT_DISCONNECTED. Hold the reconnect to observe RECOVERING.
    h.stt.failBeginTurn = true;
    let releaseReconnect!: () => void;
    h.stt.reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });

    await h.orch.prepareOpening();
    await h.orch.begin();

    // Instead of sitting USER_ARMED with the mic open and STT deaf, the session
    // entered RECOVERING with the mic closed.
    expect(h.orch.getState()).toBe('RECOVERING');
    expect(h.snapshots.at(-1)!.mic.gate).toBe('closed');

    // Auto-reconnect restores the transport and lands in PAUSED.
    releaseReconnect();
    await vi.waitFor(() => expect(h.orch.getState()).toBe('PAUSED'));
    expect(h.stt.reconnectCalls).toBe(1);
  });

  it('preserves the committed answer and advances when the next question fails to realize, then resumes (issue #9)', async () => {
    // The opening TTS (call 1) succeeds; the NEXT question's TTS (call 2) fails,
    // simulating a realization failure immediately after the answer is committed.
    const model = new FakeInterviewModel({ questionTexts: ['So what changed after that?'] });
    const generateSpy = vi.spyOn(model, 'generateNextAction');
    const tts = new FakeTts({ durationMs: 7000, failAfterCalls: 2 });
    h = await makeHarness({ model, tts });

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    // Turn 1's answer was committed; realizing turn 2 then threw TTS_FAILED, so
    // we are in a recoverable pause. The committed answer must already be safe.
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.snapshots.at(-1)!.recoverableWarning).toBe('We could not generate the interviewer voice.');

    let agg = await h.repo.getSession(h.sessionId);
    let turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.state).toBe('answered');
    expect(turn1.answer?.rawTranscript).toBeTruthy();
    const committedAnswer = turn1.answer!.rawTranscript;

    // Recover TTS, then resume. The fix must ADVANCE to the next question rather
    // than replaying the answered turn 1 (which would re-persist it as "asked"
    // with a null answer and wipe the committed answer — the bug).
    tts.resetFailure();
    await h.orch.resume();

    // The session advanced out of PAUSED (armed for turn 2) and turn 1's answer
    // is intact — not wiped by a replay.
    expect(h.orch.getState()).toBe('USER_ARMED');
    agg = await h.repo.getSession(h.sessionId);
    turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.state).toBe('answered');
    expect(turn1.answer?.rawTranscript).toBe(committedAnswer);

    // A fresh turn 2 was realized and persisted as "asked" — not a replay of 1.
    const turn2 = agg!.turns.find((t) => t.ordinal === 2);
    expect(turn2?.state).toBe('asked');

    // The resumed next-question generation was fed the committed answer as
    // context (not an empty string), so the model can ask a relevant follow-up.
    const lastInput = generateSpy.mock.calls.at(-1)?.[0];
    expect(lastInput?.currentAnswer).toBe(committedAnswer);
  });

  it('keeps the recoverable warning when stage playback fails during an answered-turn resume (issue #9)', async () => {
    const tts = new FakeTts({ durationMs: 7000, failAfterCalls: 2 });
    h = await makeHarness({ tts });

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('PAUSED'); // turn 2 TTS failed → answered flag set

    // Recover TTS, but make the stage fail to PLAY the resumed next question.
    // failStagePlayback pauses without throwing, so the resume branch's catch
    // never fires — the success tail must still NOT clobber the warning.
    tts.resetFailure();
    h.stage.results.play = false;
    h.stage.openMicGate.mockClear();
    await h.orch.resume();

    // Stay PAUSED with the retry prompt intact; mic closed, STT not armed.
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.snapshots.at(-1)!.recoverableWarning).toBe('Stage playback failed. Resume to retry.');
    expect(h.stage.openMicGate).not.toHaveBeenCalled();

    // The committed answer survives the failed resume.
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.turns.find((t) => t.ordinal === 1)?.answer?.rawTranscript).toBeTruthy();
  });

  it('clears the answered flag on Repeat so a later replay does not skip the re-asked question (issue #9)', async () => {
    const model = new FakeInterviewModel({ questionTexts: ['So what changed after that?'] });
    const tts = new FakeTts({ durationMs: 7000, failAfterCalls: 2 });
    h = await makeHarness({ model, tts });

    await h.orch.prepareOpening();
    await h.orch.begin();
    // Commit WITHOUT onSpeechStarted so userHasSpoken stays false → Repeat is
    // legal from the recoverable pause that follows the failed turn-2 TTS.
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.orch.getCommandContext().userHasSpoken).toBe(false);

    // Repeat re-asks turn 1 (cached audio, no TTS) but its stage playback fails,
    // pausing from a non-mic state (INTERVIEWER_BUFFERING) — the path where the
    // next resume routes through the prepared/next-question branches and the
    // answered flag decides which. Repeat must have cleared the flag.
    h.stage.results.preload = false;
    await h.orch.repeatQuestion();
    expect(h.orch.getState()).toBe('PAUSED');

    h.stage.results.preload = true;
    const modelCallsBeforeResume = model.callCount;
    await h.orch.resume();

    // The flag was cleared, so resume REPLAYS the re-asked turn 1 rather than
    // advancing past it: no next-question generation, and no turn 2 appears.
    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(model.callCount).toBe(modelCallsBeforeResume);
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);
    expect(agg!.turns.find((t) => t.ordinal === 1)?.answer?.rawTranscript).toBeTruthy();
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
      isDisplayConnected: () => true,
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

  it('dispatches RETRY_RECOVERY to retryRecovery (ERROR -> RECOVERING), not a resume no-op', async () => {
    // Put a real orchestrator into the terminal ERROR state, then drive the
    // AppController command dispatcher. RETRY_RECOVERY must call retryRecovery()
    // (ERROR -> RECOVERING); resume() early-returns unless PAUSED, so the prior
    // `resume()` wiring left ERROR recovery a no-op.
    const orch = h.orch as unknown as { state: string };
    orch.state = 'ERROR';
    expect(h.orch.getState()).toBe('ERROR');

    const retrySpy = vi.spyOn(h.orch, 'retryRecovery');
    const resumeSpy = vi.spyOn(h.orch, 'resume');

    const controller = new AppController({
      repository: h.repo,
      credentials: {} as unknown as CredentialStore,
      logger: NOOP_LOGGER,
      videosRoot: '',
      getControl: () => null,
      getStage: () => null,
      ensureStageWindow: () => {
        throw new Error('stage window is not used by command dispatch');
      },
      isDisplayConnected: () => true,
    });
    // Inject the active session so command() routes to this orchestrator.
    (controller as unknown as { active: unknown }).active = { orchestrator: h.orch };

    const result = await controller.command({ type: 'RETRY_RECOVERY' });

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(h.orch.getState()).toBe('RECOVERING');
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

  it('maps a second speechStarted from endpoint candidate to resumed speech (#15)', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
    h.orch.dispose();
    h = await makeHarness({ logger });

    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED
    const offs = bridgeSttToOrchestrator(h.stt, h.orch, () => 1000);
    try {
      h.stt.emit('speechStarted');
      expect(h.orch.getState()).toBe('USER_SPEAKING');

      // A pause ends the first speech segment and begins endpoint evaluation.
      h.stt.emit('speechStopped');
      expect(h.orch.getState()).toBe('ENDPOINT_CANDIDATE');

      // Resuming speech: the provider re-emits a bare speechStarted. This must
      // return the turn to USER_SPEAKING via speechResumed, not log an
      // invalid_transition for an illegal speechStarted from ENDPOINT_CANDIDATE.
      h.stt.emit('speechStarted');
      expect(h.orch.getState()).toBe('USER_SPEAKING');

      expect(
        logger.warn.mock.calls.some(([event]) => event === 'session.invalid_transition'),
      ).toBe(false);
    } finally {
      offs.forEach((off) => off());
    }
  });

  it('drops a stale classifierWait when speech resumes mid-evaluation (#15)', async () => {
    // A slow endpoint classifier can still be in flight when the user resumes
    // talking. Its eventual "wait" result must be ignored (not fired as an
    // illegal classifierWait from USER_SPEAKING, which would log an
    // invalid_transition — the very telemetry this issue eliminates).
    let resolveClassifier!: (d: EndpointDecision) => void;
    const model = new FakeInterviewModel();
    model.classifyEndpoint = vi.fn(
      () => new Promise<EndpointDecision>((resolve) => { resolveClassifier = resolve; }),
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
    let clockNow = 0;
    h.orch.dispose();
    h = await makeHarness({ model, logger, endpointMode: 'balanced', clock: () => clockNow });

    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED
    vi.useFakeTimers();
    try {
      clockNow = 1000;
      h.orch.onSpeechStarted(clockNow); // USER_SPEAKING, speechStartedAt = 1000
      h.orch.onSttFinalSegment('A meaningful answer with enough words to classify.');
      clockNow = 5000;
      h.orch.onSpeechStopped(clockNow); // ENDPOINT_CANDIDATE, speechEndedAt = 5000
      // speechMs = 4000 (>= 1500). Advance the 250ms endpoint tick so
      // evaluateEndpoint runs with silenceMs = 1000 (>= 900) and calls the
      // classifier, which stays unresolved.
      clockNow = 6000;
      await vi.advanceTimersByTimeAsync(300);
      expect(vi.mocked(model.classifyEndpoint)).toHaveBeenCalledTimes(1);

      // Resume speech → USER_SPEAKING; the endpoint timer is cleared, but the
      // in-flight classifier is still pending.
      clockNow = 7000;
      h.orch.onSpeechStarted(clockNow);
      expect(h.orch.getState()).toBe('USER_SPEAKING');

      // The stale "wait" result resolves — must be a no-op, not an illegal
      // classifierWait transition from USER_SPEAKING.
      resolveClassifier({ shouldCommit: false, completeProbability: 0.1, incompleteReason: 'none' });
      await Promise.resolve();
      await Promise.resolve();

      expect(h.orch.getState()).toBe('USER_SPEAKING');
      expect(
        logger.warn.mock.calls.some(([event]) => event === 'session.invalid_transition'),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
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
