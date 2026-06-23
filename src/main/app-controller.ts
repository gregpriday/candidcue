import { dialog, type WebContents } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import type {
  CandidCueRepository,
  ProviderTestResult,
  OperatorSessionSnapshot,
  StageStateProjection,
  SpeechPlaybackPlan,
  PreflightState,
  PreflightCheck,
  PreparationJobResult,
  CommandResult,
  ExportResult,
  SessionReview,
  PrepareSessionInput,
  PublicSettings,
  StageBootstrap,
  ProviderCredentialInput,
  InterviewModelAdapter,
  ModerationAdapter,
  SpeechToTextAdapter,
  TextToSpeechAdapter,
  CaptureConfig,
  AudioMeterReading,
  Unsubscribe,
} from '@shared/contracts';
import { CHANNELS } from '@shared/contracts';
import type {
  SaveProjectInput,
  ProjectAggregate,
  ProjectSummary,
  SessionCommand,
  InterviewPlan,
  SessionCoverageItem,
  PublicCharacterSummary,
} from '@shared/domain';
import { newId } from '@shared/domain';
import { MODEL_DEFAULTS, INWORLD_DEFAULTS, RUNTIME_DEFAULTS, PROJECT_LIMITS } from '@shared/constants/runtime-defaults';
import { AppError, isAppError } from '@shared/errors/app-error';
import { hashFromProjectDocuments } from '@shared/utils';

import { SessionOrchestrator, type OrchestratorDeps, type SessionContext } from './interview/orchestrator';
import { bridgeSttToOrchestrator } from './interview/stt-bridge';
import type { StagePort, SnapshotSink, Logger } from './interview/ports';
import { compileProjectSource } from './interview/source-compiler';
import { GLOBAL_INTERVIEW_RULES } from './interview/global-rules';
import { getInterviewerCharacters, getInterviewerCharacter, composeCharacterSystemPrompt } from './characters';
import { CredentialStore, publicKeyState } from './security/secrets';
import { buildOpenAiAdapters, buildInworldAdapters } from './providers/factory';
import { loadManifest } from './media/manifest-loader';
import { mediaUrl } from './media/protocol-handler';
import { buildMarkdownExport, buildJsonExport } from './export';
import { interviewBriefSchema, preparedInterviewOutputSchema } from '@shared/schemas';

export interface AppControllerDeps {
  repository: CandidCueRepository;
  credentials: CredentialStore;
  logger: Logger;
  videosRoot: string;
  getControl: () => WebContents | null;
  getStage: () => WebContents | null;
  ensureStageWindow: (displayId: string | null) => WebContents;
}

interface ActiveSession {
  orchestrator: SessionOrchestrator;
  sessionId: string;
  characterId: string;
  inputDeviceId: string | null;
  stt: SpeechToTextAdapter;
  sttOffs: Unsubscribe[];
  lastSnapshot: OperatorSessionSnapshot | null;
  stagePort: IpcStagePort;
}

/** Central main-process coordinator. Renderers never reach providers or secrets. */
export class AppController {
  private active: ActiveSession | null = null;
  private prepareChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AppControllerDeps) {}

  // ---- Projects ---------------------------------------------------------
  listProjects(): Promise<ProjectSummary[]> {
    return this.deps.repository.listProjects();
  }
  getProject(id: string): Promise<ProjectAggregate | null> {
    return this.deps.repository.getProject(id);
  }
  saveProject(input: SaveProjectInput): Promise<ProjectAggregate> {
    return this.deps.repository.saveProject(input);
  }
  deleteProject(id: string): Promise<void> {
    return this.deps.repository.deleteProject(id);
  }

  async importDocument(): Promise<{ title: string; content: string; filename: string; mimeType: string } | null> {
    const res = await dialog.showOpenDialog({
      title: 'Import reference document',
      filters: [{ name: 'Text/Markdown', extensions: ['md', 'txt'] }],
      properties: ['openFile'],
    });
    const path = res.filePaths[0];
    if (res.canceled || !path) return null;
    const raw = await readFile(path, 'utf8');
    if (raw.length > PROJECT_LIMITS.maxSourceCharacters) {
      throw new AppError('VALIDATION_FAILED', { publicMessage: 'Document exceeds the size limit.' });
    }
    const ext = extname(path).toLowerCase();
    return {
      title: basename(path, ext),
      content: raw,
      filename: basename(path),
      mimeType: ext === '.md' ? 'text/markdown' : 'text/plain',
    };
  }

  // ---- Project preparation ---------------------------------------------
  async prepareProject(projectId: string): Promise<PreparationJobResult> {
    try {
      const aggregate = await this.deps.repository.getProject(projectId);
      if (!aggregate) throw new AppError('VALIDATION_FAILED', { publicMessage: 'Project not found.' });

      const model = this.requireModelAdapter();
      const compiled = compileProjectSource(
        aggregate.documents.map((d) => ({ id: d.id, kind: d.kind, title: d.title, content: d.content })),
      );
      const prepared = await model.prepareProject({
        compiledSource: compiled,
        targetQuestionCount: aggregate.project.targetValue,
        tone: aggregate.project.notesToInterviewer,
        exclusions: [],
        modelId: MODEL_DEFAULTS.projectPreparationModel,
      });
      const validated = preparedInterviewOutputSchema.parse(prepared);
      interviewBriefSchema.parse(validated.brief);

      const sourceHash = hashFromProjectDocuments(aggregate.documents);
      const latest = await this.deps.repository.getLatestPlan(projectId);
      const plan: InterviewPlan = {
        id: newId(),
        projectId,
        version: (latest?.version ?? 0) + 1,
        sourceHash,
        status: 'ready',
        brief: validated.brief,
        promptVersion: '1.0.0',
        createdAt: new Date().toISOString(),
      };
      await this.deps.repository.savePlan(plan);
      await this.deps.repository.setActivePlan(projectId, plan.id);
      return { ok: true, planId: plan.id, warnings: validated.warnings.map((w) => w.message), error: null };
    } catch (err) {
      return { ok: false, planId: null, warnings: [], error: this.toPublicError(err) };
    }
  }

  // ---- Settings ---------------------------------------------------------
  async getPublicSettings(): Promise<PublicSettings> {
    const keys = publicKeyState(this.deps.credentials);
    const voiceId =
      (await this.deps.repository.getSetting<string>('characters.mira.inworldVoiceId')) ??
      getInterviewerCharacter('mira')?.voice.voiceId ??
      '';
    return {
      hasOpenAiKey: keys.hasOpenAiKey,
      hasInworldKey: keys.hasInworldKey,
      endpointMode: (await this.deps.repository.getSetting<PublicSettings['endpointMode']>('endpoint.mode')) ?? 'conservative',
      captionsEnabled: (await this.deps.repository.getSetting<boolean>('stage.captions')) ?? false,
      explicitAudioOutputSelection: false,
      diagnosticsOverlay: false,
      ttsVoiceId: voiceId,
    };
  }

  saveProviders(input: ProviderCredentialInput): { ok: boolean } {
    if (input.openaiApiKey != null) this.deps.credentials.setKey('openai', input.openaiApiKey);
    if (input.inworldApiKey != null) this.deps.credentials.setKey('inworld', input.inworldApiKey);
    return { ok: true };
  }

  clearProvider(provider: 'openai' | 'inworld'): { ok: boolean } {
    this.deps.credentials.clearKey(provider);
    return { ok: true };
  }

  async testProvider(provider: 'openai' | 'inworld'): Promise<ProviderTestResult> {
    const start = Date.now();
    const key = this.deps.credentials.getKey(provider);
    if (!key) return { provider, ok: false, message: 'No credentials saved.', latencyMs: null };
    try {
      if (provider === 'openai') {
        const adapters = buildOpenAiAdapters(key);
        // A cheap structured call validates the key + model access.
        await adapters.moderation.moderate('hello');
      }
      // Inworld has no free health endpoint in the MVP; presence is treated as ok.
      return { provider, ok: true, message: 'Credentials look valid.', latencyMs: Date.now() - start };
    } catch (err) {
      return { provider, ok: false, message: this.toPublicError(err).publicMessage, latencyMs: Date.now() - start };
    }
  }

  // ---- Characters / devices --------------------------------------------
  listCharacters(): PublicCharacterSummary[] {
    return getInterviewerCharacters().map((c) => ({
      id: c.id,
      displayName: c.displayName,
      shortDescription: c.shortDescription,
      profileImageUrl: mediaUrl(c.profileImagePath),
    }));
  }

  async setSelectedDisplay(displayId: string): Promise<void> {
    await this.deps.repository.setSetting('display.selectedId', displayId);
  }

  // ---- Session lifecycle ------------------------------------------------
  async prepareSession(input: PrepareSessionInput): Promise<PreflightState> {
    // Serialize preflight runs so concurrent re-checks can't interleave and
    // clobber each other's active session (each run tears down the prior one).
    const run = this.prepareChain.then(
      () => this.runPrepareSession(input),
      () => this.runPrepareSession(input),
    );
    this.prepareChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runPrepareSession(input: PrepareSessionInput): Promise<PreflightState> {
    const checks: PreflightCheck[] = [];
    const add = (id: PreflightCheck['id'], label: string, required: boolean, ok: boolean, detail: string | null): void => {
      checks.push({ id, label, required, status: ok ? 'passed' : 'failed', detail });
    };

    const aggregate = await this.deps.repository.getProject(input.projectId);
    const plan = aggregate?.activePlan ?? (await this.deps.repository.getLatestPlan(input.projectId));

    const hasOpenAi = this.deps.credentials.hasKey('openai');
    const hasInworld = this.deps.credentials.hasKey('inworld');
    add('openai', 'OpenAI credentials', true, hasOpenAi, hasOpenAi ? null : 'Add your key in Settings.');
    add('inworld', 'Inworld credentials', true, hasInworld, hasInworld ? null : 'Add your key in Settings.');

    const planReady = plan != null && plan.status === 'ready' && plan.sourceHash === aggregate?.project.sourceHash;
    add('manifest', 'Interview plan', true, planReady, planReady ? null : 'Prepare (or regenerate) the interview plan.');

    let canBegin = false;
    if (aggregate && plan && hasOpenAi && hasInworld && planReady) {
      try {
        await this.startOrchestrator(aggregate, plan, input);
        canBegin = true;
        add('opening', 'Opening question cached', true, true, null);
      } catch (err) {
        // The session may have been partly started (STT connected) before the
        // failure — tear it down so we don't leak an open stream.
        await this.teardownActive();
        add('opening', 'Opening question cached', true, false, this.toPublicError(err).publicMessage);
      }
    } else {
      add('opening', 'Opening question cached', true, false, 'Resolve the checks above first.');
    }

    const state: PreflightState = {
      projectId: input.projectId,
      sessionId: this.active?.sessionId ?? null,
      checks,
      canBegin,
    };
    this.deps.getControl()?.send(CHANNELS.evtPreflight, state);
    return state;
  }

  private async startOrchestrator(
    aggregate: ProjectAggregate,
    plan: InterviewPlan,
    input: PrepareSessionInput,
  ): Promise<void> {
    // Close any prior active session's live resources before starting a new one
    // (re-running preflight must not leak an open STT stream).
    await this.teardownActive();
    const character = getInterviewerCharacter(aggregate.project.interviewerCharacterId) ?? getInterviewerCharacters()[0]!;
    const voiceId = (await this.deps.repository.getSetting<string>('characters.mira.inworldVoiceId')) ?? character.voice.voiceId;
    const clips = loadManifest(this.deps.videosRoot ? `${this.deps.videosRoot}/${character.mediaRootPath}` : character.mediaRootPath).clips;

    const coverage: SessionCoverageItem[] = plan.brief.coverageItems.map((c) => ({ ...c, followUpCount: 0 }));

    const session = await this.deps.repository.createSession({
      projectId: aggregate.project.id,
      planVersionId: plan.id,
      characterId: character.id,
      endpointMode: input.config.endpointMode,
      selectedInputDeviceId: input.config.selectedInputDeviceId,
      selectedOutputDeviceId: input.config.selectedOutputDeviceId,
      selectedDisplayId: input.config.selectedDisplayId,
      settingsSnapshot: {
        endpointMode: input.config.endpointMode,
        captionsEnabled: input.config.captionsEnabled,
        mirrorStage: input.config.mirrorStage,
        zoom: input.config.zoom,
        verticalOffsetPercent: input.config.verticalOffsetPercent,
        maxQuestionWords: RUNTIME_DEFAULTS.maxQuestionWords,
        maxQuestionAudioMs: RUNTIME_DEFAULTS.maxQuestionAudioMs,
        recentTurnCount: PROJECT_LIMITS.recentTurnCount,
        characterId: character.id,
        ttsVoiceId: voiceId,
      },
      coverage,
    });

    const openaiKey = this.deps.credentials.getKey('openai')!;
    const inworldKey = this.deps.credentials.getKey('inworld')!;
    const { model, moderation } = buildOpenAiAdapters(openaiKey);
    const { stt, tts } = buildInworldAdapters(inworldKey, INWORLD_DEFAULTS.sttModel);

    const stageContents = this.deps.ensureStageWindow(input.config.selectedDisplayId);
    const stagePort = new IpcStagePort(() => this.deps.getStage(), this.deps.logger);

    const snapshotSink: SnapshotSink = {
      publish: (snapshot) => {
        if (this.active) this.active.lastSnapshot = snapshot;
        this.deps.getControl()?.send(CHANNELS.evtSessionSnapshot, snapshot);
      },
    };

    const orchDeps: OrchestratorDeps = {
      repository: this.deps.repository,
      model: model as InterviewModelAdapter,
      moderation: moderation as ModerationAdapter,
      stt,
      tts: tts as TextToSpeechAdapter,
      stage: stagePort,
      snapshotSink,
      logger: this.deps.logger,
    };
    const ctx: SessionContext = {
      session,
      brief: plan.brief,
      character,
      composedSystemPrompt: composeCharacterSystemPrompt(character, GLOBAL_INTERVIEW_RULES),
      coverage,
      clips,
      models: {
        interviewer: MODEL_DEFAULTS.interviewerModel,
        cleanup: MODEL_DEFAULTS.cleanupModel,
        endpoint: MODEL_DEFAULTS.endpointModel,
        repair: MODEL_DEFAULTS.repairModel,
        stt: INWORLD_DEFAULTS.sttModel,
      },
      voiceId,
      ttsSampleRate: INWORLD_DEFAULTS.ttsSampleRate,
      captionsEnabled: input.config.captionsEnabled,
      selectedOutputDeviceId: input.config.selectedOutputDeviceId,
      targetQuestionCount: aggregate.project.targetValue,
    };

    const orchestrator = new SessionOrchestrator(orchDeps, ctx);
    this.active = {
      orchestrator,
      sessionId: session.id,
      characterId: character.id,
      inputDeviceId: input.config.selectedInputDeviceId,
      stt,
      sttOffs: [],
      lastSnapshot: null,
      stagePort,
    };

    // Open the live STT stream and subscribe its events to the orchestrator
    // (MIC-03/04). The streaming endpoint is a documented assumption, so a failed
    // connect only degrades provider health — manual commit still works via the
    // endTurn deadline fallback, so the session is not aborted.
    let sttConnected = false;
    try {
      await stt.connect({
        sampleRate: 16000,
        channels: 1,
        model: INWORLD_DEFAULTS.sttModel,
        interimResults: true,
      });
      sttConnected = true;
    } catch (err) {
      this.deps.logger.warn('stt.connect_failed', { error: String(err) });
    }
    this.active.sttOffs = bridgeSttToOrchestrator(stt, orchestrator, () => Date.now());
    orchestrator.setSttConnected(sttConnected);

    // Tell the stage to build its capture graph for this session (MIC-01/02).
    // Also re-sent from the stageBootstrap handler to cover a freshly-loaded
    // window whose listeners weren't ready when this first send went out.
    this.sendCaptureConfig();

    void stageContents; // window is created/shown; orchestrator drives it via stagePort
    await orchestrator.prepareOpening();
  }

  /**
   * Send the live {@link CaptureConfig} (real session id + selected input device)
   * to the stage so it constructs the microphone graph (MIC-01/02). No-op when
   * there is no active session or stage window.
   */
  sendCaptureConfig(): void {
    const a = this.active;
    const stage = this.deps.getStage();
    if (!a || !stage) return;
    const config: CaptureConfig = {
      sessionId: a.sessionId,
      inputDeviceId: a.inputDeviceId,
      sampleRate: 16000,
      channels: 1,
      preRollMs: RUNTIME_DEFAULTS.preRollMs,
      postSpeechMicGuardMs: RUNTIME_DEFAULTS.postSpeechMicGuardMs,
    };
    stage.send(CHANNELS.evtCaptureConfig, config);
  }

  /** Forward a live microphone meter reading from the stage into the snapshot (MIC-06). */
  reportStageMeter(reading: AudioMeterReading): void {
    this.active?.orchestrator.reportMeter(reading);
  }

  async command(cmd: SessionCommand): Promise<CommandResult> {
    const a = this.active;
    if (!a && cmd.type !== 'PREPARE_SESSION') {
      return { ok: false, state: null, error: new AppError('SESSION_STATE_CONFLICT', { publicMessage: 'No active session.' }).toPublic() };
    }
    try {
      const o = a!.orchestrator;
      switch (cmd.type) {
        case 'BEGIN_SESSION': await o.begin(); break;
        case 'COMMIT_USER_TURN': await o.commitUserTurn(cmd.reason); break;
        case 'PAUSE_SESSION': o.pause(); break;
        case 'RESUME_SESSION': await o.resume(); break;
        case 'REPEAT_QUESTION': await o.repeatQuestion(); break;
        case 'SKIP_QUESTION': await o.skipQuestion(); break;
        case 'END_AFTER_TURN': o.endAfterTurn(); break;
        case 'END_NOW': await o.endNow(); break;
        case 'RETRY_RECOVERY': await o.resume(); break;
        case 'PREPARE_SESSION': break;
      }
      return { ok: true, state: a!.orchestrator.getState(), error: null };
    } catch (err) {
      return { ok: false, state: a?.orchestrator.getState() ?? null, error: this.toPublicError(err) };
    }
  }

  getSnapshot(): OperatorSessionSnapshot | null {
    return this.active?.lastSnapshot ?? null;
  }

  // ---- Stage reports (from stage renderer) ------------------------------
  reportStagePlayback(kind: 'ready' | 'started' | 'ended' | 'error', turnId: string): void {
    this.active?.stagePort.handleReport(kind, turnId);
  }

  pcmSink = (packet: Parameters<SpeechToTextAdapter['writeAudio']>[0]): void => {
    try {
      this.active?.stt.writeAudio(packet);
    } catch {
      // The STT stream may be disconnected (the streaming endpoint is a
      // documented assumption). Drop live PCM rather than throwing from the
      // audio-port handler; endTurn's deadline fallback still yields a result.
    }
  };

  // ---- Stage bootstrap --------------------------------------------------
  buildStageBootstrap(): StageBootstrap {
    // Resolve the character for the ACTIVE session, not the first registered one,
    // so the stage shows the interviewer the operator actually chose (CORR-06).
    const character =
      (this.active ? getInterviewerCharacter(this.active.characterId) : null) ??
      getInterviewerCharacters()[0]!;
    const manifest = loadManifest(`${this.deps.videosRoot}/${character.mediaRootPath}`);
    const listeningClips = manifest.clips
      .filter((c) => c.mode === 'listening' && c.enabled)
      .map((c) => ({ clipId: c.id, url: mediaUrl(c.relativePath), durationMs: c.durationMs }));
    return {
      characterId: character.id,
      posterUrl: mediaUrl(character.posterPath),
      listeningClips,
      video: {
        fit: character.video.fit,
        mirror: character.video.mirrorByDefault,
        zoom: character.video.defaultZoom,
        verticalOffsetPercent: character.video.defaultVerticalOffsetPercent,
        transitionMs: 100,
      },
    };
  }

  // ---- Review / export --------------------------------------------------
  async review(sessionId: string): Promise<SessionReview | null> {
    const agg = await this.deps.repository.getSession(sessionId);
    if (!agg) return null;
    const project = await this.deps.repository.getProject(agg.session.projectId);
    return {
      sessionId,
      projectTitle: project?.project.title ?? 'Interview',
      startedAt: agg.session.startedAt,
      endedAt: agg.session.endedAt,
      turns: agg.turns
        .filter((t) => t.answer != null || t.state === 'answered')
        .map((t) => ({
          id: t.id,
          ordinal: t.ordinal,
          question: t.question.text,
          rawTranscript: t.answer?.rawTranscript ?? null,
          cleanedTranscript: t.answer?.cleanedTranscript ?? null,
          userEditedTranscript: t.answer?.userEditedTranscript ?? null,
          endpointReason: t.answer?.endpointReason ?? null,
          incomplete: t.state !== 'answered' || t.answer?.endpointReason === 'recovery',
        })),
      coverage: agg.coverage.map((c) => ({ id: c.id, label: c.label, priority: c.priority, status: c.status })),
    };
  }

  editTranscript(turnId: string, text: string): Promise<void> {
    return this.deps.repository.updateUserEditedTranscript(turnId, text);
  }

  /**
   * Export at the project level. The IPC layer only has a project id here, so we
   * resolve the project's most recent session (preferring a completed one) and
   * delegate to {@link exportSession}. Previously the project id was passed
   * straight into the session lookup, so this path always failed (CORR-05).
   */
  async exportProject(projectId: string, format: 'markdown' | 'json'): Promise<ExportResult> {
    try {
      // listSessions returns newest-first, so this prefers the latest completed
      // session, otherwise the most recent session of any status.
      const sessions = await this.deps.repository.listSessions(projectId);
      const target = sessions.find((s) => s.status === 'completed') ?? sessions[0];
      if (!target) {
        return {
          ok: false,
          path: null,
          bytesWritten: null,
          error: new AppError('EXPORT_FAILED', {
            publicMessage: 'This project has no interview sessions to export yet.',
          }).toPublic(),
        };
      }
      return await this.exportSession(target.id, format);
    } catch (err) {
      return { ok: false, path: null, bytesWritten: null, error: this.toPublicError(err) };
    }
  }

  async exportSession(sessionId: string, format: 'markdown' | 'json'): Promise<ExportResult> {
    try {
      const agg = await this.deps.repository.getSession(sessionId);
      if (!agg) throw new AppError('EXPORT_FAILED', { publicMessage: 'Session not found.' });
      const project = await this.deps.repository.getProject(agg.session.projectId);
      const plan = await this.deps.repository.getPlan(agg.session.planVersionId);
      if (!plan) throw new AppError('EXPORT_FAILED', { publicMessage: 'Plan not found.' });

      const exportInput = {
        projectTitle: project?.project.title ?? 'Interview',
        sourceHash: project?.project.sourceHash ?? '',
        brief: plan.brief,
        session: {
          id: agg.session.id,
          characterId: agg.session.characterId,
          startedAt: agg.session.startedAt,
          endedAt: agg.session.endedAt,
          endpointMode: agg.session.endpointMode,
          rollingSummary: agg.session.rollingSummary,
        },
        turns: agg.turns.map((t) => ({
          ordinal: t.ordinal,
          question: {
            text: t.question.text,
            type: t.question.type,
            targetCoverageItemIds: t.question.targetCoverageItemIds,
            source: t.question.source,
          },
          answer: t.answer
            ? {
                rawTranscript: t.answer.rawTranscript,
                cleanedTranscript: t.answer.cleanedTranscript,
                userEditedTranscript: t.answer.userEditedTranscript,
                endpointReason: t.answer.endpointReason,
              }
            : null,
          coverageDelta: t.coverageDelta,
        })),
        coverage: agg.coverage.map((c) => ({ label: c.label, status: c.status })),
        durationLabel: '—',
        date: new Date().toISOString().slice(0, 10),
      };

      const content = format === 'markdown' ? buildMarkdownExport(exportInput) : JSON.stringify(buildJsonExport(exportInput), null, 2);
      const res = await dialog.showSaveDialog({
        title: 'Export interview',
        defaultPath: `interview-${sessionId.slice(0, 8)}.${format === 'markdown' ? 'md' : 'json'}`,
      });
      if (res.canceled || !res.filePath) return { ok: false, path: null, bytesWritten: null, error: null };
      await writeFile(res.filePath, content, 'utf8');
      return { ok: true, path: res.filePath, bytesWritten: Buffer.byteLength(content), error: null };
    } catch (err) {
      return { ok: false, path: null, bytesWritten: null, error: this.toPublicError(err) };
    }
  }

  /**
   * Release live resources when the app is quitting (BOOT-04): close any active
   * STT stream so its provider socket is torn down. Best-effort — quit proceeds
   * regardless. Repository closing is handled by the bootstrap teardown.
   */
  async shutdown(): Promise<void> {
    await this.teardownActive();
  }

  /**
   * Tear down the current active session's live resources (STT subscriptions,
   * endpoint timer, STT stream) and clear it. Used on quit and before replacing
   * the active session, so a failed or repeated preflight can't leak an open STT
   * stream.
   */
  private async teardownActive(): Promise<void> {
    const a = this.active;
    this.active = null;
    if (!a) return;
    for (const off of a.sttOffs) {
      try {
        off();
      } catch {
        /* best-effort detach */
      }
    }
    a.orchestrator.dispose();
    try {
      await a.stt.close();
    } catch (err) {
      this.deps.logger.warn('app.teardown_stt_failed', { message: String(err) });
    }
  }

  async resumable(): Promise<Array<{ sessionId: string; projectTitle: string; startedAt: string | null }>> {
    const sessions = await this.deps.repository.findResumableSessions();
    const out: Array<{ sessionId: string; projectTitle: string; startedAt: string | null }> = [];
    for (const s of sessions) {
      const p = await this.deps.repository.getProject(s.projectId);
      out.push({ sessionId: s.id, projectTitle: p?.project.title ?? 'Interview', startedAt: s.startedAt });
    }
    return out;
  }

  // ---- helpers ----------------------------------------------------------
  private requireModelAdapter(): InterviewModelAdapter {
    const key = this.deps.credentials.getKey('openai');
    if (!key) throw new AppError('OPENAI_AUTH', { publicMessage: 'Add your OpenAI key in Settings.' });
    return buildOpenAiAdapters(key).model as InterviewModelAdapter;
  }

  private toPublicError(err: unknown): ReturnType<AppError['toPublic']> {
    if (isAppError(err)) return err.toPublic();
    this.deps.logger.error('app.error', { message: String(err) });
    return new AppError('UNKNOWN', { cause: err }).toPublic();
  }
}

/**
 * StagePort backed by IPC to the stage renderer. Correlates playback reports
 * (ready/ended/error) to the orchestrator's awaits, with deadline fallbacks so a
 * missing or slow stage never deadlocks the turn pipeline.
 */
class IpcStagePort implements StagePort {
  private pendingReady = new Map<string, (ok: boolean) => void>();
  private pendingEnded = new Map<string, (ok: boolean) => void>();

  constructor(private readonly getStage: () => WebContents | null, private readonly logger: Logger) {}

  openMicGate(): void {
    /* The stage derives mic state from the StageStateProjection it receives. */
  }
  closeMicGate(): void {
    /* No-op: mic state follows the published runtime state. */
  }

  setVisualState(projection: StageStateProjection): void {
    this.getStage()?.send(CHANNELS.evtStageState, projection);
  }

  async preloadSpeechPlan(plan: SpeechPlaybackPlan): Promise<void> {
    this.getStage()?.send(CHANNELS.evtPlaybackPlan, plan);
    await this.await('ready', plan.turnId, RUNTIME_DEFAULTS.stagePreloadDeadlineMs);
  }

  async playSpeechPlan(plan: SpeechPlaybackPlan): Promise<void> {
    // Audio end is authoritative; fall back after the known duration + slack.
    await this.await('ended', plan.turnId, plan.audio.durationMs + 2000);
  }

  handleReport(kind: 'ready' | 'started' | 'ended' | 'error', turnId: string): void {
    if (kind === 'ready') this.pendingReady.get(turnId)?.(true);
    if (kind === 'ended') this.pendingEnded.get(turnId)?.(true);
    if (kind === 'error') {
      this.logger.warn('stage.playback_error', { turnId });
      this.pendingReady.get(turnId)?.(false);
      this.pendingEnded.get(turnId)?.(false);
    }
  }

  private await(kind: 'ready' | 'ended', turnId: string, deadlineMs: number): Promise<void> {
    const map = kind === 'ready' ? this.pendingReady : this.pendingEnded;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        map.delete(turnId);
        resolve();
      };
      const timer = setTimeout(done, deadlineMs);
      map.set(turnId, () => done());
    });
  }
}
