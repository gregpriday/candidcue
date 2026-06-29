import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AppController } from '@main/app-controller';
import { NOOP_LOGGER } from '@main/interview/ports';
import { compileProjectSource } from '@main/interview/source-compiler';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';
import { AppError } from '@shared/errors/app-error';

// The preparation model adapter is built from the OpenAI credential inside the
// controller (via the provider factory). Stub the factory so `model.prepareProject`
// is a shared spy delegating to the deterministic FakeInterviewModel — schema-valid
// output, no network — which lets the at-limit success path complete and lets each
// test assert exactly whether the model was reached.
const { prepareProjectSpy } = vi.hoisted(() => ({ prepareProjectSpy: vi.fn() }));

vi.mock('@main/providers/factory', async () => {
  const { FakeInterviewModel } = await import('@main/providers/fakes');
  const fake = new FakeInterviewModel();
  prepareProjectSpy.mockImplementation((input: never, signal?: never) =>
    fake.prepareProject(input, signal),
  );
  return {
    buildOpenAiAdapters: () => ({ model: { prepareProject: prepareProjectSpy }, moderation: {} }),
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
}

function build(opts: BuildOptions) {
  const savePlan = vi.fn(async () => {});
  const setActivePlan = vi.fn(async () => {});
  const updateProjectSourceHash = vi.fn(async () => {});

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
      getLatestPlan: async () => null,
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
    getControl: () => null,
    getStage: () => null,
    ensureStageWindow: () => {
      throw new Error('stage window must not be opened during preparation');
    },
    isDisplayConnected: () => true,
  });

  return { controller, savePlan, setActivePlan, updateProjectSourceHash };
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
