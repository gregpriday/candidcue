import { describe, it, expect } from 'vitest';

import { AppController, type AppControllerDeps } from '@main/app-controller';
import { MemoryRepository } from '@main/persistence/memory-repository';
import { FakeInterviewModel } from '@main/providers/fakes';
import { NOOP_LOGGER } from '@main/interview/ports';
import type { CredentialStore } from '@main/security/secrets';
import type { PrepareProjectInput } from '@shared/contracts/adapters';
import type { PreparedInterviewOutput } from '@shared/domain';
import { DEFAULT_INTERVIEW_TITLE, type SaveProjectInput } from '@shared/domain';

/**
 * Records the {@link PrepareProjectInput} the controller hands the model, then
 * delegates to the real fake so the controller's downstream schema validation
 * and plan persistence still run.
 */
class RecordingInterviewModel extends FakeInterviewModel {
  lastPrepareInput: PrepareProjectInput | null = null;
  lastSignal: AbortSignal | undefined = undefined;
  /** Resolves the moment `prepareProject` is entered, so a test can cancel mid-flight. */
  private startedResolve: (() => void) | null = null;
  readonly started: Promise<void> = new Promise((resolve) => {
    this.startedResolve = resolve;
  });

  override async prepareProject(
    input: PrepareProjectInput,
    signal?: AbortSignal,
    onProgress?: (charsGenerated: number) => void,
  ): Promise<PreparedInterviewOutput> {
    this.lastPrepareInput = input;
    this.lastSignal = signal;
    this.startedResolve?.();
    return super.prepareProject(input, signal, onProgress);
  }
}

function makeController(model: RecordingInterviewModel): { controller: AppController; repo: MemoryRepository } {
  const repo = new MemoryRepository();
  const deps: AppControllerDeps = {
    repository: repo,
    credentials: { getKey: () => 'sk-test' } as unknown as CredentialStore,
    logger: NOOP_LOGGER,
    videosRoot: '',
    getControl: () => null,
    getStage: () => null,
    ensureStageWindow: () => {
      throw new Error('stage window is not used by prepareProject');
    },
    isDisplayConnected: () => true,
    buildModelAdapter: () => model,
  };
  return { controller: new AppController(deps), repo };
}

function projectInput(overrides: Partial<SaveProjectInput> = {}): SaveProjectInput {
  return {
    title: 'Shipping CandidCue',
    audience: 'indie founders',
    intendedOutcome: 'a candid build story',
    targetMode: 'question_count',
    targetValue: 8,
    interviewerCharacterId: 'mira',
    notesToInterviewer: 'Keep it warm; avoid pricing.',
    documents: [
      {
        title: 'Brief',
        mimeType: 'text/markdown',
        content: '# The story\nWe started in a garage.',
        sortOrder: 0,
      },
    ],
    ...overrides,
  };
}

describe('AppController.prepareProject input wiring (issue #63)', () => {
  it('passes the founder-supplied title, audience, and outcome to the model', async () => {
    const model = new RecordingInterviewModel();
    const { controller, repo } = makeController(model);
    const saved = await repo.saveProject(projectInput());

    const result = await controller.prepareProject(saved.project.id);

    expect(result.ok).toBe(true);
    expect(model.lastPrepareInput).not.toBeNull();
    expect(model.lastPrepareInput?.title).toBe('Shipping CandidCue');
    expect(model.lastPrepareInput?.audience).toBe('indie founders');
    expect(model.lastPrepareInput?.intendedOutcome).toBe('a candid build story');
    // Tone still rides on the notes field; exclusions remain model-derived.
    expect(model.lastPrepareInput?.tone).toBe('Keep it warm; avoid pricing.');

    // The saved plan is stamped with the current preparation prompt version so
    // the preflight readiness gate treats it as fresh (issue #64).
    const aggregate = await repo.getProject(saved.project.id);
    expect(aggregate?.activePlan?.promptVersion).toBe('1.1.0');
  });

  it('maps the editor placeholder title to null so the planner infers one', async () => {
    const model = new RecordingInterviewModel();
    const { controller, repo } = makeController(model);
    const saved = await repo.saveProject(projectInput({ title: DEFAULT_INTERVIEW_TITLE }));

    const result = await controller.prepareProject(saved.project.id);

    expect(result.ok).toBe(true);
    expect(model.lastPrepareInput?.title).toBeNull();
  });

  it('forwards null audience and outcome untouched when the founder left them blank', async () => {
    const model = new RecordingInterviewModel();
    const { controller, repo } = makeController(model);
    const saved = await repo.saveProject(
      projectInput({ audience: null, intendedOutcome: null }),
    );

    const result = await controller.prepareProject(saved.project.id);

    expect(result.ok).toBe(true);
    expect(model.lastPrepareInput?.audience).toBeNull();
    expect(model.lastPrepareInput?.intendedOutcome).toBeNull();
  });
});

describe('AppController.prepareProject cancellation (issue #48)', () => {
  it('hands the model an AbortSignal so the run can be cancelled', async () => {
    const model = new RecordingInterviewModel();
    const { controller, repo } = makeController(model);
    const saved = await repo.saveProject(projectInput());

    const result = await controller.prepareProject(saved.project.id);

    expect(result.ok).toBe(true);
    expect(model.lastSignal).toBeInstanceOf(AbortSignal);
    // A normal completion never aborts the signal.
    expect(model.lastSignal?.aborted).toBe(false);
  });

  it('cancelling an in-flight prepare aborts the model and persists no plan', async () => {
    // A long delay keeps the model call hanging so the cancel lands mid-flight.
    const model = new RecordingInterviewModel({ delayMs: 1000 });
    const { controller, repo } = makeController(model);
    const saved = await repo.saveProject(projectInput());

    const promise = controller.prepareProject(saved.project.id);
    await model.started;
    controller.cancelPrepare(saved.project.id);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PREPARE_CANCELLED');
    expect(result.planId).toBeNull();
    expect(model.lastSignal?.aborted).toBe(true);
    // No plan was persisted for the cancelled run.
    expect(await repo.getLatestPlan(saved.project.id)).toBeNull();
  });
});
