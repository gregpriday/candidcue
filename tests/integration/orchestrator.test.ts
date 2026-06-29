import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { SessionOrchestrator, type OrchestratorDeps, type SessionContext } from '@main/interview/orchestrator';
import { NOOP_LOGGER, type Logger, type StagePort, type SnapshotSink, type ErrorSink } from '@main/interview/ports';
import { MemoryRepository } from '@main/persistence/memory-repository';
import { FakeInterviewModel, FakeModeration, FakeStt, FakeTts } from '@main/providers/fakes';
import { loadManifest } from '@main/media/manifest-loader';
import { AppController } from '@main/app-controller';
import { bridgeSttToOrchestrator } from '@main/interview/stt-bridge';
import { AppError, type PublicAppError } from '@shared/errors/app-error';
import type { CredentialStore } from '@main/security/secrets';
import type { EndpointMode, EndpointDecision } from '@shared/domain';
import type {
  CoverageStatus,
  InterviewBrief,
  InterviewerCharacter,
  InterviewSection,
  MediaClip,
  SessionCoverageItem,
} from '@shared/domain';
import type {
  InterviewModelAdapter,
  OperatorSessionSnapshot,
  GenerateNextActionInput,
  AudioChunkPacket,
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

/** Build a minimal enabled speaking clip of the given duration for media tests. */
function speakingClip(id: string, durationMs: number): MediaClip {
  return {
    id,
    relativePath: `mira/speaking/${id}.mp4`,
    mode: 'speaking',
    durationMs,
    width: 1280,
    height: 720,
    fps: 24,
    codec: 'h264',
    container: 'mp4',
    hasAudio: false,
    fileSizeBytes: 1000,
    sha256: id,
    enabled: true,
    tags: [],
  };
}

/** A minimal live-turn PCM packet (16 kHz mono LINEAR16) for buffered-audio tests. */
function audioPacket(sessionId: string, byteLength: number): AudioChunkPacket {
  return {
    sessionId,
    turnId: 'turn',
    sequence: 0,
    sampleRate: 16000,
    channels: 1,
    format: 'pcm_s16le',
    capturedAtMs: 0,
    payload: new ArrayBuffer(byteLength),
  };
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
  errors: PublicAppError[];
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
  recentTurnCount?: number;
  clips?: MediaClip[];
  clock?: () => number;
  logger?: Logger;
  targetQuestionCount?: number;
  character?: InterviewerCharacter;
  brief?: InterviewBrief;
}): Promise<Harness> {
  const repo = new MemoryRepository();
  await repo.migrate();

  const b = overrides?.brief ?? brief();
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
      recentTurnCount: overrides?.recentTurnCount ?? 6,
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
  const errors: PublicAppError[] = [];
  const errorSink: ErrorSink = { publish: (e) => errors.push(e) };

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
    errorSink,
    clock: overrides?.clock,
    logger: overrides?.logger,
  };

  const ctx: SessionContext = {
    session,
    brief: b,
    character: overrides?.character ?? character(),
    composedSystemPrompt: 'rules + persona',
    coverage,
    clips: overrides?.clips ?? CLIPS,
    models: { interviewer: 'gpt-5.5', cleanup: 'gpt-5.4-mini', endpoint: 'gpt-5.4-nano', repair: 'gpt-5.4-mini', stt: 'inworld-stt-1' },
    voiceId: 'Ashley',
    ttsSampleRate: 24000,
    captionsEnabled: overrides?.captionsEnabled ?? false,
    selectedOutputDeviceId: null,
    targetQuestionCount: overrides?.targetQuestionCount ?? 12,
  };

  return { orch: new SessionOrchestrator(deps, ctx), repo, stage, snapshots, errors, sessionId: session.id, stt, tts };
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
    // Overlap B (#52): the asked-turn persist and the stage preload now run in
    // parallel, so preload may already be dispatched while the persist is parked.
    // Playback is still NOT confirmed (we are awaiting the deferred persist before
    // the stale guard), so the stage was never told to play and no turn is armed.
    expect(h.stage.playSpeechPlan).not.toHaveBeenCalled();

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

  it('synthesizes the next question in parallel with the answered-turn persist (Overlap A, #52)', async () => {
    // Prove commitPipeline fans out the answered-turn DB write and the next
    // question's TTS instead of running them serially: with the persist deferred,
    // the TTS must still start. If they were serial, synthesize would not be
    // called until the persist resolved and the waitFor below would time out.
    const tts = new FakeTts({ durationMs: 7000 });
    const synthSpy = vi.spyOn(tts, 'synthesize');
    h = await makeHarness({ tts });

    await h.orch.prepareOpening(); // synth call 1 (opening)
    await h.orch.begin(); // appendTurnAtomic call: turn 1 "asked"

    // Defer the FIRST appendTurnAtomic from here on — the answered-turn persist
    // inside the commit pipeline — so we can observe the TTS overlapping it.
    let resolveAnswered!: () => void;
    const answeredDeferred = new Promise<void>((resolve) => {
      resolveAnswered = resolve;
    });
    const realAppend = h.repo.appendTurnAtomic.bind(h.repo);
    let appendCalls = 0;
    vi.spyOn(h.repo, 'appendTurnAtomic').mockImplementation(async (args) => {
      appendCalls += 1;
      if (appendCalls === 1) await answeredDeferred; // the answered persist
      return realAppend(args);
    });

    const synthBefore = synthSpy.mock.calls.length; // 1 (opening)
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    const committed = h.orch.commitUserTurn('manual');

    // The next-question synthesis (call 2) starts while the answered persist is
    // still pending — the two run concurrently.
    await vi.waitFor(() => {
      expect(synthSpy.mock.calls.length).toBe(synthBefore + 1);
    });

    resolveAnswered();
    await committed;

    // The commit completed: answer stored, next turn armed.
    expect(h.orch.getState()).toBe('USER_ARMED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.turns.find((t) => t.ordinal === 1)?.state).toBe('answered');
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(true);
  });

  it('aborts the speculative next-question TTS and discards the turn when paused mid-synthesis (Overlap A, #52)', async () => {
    // A pause while the next-question TTS is in flight must abort the synthesis
    // and the stale-generation guard must discard the next turn before it is
    // mounted — without surfacing a TTS-failure warning (the cancel is silent).
    const tts = new FakeTts({ durationMs: 7000, delayMs: 100 });
    const synthSpy = vi.spyOn(tts, 'synthesize');
    h = await makeHarness({ tts });

    await h.orch.prepareOpening();
    await h.orch.begin();

    const synthBefore = synthSpy.mock.calls.length;
    const preloadBefore = vi.mocked(h.stage.preloadSpeechPlan).mock.calls.length;
    const playBefore = vi.mocked(h.stage.playSpeechPlan).mock.calls.length;

    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    const committed = h.orch.commitUserTurn('manual');

    // Wait until the next-question synthesis has started (state INTERVIEWER_THINKING)...
    await vi.waitFor(() => {
      expect(synthSpy.mock.calls.length).toBe(synthBefore + 1);
    });
    // ...then pause mid-synthesis: bumpGeneration() aborts the in-flight TTS.
    h.orch.pause();
    await committed;

    // The next turn was discarded pre-mount: never preloaded or played, PAUSED.
    expect(h.orch.getState()).toBe('PAUSED');
    expect(vi.mocked(h.stage.preloadSpeechPlan).mock.calls.length).toBe(preloadBefore);
    expect(vi.mocked(h.stage.playSpeechPlan).mock.calls.length).toBe(playBefore);
    // The abort is a silent cancellation — not the TTS-failure recoverable pause.
    expect(h.snapshots.at(-1)!.recoverableWarning ?? '').not.toMatch(/voice/i);

    // The answer WAS durably committed before the pause, so a later resume must
    // ADVANCE (issue #9): turn 1 is answered and no turn 2 was persisted yet.
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.turns.find((t) => t.ordinal === 1)?.state).toBe('answered');
    expect(agg!.turns.find((t) => t.ordinal === 1)?.answer?.rawTranscript).toBeTruthy();
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);

    // Prove the #9 invariant end-to-end across the aborted-TTS path: because
    // currentTurnAnswered is true, resume ADVANCES (generates + plays the next
    // question, arming turn 2) rather than replaying the answered turn 1.
    await h.orch.resume();
    expect(h.orch.getState()).toBe('USER_ARMED');
    const aggAfter = await h.repo.getSession(h.sessionId);
    expect(aggAfter!.turns.find((t) => t.ordinal === 1)?.state).toBe('answered');
    expect(aggAfter!.turns.some((t) => t.ordinal === 2)).toBe(true);
  });

  it('keeps the replay path when the answered-turn persist fails during the fan-out (Overlap A, #52)', async () => {
    // The answered-turn persist hard-fails while the next-question TTS runs. The
    // answer is NOT durable, so currentTurnAnswered must stay false: a later
    // resume must REPLAY turn 1 (no next-question generation) and no turn 2 is
    // ever mounted. Covers the append-rejected branch of the fan-out matrix.
    const model = new FakeInterviewModel({ questionTexts: ['So what changed after that?'] });
    h = await makeHarness({ model });

    await h.orch.prepareOpening();
    await h.orch.begin(); // turn 1 "asked" persist (real)

    // Fail the answered-turn persist (the first appendTurnAtomic from here).
    vi.spyOn(h.repo, 'appendTurnAtomic').mockImplementationOnce(async () => {
      throw new Error('disk full');
    });

    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    // The hard failure routed to a recoverable pause; no next turn was mounted.
    expect(h.orch.getState()).toBe('PAUSED');
    let agg = await h.repo.getSession(h.sessionId);
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);

    // Resume REPLAYS turn 1 (currentTurnAnswered stayed false): no new
    // next-question generation and still no turn 2.
    const modelCallsBeforeResume = model.callCount;
    await h.orch.resume();
    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(model.callCount).toBe(modelCallsBeforeResume);
    agg = await h.repo.getSession(h.sessionId);
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);
  });

  it('discards the in-flight commit fan-out on dispose without mutating a torn-down session (Overlap A, #52)', async () => {
    // Dispose while the next-question synthesis is in flight. bumpGeneration() in
    // dispose() must trip the stale guard so the fan-out silently bails — never
    // mounting/playing the next turn and never publishing a snapshot against the
    // torn-down orchestrator.
    const tts = new FakeTts({ durationMs: 7000, delayMs: 100 });
    const synthSpy = vi.spyOn(tts, 'synthesize');
    h = await makeHarness({ tts });

    await h.orch.prepareOpening();
    await h.orch.begin();

    const synthBefore = synthSpy.mock.calls.length;
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    const committed = h.orch.commitUserTurn('manual');

    await vi.waitFor(() => {
      expect(synthSpy.mock.calls.length).toBe(synthBefore + 1);
    });
    const snapshotsBefore = h.snapshots.length;
    const preloadBefore = vi.mocked(h.stage.preloadSpeechPlan).mock.calls.length;
    const playBefore = vi.mocked(h.stage.playSpeechPlan).mock.calls.length;

    h.orch.dispose();
    await committed;

    // The next turn was never mounted/played and nothing was published after the
    // teardown — the stale guard absorbed the resolving fan-out.
    expect(vi.mocked(h.stage.preloadSpeechPlan).mock.calls.length).toBe(preloadBefore);
    expect(vi.mocked(h.stage.playSpeechPlan).mock.calls.length).toBe(playBefore);
    expect(h.snapshots.length).toBe(snapshotsBefore);
  });

  it('preloads the stage in parallel with the asked-turn persist (Overlap B, #52)', async () => {
    // Prove playCurrentTurn fans out the asked-turn persist and the stage preload
    // instead of running them serially: with the persist deferred, the preload
    // must still be dispatched. If they were serial, preload would not be called
    // until the persist resolved and the waitFor below would time out.
    let resolvePersist!: () => void;
    const persistDeferred = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    const realAppend = h.repo.appendTurnAtomic.bind(h.repo);
    vi.spyOn(h.repo, 'appendTurnAtomic').mockImplementationOnce(async (args) => {
      await persistDeferred; // the turn 1 "asked" persist
      return realAppend(args);
    });

    await h.orch.prepareOpening();
    const begun = h.orch.begin();

    // The stage preload is dispatched while the asked-turn persist is still
    // pending (Overlap B).
    await vi.waitFor(() => {
      expect(h.stage.preloadSpeechPlan).toHaveBeenCalled();
    });
    // Playback is not yet confirmed: still buffering, never told to play.
    expect(h.orch.getState()).toBe('INTERVIEWER_BUFFERING');
    expect(h.stage.playSpeechPlan).not.toHaveBeenCalled();

    resolvePersist();
    await begun;

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
      // Turns 1-4 stay under the cap: the session keeps going, arms a next
      // question, and surfaces no safety warning. Guards the off-by-one — the cap
      // fires on ordinal 5, not 4 — and an early-warning regression.
      if (i < 4) {
        expect(h.orch.getState()).toBe('USER_ARMED');
        expect(lastSnapshot().recoverableWarning).toBeNull();
      }
    }

    // The 5th answered turn tripped the cap → forced completion, no runaway turn 6.
    expect(h.orch.getState()).toBe('COMPLETED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    expect(agg!.session.currentTurnOrdinal).toBe(5);
    expect(agg!.turns.filter((t) => t.state === 'answered')).toHaveLength(5);
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
    expect(agg!.turns.filter((t) => t.state === 'answered')).toHaveLength(5);
    // Attributed to the model's `complete`, not the cap → no safety-limit warning.
    expect(lastSnapshot().recoverableWarning).toBeNull();
  });

  it('locks the cap math at a small target boundary (target 1 → cap 2)', async () => {
    const model = new FakeInterviewModel({
      questionTexts: [
        'What first drew you to this work',
        'Can you walk me through a concrete example',
        'What surprised you most along the way',
      ],
    });
    h = await makeHarness({ model, targetQuestionCount: 1 }); // cap = ceil(1 * 1.5) = 2

    await h.orch.prepareOpening();
    await h.orch.begin();

    // First answer is under the cap (ordinal 1 < 2): the session continues.
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('USER_ARMED');

    // Second answer trips the cap (ordinal 2 >= 2) → forced completion.
    h.orch.onSpeechStarted(2000);
    h.orch.onSpeechStopped(5000);
    await h.orch.commitUserTurn('manual');

    expect(h.orch.getState()).toBe('COMPLETED');
    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.session.status).toBe('completed');
    expect(agg!.session.currentTurnOrdinal).toBe(2);
    expect(agg!.turns.filter((t) => t.state === 'answered')).toHaveLength(2);
    expect(lastSnapshot().recoverableWarning).toMatch(/safety question limit/i);
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

  // --- retake (re-answer a turn after speaking, #62) -----------------------

  it('retake discards the in-progress answer and re-arms the same turn from USER_SPEAKING', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED, beginTurnCalls = 1
    h.orch.onSpeechStarted(1000); // USER_SPEAKING
    h.orch.onSttFinalSegment('a rambling first take I want to redo');
    expect(h.orch.getCommandContext().userHasSpoken).toBe(true);

    const before = await h.repo.getSession(h.sessionId);
    const turnIdBefore = before!.turns.find((t) => t.ordinal === 1)!.id;
    const endTurnSpy = vi.spyOn(h.stt, 'endTurn');

    await h.orch.retakeTurn();

    // Back at the armed user turn, ready for a clean take.
    expect(h.orch.getState()).toBe('USER_ARMED');
    // The discarded answer is gone: no speech, empty transcript.
    expect(h.orch.getCommandContext().userHasSpoken).toBe(false);
    const snap = lastSnapshot();
    expect(snap.finalTranscriptSoFar).toBe('');
    // The STT turn was re-armed (beginTurn called again), and endTurn was NOT
    // called — there is no transcript to finalize for a discarded take.
    expect(h.stt.beginTurnCalls).toBe(2);
    expect(endTurnSpy).not.toHaveBeenCalled();

    // Same turn, re-persisted as "asked" — no committed answer, no second turn.
    const after = await h.repo.getSession(h.sessionId);
    const turn1 = after!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.id).toBe(turnIdBefore);
    expect(turn1.state).toBe('asked');
    expect(turn1.answer).toBeFalsy();
    expect(after!.turns.some((t) => t.ordinal === 2)).toBe(false);
  });

  it('retake works from ENDPOINT_CANDIDATE (the user paused before deciding to redo)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000); // USER_SPEAKING
    h.orch.onSttFinalSegment('first attempt');
    h.orch.onSpeechStopped(2000); // ENDPOINT_CANDIDATE
    expect(h.orch.getState()).toBe('ENDPOINT_CANDIDATE');

    await h.orch.retakeTurn();

    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.orch.getCommandContext().userHasSpoken).toBe(false);
    expect(lastSnapshot().finalTranscriptSoFar).toBe('');
    expect(h.stt.beginTurnCalls).toBe(2);
  });

  it('retake works from a pause taken mid-answer and re-delivers the question', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000); // USER_SPEAKING — mic was open
    h.orch.onSttFinalSegment('half an answer before pausing');
    h.orch.pause(); // → PAUSED (mic-open turn), userHasSpoken preserved
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.orch.getCommandContext().userHasSpoken).toBe(true);
    expect(lastSnapshot().controls.canRetake).toBe(true);

    await h.orch.retakeTurn();

    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.orch.getCommandContext().userHasSpoken).toBe(false);
    expect(lastSnapshot().finalTranscriptSoFar).toBe('');
  });

  it('retake is illegal before any speech (Repeat covers that case)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED, no speech yet
    expect(h.orch.getCommandContext().userHasSpoken).toBe(false);
    expect(lastSnapshot().controls.canRetake).toBe(false);
    expect(lastSnapshot().controls.canRepeat).toBe(true);
    await expect(h.orch.retakeTurn()).rejects.toThrow();
  });

  it('canRetake turns true only once the creator has begun answering', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED, no speech
    expect(lastSnapshot().controls.canRetake).toBe(false);
    h.orch.onSpeechStarted(1000); // USER_SPEAKING
    expect(lastSnapshot().controls.canRetake).toBe(true);
  });

  it('drops a late STT final once the mic gate has closed (retake race guard, #62)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED
    h.orch.onSpeechStarted(1000); // USER_SPEAKING — mic open
    h.orch.onSttFinalSegment('captured while the floor was open');
    // Closing the gate (here via pause) models the retake window: any STT final
    // racing in after the floor is released must be dropped, not appended.
    h.orch.pause(); // → PAUSED, mic closed
    const snapsBefore = h.snapshots.length;
    h.orch.onSttFinalSegment('stale words after the gate closed');
    // The late final was ignored: no new snapshot, transcript unchanged.
    expect(h.snapshots.length).toBe(snapsBefore);
    expect(lastSnapshot().finalTranscriptSoFar).toBe('captured while the floor was open');
  });

  it('drops a late STT partial once the mic gate has closed (no stale caption flicker, #62)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED
    h.orch.onSpeechStarted(1000); // USER_SPEAKING — mic open
    h.orch.pause(); // → PAUSED, mic closed
    const snapsBefore = h.snapshots.length;
    h.orch.onSttPartial('stale interim from the abandoned take');
    // The stale partial was ignored: no snapshot, interim transcript stays empty.
    expect(h.snapshots.length).toBe(snapsBefore);
    expect(lastSnapshot().partialTranscript).toBe('');
  });

  it('a Retake racing a Resume from PAUSED does not spuriously re-open the mic (#62)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED
    h.orch.onSpeechStarted(1000); // USER_SPEAKING — mic was open, userHasSpoken
    h.orch.onSttFinalSegment('half a take before pausing');
    h.orch.pause(); // → PAUSED (mic-open turn)
    expect(h.orch.getState()).toBe('PAUSED');

    // Hold resumeTurn so a Retake can fire while resume() is parked on the await.
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((r) => {
      releaseResume = r;
    });
    vi.spyOn(h.stt, 'resumeTurn').mockImplementationOnce(async () => {
      await resumeGate;
    });

    h.stage.openMicGate.mockClear();
    const resuming = h.orch.resume(); // parks on resumeTurn await, still PAUSED
    // Retake is legal from PAUSED with speech and drives into INTERVIEWER_BUFFERING
    // before the stale resume's await resolves.
    const retaking = h.orch.retakeTurn();
    releaseResume();
    await Promise.all([resuming, retaking]);

    // The retake owns the session: a fresh USER_ARMED take. The stale resume's
    // resumeUserTurn transition was rejected (illegal from INTERVIEWER_BUFFERING),
    // so the ONLY openMicGate is the legitimate one at the end of the retake's
    // playCurrentTurn — never a spurious second open over the re-delivery.
    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.orch.getCommandContext().userHasSpoken).toBe(false);
    expect(lastSnapshot().finalTranscriptSoFar).toBe('');
    expect(h.stage.openMicGate).toHaveBeenCalledTimes(1);
  });

  it('silently re-arms the same turn on an empty answer instead of pausing (issue #61)', async () => {
    h = await makeHarness({ stt: new FakeStt({ transcript: '' }) });
    await h.orch.prepareOpening();
    await h.orch.begin();
    expect(h.stt.beginTurnCalls).toBe(1); // armed for the first attempt
    const openGatesBefore = h.stage.openMicGate.mock.calls.length;

    h.orch.onSpeechStarted(1000); // a cough trips speechStarted but yields no text
    h.orch.onSpeechStopped(2000);
    await h.orch.commitUserTurn('manual');

    // No pause: the creator is dropped straight back to listening on the SAME
    // turn so they can simply keep talking (no Resume to hunt for).
    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.stt.beginTurnCalls).toBe(2); // re-armed (a fresh STT turn, same turn id)
    expect(h.stage.openMicGate.mock.calls.length).toBe(openGatesBefore + 1);

    const snap = h.snapshots.at(-1)!;
    expect(snap.recoverableWarning).toBeNull(); // no "Resume to try again" prompt
    expect(snap.mic.gate).toBe('armed'); // mic re-opened and waiting for speech
    // Capture state was reset before the snapshot published, so userHasSpoken is
    // false again — Skip/Repeat are legal exactly as on the fresh arm, with no
    // stale speechStartedAt mis-gating them.
    expect(snap.controls.canSkip).toBe(true);
    expect(snap.controls.canRepeat).toBe(true);

    // Nothing was invented or persisted (spec §14.6, §22.3): the turn is still
    // just "asked", with no answer and no second turn.
    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.state).toBe('asked');
    expect(turn1.answer).toBeFalsy();
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);
  });

  it('re-arms repeatedly on consecutive empty answers without persisting anything (issue #61)', async () => {
    h = await makeHarness({ stt: new FakeStt({ transcript: '' }) });
    await h.orch.prepareOpening();
    await h.orch.begin();

    for (const [start, stop] of [
      [1000, 2000],
      [3000, 4000],
    ]) {
      h.orch.onSpeechStarted(start);
      h.orch.onSpeechStopped(stop);
      await h.orch.commitUserTurn('manual');
      expect(h.orch.getState()).toBe('USER_ARMED');
    }

    // Two coughs → two re-arms, on top of the initial arm. No retry cap kicks in.
    expect(h.stt.beginTurnCalls).toBe(3);
    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.state).toBe('asked');
    expect(turn1.answer).toBeFalsy();
    expect(agg!.turns.some((t) => t.ordinal === 2)).toBe(false);
  });

  it('accepts a real answer after an empty-answer re-arm, persisting it under the same turn (issue #61)', async () => {
    h = await makeHarness({ stt: new FakeStt({ transcript: '' }) });
    await h.orch.prepareOpening();
    await h.orch.begin();

    // First attempt is an empty cough → silent re-arm.
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(2000);
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('USER_ARMED');

    // Second attempt on the same turn captures a real answer.
    h.stt.pushTranscript('A real answer this time around.');
    h.orch.onSpeechStarted(3000);
    h.orch.onSpeechStopped(5000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    const ordinal1 = agg!.turns.filter((t) => t.ordinal === 1);
    expect(ordinal1).toHaveLength(1); // the cough left no duplicate turn record
    expect(ordinal1[0]!.state).toBe('answered');
    expect(ordinal1[0]!.answer?.rawTranscript).toContain('A real answer this time around');
  });

  it('routes a dropped transport during empty-answer re-arm through RECOVERING (issue #61)', async () => {
    h = await makeHarness({ stt: new FakeStt({ transcript: '' }) });
    await h.orch.prepareOpening();
    await h.orch.begin();

    // The STT transport drops in the window where the empty answer re-arms the
    // turn, so the re-arm beginTurn throws STT_DISCONNECTED. Hold the reconnect
    // open so RECOVERING is observable before it auto-resolves.
    h.stt.failBeginTurn = true;
    let releaseReconnect!: () => void;
    h.stt.reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });

    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(2000);
    await h.orch.commitUserTurn('manual');

    // Instead of sitting USER_ARMED with the mic open and STT deaf, the empty
    // re-arm routed the dropped transport into RECOVERING with the mic closed.
    expect(h.orch.getState()).toBe('RECOVERING');
    expect(h.snapshots.at(-1)!.mic.gate).toBe('closed');

    // Auto-reconnect restores the transport and lands in PAUSED.
    releaseReconnect();
    await vi.waitFor(() => expect(h.orch.getState()).toBe('PAUSED'));
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

  it('recovers the full answer from buffered audio when the live stream drops mid-answer (#69)', async () => {
    // The live finalize fails (stream dropped mid-answer). The orchestrator
    // buffered the turn's PCM, so it batch re-transcribes the WHOLE turn via
    // recoverFromAudio and ships that complete transcript — not the truncated
    // streamed partial — flagging the answer as recovered-from-buffered-audio.
    const stt = new FakeStt({ transcript: 'the complete recovered answer from buffered audio' });
    stt.endTurn = vi.fn(async () => {
      throw new Error('stream dropped mid-answer');
    });
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    // The truncated partial the live stream managed before dropping.
    h.orch.onSttFinalSegment('the complete');
    // Non-empty buffered PCM → recoverFromAudio returns the full transcript.
    h.orch.onAudioChunk(audioPacket(h.sessionId, 4096));
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.state).toBe('answered');
    expect(turn1.answer?.rawTranscript).toBe('the complete recovered answer from buffered audio');
    expect(turn1.answer?.recoveredFromBufferedAudio).toBe(true);
  });

  it('falls back to the streamed partial when buffered-audio recovery yields nothing (#69)', async () => {
    // Finalize fails AND batch recovery comes back empty (e.g. the REST endpoint
    // could not transcribe either). The answer must keep the streamed partial and
    // stay un-flagged — recovered-from-buffered-audio is only true when recovery
    // actually produced text.
    const stt = new FakeStt({ transcript: 'unused' });
    stt.endTurn = vi.fn(async () => {
      throw new Error('stream dropped mid-answer');
    });
    stt.recoverFromAudio = vi.fn(async () => ({ text: '', finalSegments: [], confidence: null }));
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSttFinalSegment('the streamed partial answer');
    h.orch.onAudioChunk(audioPacket(h.sessionId, 4096));
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.state).toBe('answered');
    expect(turn1.answer?.rawTranscript).toBe('the streamed partial answer');
    expect(turn1.answer?.recoveredFromBufferedAudio).toBe(false);
    expect(stt.recoverFromAudio).toHaveBeenCalledTimes(1);
  });

  it('does NOT attempt buffered-audio recovery when no PCM was captured (#69)', async () => {
    // Finalize fails but no audio was ever buffered (no-mic / no onAudioChunk).
    // The recovery branch is gated on turnPcmChunks.length > 0, so recoverFromAudio
    // must never be called and the streamed partial is used unflagged.
    const stt = new FakeStt({ transcript: 'should never be used' });
    stt.endTurn = vi.fn(async () => {
      throw new Error('stream dropped mid-answer');
    });
    const recoverSpy = vi.spyOn(stt, 'recoverFromAudio');
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSttFinalSegment('partial with no buffered audio');
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(recoverSpy).not.toHaveBeenCalled();
    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.answer?.rawTranscript).toBe('partial with no buffered audio');
    expect(turn1.answer?.recoveredFromBufferedAudio).toBe(false);
  });

  it('discards a buffered-audio recovery that resolves after the session is disposed (#69)', async () => {
    // The stale-generation guard must bail before persisting if a pause/dispose
    // bumps the generation while the recovery POST is in flight, so a late
    // result can't be committed against a torn-down session.
    const stt = new FakeStt({ transcript: 'late recovery text' });
    stt.endTurn = vi.fn(async () => {
      throw new Error('stream dropped mid-answer');
    });
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    stt.recoverFromAudio = vi.fn(async () => {
      await recoveryGate;
      return { text: 'late recovery text', finalSegments: ['late recovery text'], confidence: null };
    });
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSttFinalSegment('partial');
    h.orch.onAudioChunk(audioPacket(h.sessionId, 4096));
    h.orch.onSpeechStopped(4000);

    // Start the commit but don't await — it parks on the recovery gate.
    const committing = h.orch.commitUserTurn('manual');
    await vi.waitFor(() => {
      expect(stt.recoverFromAudio).toHaveBeenCalled();
    });

    // Dispose mid-recovery: bumps the generation, invalidating this turn.
    h.orch.dispose();
    releaseRecovery();
    await committing;

    const agg = await h.repo.getSession(h.sessionId);
    expect(agg!.turns.some((t) => t.state === 'answered')).toBe(false);
  });

  it('triggers recovery when endTurn resolves via its deadline on a real stream drop (#69)', async () => {
    // The real InworldSttClient does NOT throw on a mid-answer drop — endTurn
    // resolves at its internal deadline with hitDeadline=true and whatever
    // partial accumulated. Gating on a thrown/timed-out endTurn alone would miss
    // this (the common production case), so the orchestrator also keys off
    // hitDeadline. Here endTurn returns a truncated partial flagged hitDeadline,
    // and recovery replaces it with the full buffered-audio transcript.
    const stt = new FakeStt({ transcript: 'the truncated streamed partial' });
    stt.deadlineOnEndTurn = true;
    stt.recoverFromAudio = vi.fn(async () => ({
      text: 'the full answer recovered from buffered audio',
      finalSegments: ['the full answer recovered from buffered audio'],
      confidence: null,
    }));
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onAudioChunk(audioPacket(h.sessionId, 4096));
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(stt.recoverFromAudio).toHaveBeenCalledTimes(1);
    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.answer?.rawTranscript).toBe('the full answer recovered from buffered audio');
    expect(turn1.answer?.recoveredFromBufferedAudio).toBe(true);
  });

  it('does NOT recover on a clean finalize even when audio was buffered (#69)', async () => {
    // A healthy turn: endTurn returns a genuine FINAL (hitDeadline falsy, no
    // throw). Recovery must NOT run — re-transcribing every healthy turn would be
    // wasteful and could overwrite a perfectly good streamed transcript.
    const stt = new FakeStt({ transcript: 'the clean final transcript' });
    const recoverSpy = vi.spyOn(stt, 'recoverFromAudio');
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onAudioChunk(audioPacket(h.sessionId, 4096));
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(recoverSpy).not.toHaveBeenCalled();
    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.answer?.rawTranscript).toBe('the clean final transcript');
    expect(turn1.answer?.recoveredFromBufferedAudio).toBe(false);
  });

  it('concatenates buffered PCM chunks in order for recovery (#69)', async () => {
    // Validates concatTurnPcm() ordering and that the defensive .slice(0) copy
    // preserves the bytes: three identifiable chunks must reach recoverFromAudio
    // as one contiguous buffer in arrival order.
    const stt = new FakeStt({ transcript: 'recovered' });
    stt.deadlineOnEndTurn = true;
    let receivedPcm: Uint8Array | null = null;
    stt.recoverFromAudio = vi.fn(async (pcm: Uint8Array) => {
      receivedPcm = pcm;
      return { text: 'recovered', finalSegments: ['recovered'], confidence: null };
    });
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    const filledPacket = (byte: number, len: number): AudioChunkPacket => {
      const packet = audioPacket(h.sessionId, len);
      new Uint8Array(packet.payload).fill(byte);
      return packet;
    };
    h.orch.onAudioChunk(filledPacket(0x01, 2));
    h.orch.onAudioChunk(filledPacket(0x02, 3));
    h.orch.onAudioChunk(filledPacket(0x03, 1));
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(receivedPcm).not.toBeNull();
    expect(Array.from(receivedPcm!)).toEqual([0x01, 0x01, 0x02, 0x02, 0x02, 0x03]);
  });

  it('falls back to the streamed partial when buffered-audio recovery throws (#69)', async () => {
    // recoverFromAudio rejecting (e.g. an INWORLD_AUTH 401 from the batch
    // endpoint) must be caught by the recovery deadline wrapper, leave the
    // streamed partial in place, and never surface an unhandled rejection.
    const stt = new FakeStt({ transcript: 'unused' });
    stt.endTurn = vi.fn(async () => {
      throw new Error('stream dropped mid-answer');
    });
    stt.recoverFromAudio = vi.fn(async () => {
      throw new AppError('INWORLD_AUTH', { message: 'batch STT auth failed' });
    });
    h = await makeHarness({ stt });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSttFinalSegment('the streamed partial answer');
    h.orch.onAudioChunk(audioPacket(h.sessionId, 4096));
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const agg = await h.repo.getSession(h.sessionId);
    const turn1 = agg!.turns.find((t) => t.ordinal === 1)!;
    expect(turn1.answer?.rawTranscript).toBe('the streamed partial answer');
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
    // A self-healing STT disconnect must NOT light up the global error banner
    // (issue #20): recoverable faults surface via the snapshot warning only.
    expect(h.errors).toHaveLength(0);
  });

  it('emits a fatal error to the error sink so the global banner can show it (issue #20)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.stt.pushTranscript('a captured answer');
    // An unrecoverable persistence failure mid-commit has no per-screen handler,
    // so it must surface on the global banner via the error sink.
    vi.spyOn(h.repo, 'recordRawAnswer').mockRejectedValueOnce(
      new AppError('DATABASE_FAILED', { message: 'db down' }),
    );
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.errors).toHaveLength(1);
    // Full PublicAppError shape — the banner reads publicMessage, so a
    // serialization bug here would silently render an empty banner.
    expect(h.errors[0]!.code).toBe('DATABASE_FAILED');
    expect(h.errors[0]!.publicMessage).toBe('We could not save session data.');
    expect(h.errors[0]!.recoverable).toBe(false);
    expect(h.errors[0]!.retryAction).toBe(null);
  });

  it('does NOT emit a recoverable failure (transient TTS) to the banner (issue #20)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.stt.pushTranscript('a captured answer');
    // A recoverable TTS failure self-heals via the snapshot warning; it must not
    // spam the global banner.
    vi.spyOn(h.repo, 'recordRawAnswer').mockRejectedValueOnce(
      new AppError('TTS_FAILED', { message: 'tts blip' }),
    );
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.errors).toHaveLength(0);
  });

  it('wraps a non-AppError throw as unrecoverable UNKNOWN and emits it (issue #20)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.stt.pushTranscript('a captured answer');
    // A plain (non-AppError) rejection must still surface: handlePipelineFailure
    // wraps it as UNKNOWN, which is unrecoverable by default, so the banner fires.
    vi.spyOn(h.repo, 'recordRawAnswer').mockRejectedValueOnce(new Error('boom'));
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.code).toBe('UNKNOWN');
    expect(h.errors[0]!.recoverable).toBe(false);
  });

  it('respects an instance override of recoverable even for a normally-fatal code (issue #20)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.stt.pushTranscript('a captured answer');
    // DATABASE_FAILED defaults to recoverable:false, but the throw site can opt a
    // specific instance into recoverability. The gate must read the instance flag
    // (not just the code default) and suppress the banner for this one.
    vi.spyOn(h.repo, 'recordRawAnswer').mockRejectedValueOnce(
      new AppError('DATABASE_FAILED', { message: 'transient', recoverable: true }),
    );
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('PAUSED');
    expect(h.errors).toHaveLength(0);
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

  // --- issue #26: orchestrator cleanup (dead branches + correctness nits) -----

  it('uses the session recentTurnCount setting, not a hardcoded 6 (item #26)', async () => {
    h = await makeHarness({ recentTurnCount: 3 });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    const spy = vi.spyOn(h.repo, 'getRecentTurns');

    await h.orch.commitUserTurn('manual');

    // The dead `maxQuestionWords > 0 ? 6 : 6` ternary is gone; the configured
    // per-session value now drives the repository fetch (and the context build).
    expect(spy).toHaveBeenCalledWith(h.sessionId, 3);
  });

  it('publishes a PREPARING snapshot when preparing the opening (item #26)', async () => {
    await h.orch.prepareOpening();
    expect(h.orch.getState()).toBe('READY');
    // IDLE→PREPARING now routes through transition(), which publishes stage +
    // snapshot, so the UI sees PREPARING immediately (spec PREPARING.stt='warming')
    // — not only the final READY projection the old direct assignment produced.
    expect(h.snapshots.some((s) => s.state === 'PREPARING')).toBe(true);
  });

  it('speaks the model closing line and closes STT on completion (item #26)', async () => {
    const model = new FakeInterviewModel({
      scriptedActions: [{ action: 'complete', spokenText: 'Thanks for sharing all of that.' }],
    });
    h = await makeHarness({ model, captionsEnabled: true });
    await h.orch.prepareOpening();
    await h.orch.begin();
    const ttsBefore = h.tts.seen.length;
    const micOpensBefore = h.stage.openMicGate.mock.calls.length;
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);

    await h.orch.commitUserTurn('manual');

    expect(h.orch.getState()).toBe('COMPLETED');
    // The model's closing line is synthesized + played (one extra TTS call) — it
    // is no longer discarded on completion.
    expect(h.tts.seen.length).toBe(ttsBefore + 1);
    expect(h.tts.seen.at(-1)?.text).toBe('Thanks for sharing all of that.');
    // The closing line actually plays: a 'speaking' stage projection carrying the
    // closing text was published (the renderer only calls speechPlayer.start() on
    // visualState 'speaking' — preload alone just decodes), and the stage was
    // asked to play the closing plan under its own turn id. Without this the line
    // would preload then hang silently until the play deadline (#26 review).
    const projections = vi.mocked(h.stage.setVisualState).mock.calls.map((c) => c[0]);
    expect(
      projections.some(
        (p) => p.visualState === 'speaking' && p.captions === 'Thanks for sharing all of that.',
      ),
    ).toBe(true);
    expect(h.stage.playSpeechPlan).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'closing', text: 'Thanks for sharing all of that.' }),
    );
    // The closing sign-off never re-arms the creator: the mic opens only for the
    // original question, not again for the closing line.
    expect(h.stage.openMicGate.mock.calls.length).toBe(micOpensBefore);
    // Reaching COMPLETED proactively closes the STT transport (COMPLETED.stt='closed').
    expect(h.stt.closed).toBe(true);
    // Teardown closes STT again; the adapter tolerates the double close.
    await expect(h.stt.close()).resolves.toBeUndefined();
    expect(h.stt.closed).toBe(true);
  });

  it('does not synthesize a closing line on endNow and still closes STT (item #26)', async () => {
    await h.orch.prepareOpening();
    await h.orch.begin();
    const ttsBefore = h.tts.seen.length;

    await h.orch.endNow();

    expect(h.orch.getState()).toBe('COMPLETED');
    // endNow is an operator abort with no model action, so there is no closing
    // sign-off — and the three silent skip/close paths stay silent too (the line
    // is voiced only for an explicit `complete` action with non-empty text).
    expect(h.tts.seen.length).toBe(ttsBefore);
    expect(h.stt.closed).toBe(true);
  });

  it('stays silent on a coverage-complete commit with no spokenText (item #26)', async () => {
    // Same empty-complete shape the skip path covers (#13), but reached via the
    // coverage-complete commit arm: the closing line is voiced only for an
    // explicit `complete` with non-empty text, so an empty one completes silently.
    const model = new FakeInterviewModel({
      scriptedActions: [{ action: 'complete', spokenText: '', shouldCloseAfterAnswer: false }],
    });
    h = await makeHarness({ model });
    await h.orch.prepareOpening();
    await h.orch.begin();
    const ttsBefore = h.tts.seen.length;
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);

    await h.orch.commitUserTurn('manual');

    expect(h.orch.getState()).toBe('COMPLETED');
    expect(h.tts.seen.length).toBe(ttsBefore); // empty closing line is not voiced
    expect(h.stt.closed).toBe(true);
    // No closing-line playback was attempted.
    expect(h.stage.playSpeechPlan).not.toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'closing' }),
    );
  });

  it('replans a different speaking clip on repeat without re-synthesizing TTS (item #26)', async () => {
    // Two equal-duration speaking clips: both are single-match eligible, so
    // planSpeaking breaks the tie by recency. The just-played clip is penalized,
    // so the repeat picks the other — reusing the cached TTS audio (no synth).
    const clips: MediaClip[] = [speakingClip('clip-a', 7000), speakingClip('clip-b', 7000)];
    h = await makeHarness({ clips, tts: new FakeTts({ durationMs: 7000 }) });
    await h.orch.prepareOpening();
    await h.orch.begin();
    const ttsBefore = h.tts.seen.length;
    const firstClip = vi
      .mocked(h.stage.preloadSpeechPlan)
      .mock.calls.at(-1)![0].media.segments[0]!.clipId;

    await h.orch.repeatQuestion();

    const repeatClip = vi
      .mocked(h.stage.preloadSpeechPlan)
      .mock.calls.at(-1)![0].media.segments[0]!.clipId;
    expect(repeatClip).toBeTruthy();
    expect(repeatClip).not.toBe(firstClip); // a different clip was chosen
    expect(h.tts.seen.length).toBe(ttsBefore); // TTS not re-synthesized on repeat
    expect(h.orch.getState()).toBe('USER_ARMED');
  });

  it('tolerates a repeat when only one speaking clip is eligible (item #26)', async () => {
    // Real manifest: for a 7s speech only one ~7s speaking clip fits the rate
    // band, so the repeat must fall back to the same clip without throwing (the
    // "choose a different clip when possible" escape hatch).
    h = await makeHarness({ tts: new FakeTts({ durationMs: 7000 }) });
    await h.orch.prepareOpening();
    await h.orch.begin();

    await expect(h.orch.repeatQuestion()).resolves.toBeUndefined();
    expect(h.orch.getState()).toBe('USER_ARMED');
  });
});

// Mira used to read every question with identical flat affect because the
// orchestrator hardcoded `speakingRate: 1.0` on every synthesis call (#56). The
// rate now flows from the character config, overridable per turn by the model's
// delivery hint, clamped to a safe band.
describe('SessionOrchestrator delivery-rate threading (#56)', () => {
  const charWithRate = (rate: number): InterviewerCharacter => {
    const base = character();
    return { ...base, voice: { ...base.voice, speakingRate: rate } };
  };

  let h: Harness;
  afterEach(() => {
    h?.orch.dispose();
  });

  it('synthesizes the opening question at the character speaking rate, not a hardcoded 1.0', async () => {
    h = await makeHarness({ character: charWithRate(0.95) });
    await h.orch.prepareOpening();
    expect(h.tts.seen[0]?.speakingRate).toBe(0.95);
    expect(h.tts.seen[0]?.style).toBe('neutral');
  });

  it('uses the model delivery hint for the next question rate', async () => {
    const model = new FakeInterviewModel({
      scriptedActions: [{ deliveryHint: { speakingRate: 1.1 } }],
    });
    h = await makeHarness({ model, character: charWithRate(0.95) });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    const before = h.tts.seen.length;
    await h.orch.commitUserTurn('manual');

    // The next (second) question was synthesized from the scripted action's hint.
    expect(h.tts.seen.length).toBeGreaterThan(before);
    expect(h.tts.seen.at(-1)?.speakingRate).toBe(1.1);
  });

  it('falls back to the character rate when the model emits no delivery hint', async () => {
    // FakeInterviewModel.defaultAction() carries no deliveryHint, so the next
    // question must inherit the character default rather than snapping to 1.0.
    h = await makeHarness({ character: charWithRate(0.95) });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(h.tts.seen.at(-1)?.speakingRate).toBe(0.95);
  });

  it('clamps an out-of-range delivery hint to the safe maximum', async () => {
    // 1.9 bypasses the Zod guard (the fake returns the action directly); the
    // orchestrator's own clamp must still absorb it before it reaches TTS.
    const model = new FakeInterviewModel({
      scriptedActions: [{ deliveryHint: { speakingRate: 1.9 } }],
    });
    h = await makeHarness({ model });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(h.tts.seen.at(-1)?.speakingRate).toBe(1.15);
  });

  it('clamps an under-range delivery hint to the safe minimum', async () => {
    // Lower-bound twin of the test above: guards against a swapped MIN/MAX in
    // clampDeliveryRate. 0.1 must floor to 0.85, not pass through.
    const model = new FakeInterviewModel({
      scriptedActions: [{ deliveryHint: { speakingRate: 0.1 } }],
    });
    h = await makeHarness({ model });
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(h.tts.seen.at(-1)?.speakingRate).toBe(0.85);
  });

  it('threads the delivery hint when a skip lands on a follow-up question', async () => {
    // Skip-to-ask is the common skip destination; confirm the hint flows
    // action -> record -> TTS on that path too (not just the commit path).
    const model = new FakeInterviewModel({
      scriptedActions: [{ action: 'ask', spokenText: 'What changed after that?', deliveryHint: { speakingRate: 1.1 } }],
    });
    h = await makeHarness({ model, character: charWithRate(0.95) });
    await h.orch.prepareOpening();
    await h.orch.begin();
    await h.orch.skipQuestion();

    expect(h.orch.getState()).toBe('USER_ARMED');
    expect(h.tts.seen.at(-1)?.speakingRate).toBe(1.1);
  });

  it('synthesizes the closing line at the character rate', async () => {
    const model = new FakeInterviewModel({
      scriptedActions: [{ action: 'complete', spokenText: 'Thank you so much for your time.' }],
    });
    h = await makeHarness({ model, character: charWithRate(0.95) });
    await h.orch.prepareOpening();
    await h.orch.begin();
    await h.orch.skipQuestion();

    expect(h.orch.getState()).toBe('COMPLETED');
    // The opening used the character rate; the closing line must too.
    expect(h.tts.seen.at(-1)?.speakingRate).toBe(0.95);
    expect(h.tts.seen.at(-1)?.text).toContain('Thank you');
  });
});

/**
 * A two-section arc (problem → mechanism) for exercising narrative-arc wiring.
 * Coverage statuses and array order are configurable so a single fixture can
 * drive initialization, advancement, and reconstruction cases.
 */
function arcBrief(opts?: {
  problemStatus?: CoverageStatus;
  mechanismStatus?: CoverageStatus;
  arcOrder?: 'forward' | 'reverse';
}): InterviewBrief {
  const sectionA: InterviewSection = {
    id: 'section-A',
    label: 'Problem',
    objective: 'Establish the problem and audience.',
    order: 0,
    entryCondition: 'session start',
    exitCriteria: ['problem articulated'],
    coverageItemIds: ['cov-problem'],
    suggestedQuestionTypes: ['opening', 'context'],
  };
  const sectionB: InterviewSection = {
    id: 'section-B',
    label: 'Mechanism',
    objective: 'Explain how the product works.',
    order: 1,
    entryCondition: 'problem established',
    exitCriteria: ['mechanism explained'],
    coverageItemIds: ['cov-mechanism'],
    suggestedQuestionTypes: ['mechanism', 'example'],
  };
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
        status: opts?.problemStatus ?? 'not_started',
        evidenceTurnIds: [],
        maxFollowUps: 2,
        sourceRefs: [],
      },
      {
        id: 'cov-mechanism',
        label: 'How it works',
        objective: 'Explain the core answer-capture loop.',
        priority: 'must',
        status: opts?.mechanismStatus ?? 'not_started',
        evidenceTurnIds: [],
        maxFollowUps: 2,
        sourceRefs: [],
      },
    ],
    arc: opts?.arcOrder === 'reverse' ? [sectionB, sectionA] : [sectionA, sectionB],
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
        targetCoverageItemIds: ['cov-mechanism'],
        useWhen: 'Core loop uncovered',
      },
    ],
    closingStrategy: 'Ask for the single most important takeaway.',
  };
}

describe('SessionOrchestrator narrative arc (#67)', () => {
  let h: Harness;
  afterEach(() => {
    h?.orch.dispose();
  });

  it('threads the active arc section into model calls and advances on the model proposal', async () => {
    // Call #1 runs while still in the opening section A; its scripted action then
    // moves the interview to section B. The orchestrator must accept the (real)
    // arc id and feed it into the NEXT model call.
    const model = new FakeInterviewModel({
      scriptedActions: [{ currentSectionId: 'section-B' }],
      questionTexts: ['How does the core loop actually work?', 'What surprised you most?'],
    });
    const generateSpy = vi.spyOn(model, 'generateNextAction');
    h = await makeHarness({ model, brief: arcBrief() });

    // Turn 1 → model call #1 (activeSectionId initialized to section-A from arc order).
    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');
    expect(h.orch.getState()).toBe('USER_ARMED');

    // Turn 2 → model call #2 (section advanced to section-B by call #1's action).
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    const firstInput = generateSpy.mock.calls[0]?.[0];
    const secondInput = generateSpy.mock.calls[1]?.[0];
    expect(firstInput?.currentSectionId).toBe('section-A');
    expect(secondInput?.currentSectionId).toBe('section-B');
  });

  it('passes a null section when the brief has no arc (pre-#67 behavior preserved)', async () => {
    const model = new FakeInterviewModel({ questionTexts: ['So what changed after that?'] });
    const generateSpy = vi.spyOn(model, 'generateNextAction');
    h = await makeHarness({ model }); // default brief() has arc: []

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(generateSpy.mock.calls[0]?.[0]?.currentSectionId).toBeNull();
  });

  it('ignores an unknown section id from the model and holds the active section', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      info: () => {},
      warn: (event) => warnings.push(event),
      error: () => {},
    };
    const model = new FakeInterviewModel({
      scriptedActions: [{ currentSectionId: 'section-does-not-exist' }],
      questionTexts: ['How does the core loop actually work?', 'What surprised you most?'],
    });
    const generateSpy = vi.spyOn(model, 'generateNextAction');
    h = await makeHarness({ model, brief: arcBrief(), logger });

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    // The bogus id was rejected, so the section held at section-A for call #2,
    // and the rejection was logged as prompt-tuning signal.
    expect(generateSpy.mock.calls[0]?.[0]?.currentSectionId).toBe('section-A');
    expect(generateSpy.mock.calls[1]?.[0]?.currentSectionId).toBe('section-A');
    expect(warnings).toContain('session.unknown_section_id_ignored');
  });

  it('advances the active section when the model proposes one on a skip', async () => {
    // Skip generates a next action just like a committed turn; a section advance
    // proposed there must persist into the following model call (#67).
    const model = new FakeInterviewModel({
      scriptedActions: [{ currentSectionId: 'section-B' }],
      questionTexts: ['How does the core loop actually work?', 'What surprised you most?'],
    });
    const generateSpy = vi.spyOn(model, 'generateNextAction');
    h = await makeHarness({ model, brief: arcBrief() });

    await h.orch.prepareOpening();
    await h.orch.begin(); // USER_ARMED, no speech yet → skip is legal
    await h.orch.skipQuestion(); // model call #1 (section-A), proposes section-B
    expect(h.orch.getState()).toBe('USER_ARMED');

    // The next committed turn → model call #2 must carry the advanced section.
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(generateSpy.mock.calls[0]?.[0]?.currentSectionId).toBe('section-A');
    expect(generateSpy.mock.calls[1]?.[0]?.currentSectionId).toBe('section-B');
  });

  it('advances the active section when the model proposes one on a resume-advance', async () => {
    // Answer committed but next-question TTS fails → PAUSED with the answered
    // flag set. resume() re-generates the next action (issue #9); a section
    // advance proposed on THAT call must persist into the following model call.
    const model = new FakeInterviewModel({
      scriptedActions: [{ currentSectionId: 'section-A' }, { currentSectionId: 'section-B' }],
      questionTexts: ['How does the core loop actually work?', 'What surprised you most?'],
    });
    const generateSpy = vi.spyOn(model, 'generateNextAction');
    const tts = new FakeTts({ durationMs: 7000, failAfterCalls: 2 });
    h = await makeHarness({ model, tts, brief: arcBrief() });

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual'); // call #1 holds section-A; turn-2 TTS fails
    expect(h.orch.getState()).toBe('PAUSED');

    tts.resetFailure();
    await h.orch.resume(); // call #2 (resume-advance) proposes section-B
    expect(h.orch.getState()).toBe('USER_ARMED');

    // A subsequent committed turn → call #3 must carry the resume-advanced section.
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(generateSpy.mock.calls[1]?.[0]?.currentSectionId).toBe('section-A');
    expect(generateSpy.mock.calls[2]?.[0]?.currentSectionId).toBe('section-B');
  });

  it('initializes the active section by arc order, not array order', async () => {
    // Arc array is reversed (section-B first); both sections have open items.
    // The constructor must sort by `order` and start at section-A (order 0).
    const model = new FakeInterviewModel({ questionTexts: ['So what changed after that?'] });
    const generateSpy = vi.spyOn(model, 'generateNextAction');
    h = await makeHarness({ model, brief: arcBrief({ arcOrder: 'reverse' }) });

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(generateSpy.mock.calls[0]?.[0]?.currentSectionId).toBe('section-A');
  });

  it('reconstructs the active section from coverage state (skips a fully-covered section)', async () => {
    // Section A's only coverage item is already covered; section B's is open.
    // The constructor must initialize the active section to B (resume path).
    const model = new FakeInterviewModel({ questionTexts: ['So what changed after that?'] });
    const generateSpy = vi.spyOn(model, 'generateNextAction');
    h = await makeHarness({ model, brief: arcBrief({ problemStatus: 'covered' }) });

    await h.orch.prepareOpening();
    await h.orch.begin();
    h.orch.onSpeechStarted(1000);
    h.orch.onSpeechStopped(4000);
    await h.orch.commitUserTurn('manual');

    expect(generateSpy.mock.calls[0]?.[0]?.currentSectionId).toBe('section-B');
  });
});
