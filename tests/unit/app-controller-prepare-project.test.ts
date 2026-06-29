import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AppController } from '@main/app-controller';
import { NOOP_LOGGER } from '@main/interview/ports';
import { compileProjectSource } from '@main/interview/source-compiler';
import { CHANNELS, type PrepareProgress } from '@shared/contracts';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';
import { AppError } from '@shared/errors/app-error';

// The preparation model adapter is resolved inside the controller via the
// provider factory: `requireModelAdapter` reads the OpenAI credential with
// `getProviderCredential` and then builds the adapter set with `buildAdapters`,
// using its `.model`. Stub the factory so that model's `prepareProject` is a
// shared spy delegating to the deterministic FakeInterviewModel — schema-valid
// output, no network — which lets the at-limit success path complete and lets
// each test assert exactly whether the model was reached. The credential/fake-mode
// helpers are stubbed to their real non-fake behaviour (no fake provider mode;
// the credential comes straight from the injected store) so the controller's real
// resolution flow runs end to end.
const { prepareProjectSpy } = vi.hoisted(() => ({ prepareProjectSpy: vi.fn() }));

vi.mock('@main/providers/factory', async () => {
  const { FakeInterviewModel } = await import('@main/providers/fakes');
  const fake = new FakeInterviewModel();
  prepareProjectSpy.mockImplementation((input: never, signal?: never, onProgress?: never) =>
    fake.prepareProject(input, signal, onProgress),
  );
  const model = { prepareProject: prepareProjectSpy };
  return {
    useFakeProviders: () => false,
    getProviderCredential: (
      provider: 'openai' | 'inworld',
      store: { getKey: (p: 'openai' | 'inworld') => string | null },
    ) => store.getKey(provider),
    hasProviderCredential: (
      provider: 'openai' | 'inworld',
      store: { hasKey: (p: 'openai' | 'inworld') => boolean },
    ) => store.hasKey(provider),
    buildAdapters: () => ({ model, moderation: {}, stt: {}, tts: {} }),
    buildOpenAiAdapters: () => ({ model, moderation: {} }),
    buildInworldAdapters: () => ({}),
  };
});

const DOC_ID = 'doc-1';
const DOC_TITLE = 'Doc';

// The compiled envelope wraps content in `<DOCUMENT>` tags plus a `N| ` line
// prefix, so a document's content is shorter than the compiled string. Measure
// that fixed overhead (for one document with this id/title) once so a test can
// build content that lands the *compiled* length on an exact character count.
const ENVELOPE_OVERHEAD = compileProjectSource([
  { id: DOC_ID, title: DOC_TITLE, content: '' },
]).length;

// Same, for a two-document envelope (each with this id/title), to size a
// multi-document compiled string to an exact length.
const ENVELOPE_OVERHEAD_2 = compileProjectSource([
  { id: 'd1', title: DOC_TITLE, content: '' },
  { id: 'd2', title: DOC_TITLE, content: '' },
]).length;

/** Single-document content whose compiled envelope is exactly `compiledLength`. */
function contentForCompiledLength(compiledLength: number): string {
  return 'a'.repeat(compiledLength - ENVELOPE_OVERHEAD);
}

interface BuildOptions {
  documents: Array<{ id?: string; title?: string; content: string; sortOrder?: number }>;
  /** Override the repository's getLatestPlan (e.g. to defer it for a cancel race). */
  getLatestPlan?: () => Promise<null>;
}

function build(opts: BuildOptions) {
  const savePlan = vi.fn(async () => {});
  const setActivePlan = vi.fn(async () => {});
  const updateProjectSourceHash = vi.fn(async () => {});
  // Stand-in for the control WebContents so prepare-progress emissions are captured.
  const send = vi.fn();

  const documents = opts.documents.map((d, i) => ({
    id: d.id ?? `doc-${i + 1}`,
    projectId: 'project-1',
    title: d.title ?? DOC_TITLE,
    originalFilename: null,
    mimeType: 'text/markdown',
    content: d.content,
    sortOrder: d.sortOrder ?? i,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));

  const aggregate = {
    project: {
      id: 'project-1',
      title: 'Project',
      audience: 'general listeners',
      intendedOutcome: 'a clear account',
      targetMode: 'question_count',
      targetValue: 5,
      interviewerCharacterId: 'mira',
      notesToInterviewer: null,
    },
    documents,
    activePlan: null,
  };

  const controller = new AppController({
    repository: {
      getProject: async () => aggregate,
      getLatestPlan: opts.getLatestPlan ?? (async () => null),
      savePlan,
      setActivePlan,
      updateProjectSourceHash,
    } as never,
    credentials: {
      hasKey: () => true,
      getKey: () => 'sk-test',
    } as never,
    logger: NOOP_LOGGER,
    videosRoot: '',
    getControl: () => ({ send }) as never,
    getStage: () => null,
    ensureStageWindow: () => {
      throw new Error('stage window must not be opened during preparation');
    },
    isDisplayConnected: () => true,
  });

  return { controller, savePlan, setActivePlan, updateProjectSourceHash, send };
}

/**
 * Ordered list of prepare-progress phases emitted to the (fake) control window,
 * with consecutive duplicates collapsed. The streaming producer emits several
 * `generating` events (the initial 0, then throttled character counts), so the
 * phase *transitions* — not the raw event count — are what these tests assert.
 */
function emittedPhases(send: ReturnType<typeof vi.fn>): string[] {
  const phases = send.mock.calls
    .filter((call) => call[0] === CHANNELS.evtPrepareProgress)
    .map((call) => (call[1] as { phase: string }).phase);
  return phases.filter((phase, index) => phase !== phases[index - 1]);
}

describe('AppController.prepareProject compiled-source budget', () => {
  const cap = PROJECT_SOURCE_LIMITS.maxCompiledSourceCharacters;

  beforeEach(() => {
    prepareProjectSpy.mockClear();
  });

  it('builds content that lands the compiled envelope on an exact length (helper self-check)', () => {
    // Guards the boundary tests: if compileProjectSource's format drifts, the
    // exact-length assumption breaks here rather than silently shifting the cap.
    expect(compileProjectSource([
      { id: DOC_ID, title: DOC_TITLE, content: contentForCompiledLength(cap) },
    ]).length).toBe(cap);
  });

  it('rejects a compiled source one character over the budget with SOURCE_TOO_LARGE', async () => {
    const { controller, savePlan } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: contentForCompiledLength(cap + 1) }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(false);
    expect(result.planId).toBeNull();
    expect(result.error?.code).toBe('SOURCE_TOO_LARGE');
    // A capacity constraint, not invalid input: the user must change data to recover.
    expect(result.error?.recoverable).toBe(false);
    // The public message is the fixed, UI-safe default and must not echo source
    // content (the document body is a long run of 'a' characters).
    expect(result.error?.publicMessage).not.toContain('a'.repeat(50));
    expect(result.error?.publicMessage).toMatch(/too large to prepare/i);
    // The guard fires BEFORE the model call: the planner is never invoked and
    // no plan is persisted.
    expect(prepareProjectSpy).not.toHaveBeenCalled();
    expect(savePlan).not.toHaveBeenCalled();
  });

  it('budgets the total compiled envelope, not each document (combined sources over the cap)', async () => {
    // Two documents, each well under the cap, whose combined compiled envelope is
    // cap + 1. A per-document guard would let this through; the real guard rejects.
    const totalContent = cap + 1 - ENVELOPE_OVERHEAD_2;
    const half = Math.floor(totalContent / 2);
    const { controller, savePlan } = build({
      documents: [
        { id: 'd1', title: DOC_TITLE, content: 'a'.repeat(half) },
        { id: 'd2', title: DOC_TITLE, content: 'a'.repeat(totalContent - half) },
      ],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SOURCE_TOO_LARGE');
    expect(prepareProjectSpy).not.toHaveBeenCalled();
    expect(savePlan).not.toHaveBeenCalled();
  });

  it('allows a compiled source exactly at the budget and prepares normally', async () => {
    const { controller, savePlan, setActivePlan } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: contentForCompiledLength(cap) }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.planId).not.toBeNull();
    expect(prepareProjectSpy).toHaveBeenCalledTimes(1);
    expect(savePlan).toHaveBeenCalledTimes(1);
    expect(setActivePlan).toHaveBeenCalledTimes(1);
  });

  it('does not budget-reject a normal-sized source', async () => {
    const { controller, savePlan } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: 'A short interview source.' }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(true);
    expect(savePlan).toHaveBeenCalledTimes(1);
  });

  it('runs the empty-content validation gate before the budget check', async () => {
    // Whitespace-only content that is ALSO over the budget: the preparable-sources
    // gate runs before compilation, so this must surface VALIDATION_FAILED — proving
    // ordering. (A budget-first implementation would wrongly return SOURCE_TOO_LARGE.)
    const { controller, savePlan } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: ' '.repeat(contentForCompiledLength(cap + 1).length) }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(prepareProjectSpy).not.toHaveBeenCalled();
    expect(savePlan).not.toHaveBeenCalled();
  });

  it('surfaces a model error after the guard passes without persisting a plan', async () => {
    prepareProjectSpy.mockRejectedValueOnce(new AppError('OPENAI_TIMEOUT'));
    const { controller, savePlan, setActivePlan, updateProjectSourceHash } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: 'A short interview source.' }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('OPENAI_TIMEOUT');
    expect(savePlan).not.toHaveBeenCalled();
    expect(setActivePlan).not.toHaveBeenCalled();
    expect(updateProjectSourceHash).not.toHaveBeenCalled();
  });
});

describe('AppController.prepareProject staged progress (issue #48)', () => {
  beforeEach(() => {
    prepareProjectSpy.mockClear();
  });

  it('emits reading → generating → validating → saving → done on the happy path', async () => {
    const { controller, send } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: 'A short interview source.' }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(true);
    expect(emittedPhases(send)).toEqual(['reading', 'generating', 'validating', 'saving', 'done']);
    // Every emission is tagged with the project id so the renderer can filter.
    const payloads = send.mock.calls
      .filter((c) => c[0] === CHANNELS.evtPrepareProgress)
      .map((c) => c[1] as { projectId: string });
    expect(payloads).not.toHaveLength(0);
    expect(payloads.every((p) => p.projectId === 'project-1')).toBe(true);
  });

  it('streams a positive generating character count as output is produced (issue #47)', async () => {
    const { controller, send } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: 'A short interview source.' }],
    });

    const result = await controller.prepareProject('project-1');
    expect(result.ok).toBe(true);

    const progress = send.mock.calls
      .filter((c) => c[0] === CHANNELS.evtPrepareProgress)
      .map((c) => c[1] as PrepareProgress);
    // The streaming responder reports incremental deltas, so at least one
    // `generating` event carries a positive char count (not just the initial 0).
    // This is the streaming producer filling the renderer's character readout —
    // the piece main's progress UI already displays but its producer never fed.
    expect(
      progress.some((p) => p.phase === 'generating' && (p.charsGenerated ?? 0) > 0),
    ).toBe(true);
    // Every event is scoped to the project being prepared.
    expect(progress.every((p) => p.projectId === 'project-1')).toBe(true);
  });

  it('emits reading → failed when the source gate rejects, before reaching the model', async () => {
    const { controller, send } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: '   ' }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(emittedPhases(send)).toEqual(['reading', 'failed']);
    expect(prepareProjectSpy).not.toHaveBeenCalled();
  });

  it('emits reading → generating → failed when the model rejects', async () => {
    prepareProjectSpy.mockRejectedValueOnce(new AppError('OPENAI_TIMEOUT'));
    const { controller, send } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: 'A short interview source.' }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(false);
    expect(emittedPhases(send)).toEqual(['reading', 'generating', 'failed']);
  });

  it('maps a cancelled prepare to PREPARE_CANCELLED and persists no plan', async () => {
    const { controller, savePlan, setActivePlan } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: 'A short interview source.' }],
    });

    // The aborter is registered synchronously, so cancelling immediately after
    // starting aborts the run before the model resolves.
    const promise = controller.prepareProject('project-1');
    controller.cancelPrepare('project-1');
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PREPARE_CANCELLED');
    expect(result.planId).toBeNull();
    expect(savePlan).not.toHaveBeenCalled();
    expect(setActivePlan).not.toHaveBeenCalled();
  });

  it('persists no plan when cancelled after the model resolves, during the save phase', async () => {
    // Block getLatestPlan so the run pauses after the model returns (signal still
    // unaborted) but before any write — a deterministic window to cancel mid-save.
    let releaseLatest: () => void = () => {};
    let enteredLatest: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredLatest = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseLatest = resolve;
    });
    const { controller, savePlan, setActivePlan } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: 'A short interview source.' }],
      getLatestPlan: async () => {
        enteredLatest();
        await gate;
        return null;
      },
    });

    const promise = controller.prepareProject('project-1');
    await entered; // model resolved; now parked in getLatestPlan with no abort yet
    controller.cancelPrepare('project-1');
    releaseLatest();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PREPARE_CANCELLED');
    expect(savePlan).not.toHaveBeenCalled();
    expect(setActivePlan).not.toHaveBeenCalled();
  });

  it('cancelPrepare for an unknown project is a no-op', () => {
    const { controller } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: 'A short interview source.' }],
    });

    expect(() => controller.cancelPrepare('does-not-exist')).not.toThrow();
  });
});
