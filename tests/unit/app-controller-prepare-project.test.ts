import { describe, it, expect, vi } from 'vitest';

import { AppController } from '@main/app-controller';
import { NOOP_LOGGER } from '@main/interview/ports';
import { compileProjectSource } from '@main/interview/source-compiler';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';

// The preparation model adapter is built from the OpenAI credential inside the
// controller (via the provider factory). Stub the factory so it returns the
// deterministic FakeInterviewModel — schema-valid output, no network — which
// lets the at-limit success path complete without hitting OpenAI.
vi.mock('@main/providers/factory', async () => {
  const { FakeInterviewModel } = await import('@main/providers/fakes');
  return {
    buildOpenAiAdapters: () => ({ model: new FakeInterviewModel(), moderation: {} }),
    buildInworldAdapters: () => ({}),
  };
});

const DOC_ID = 'doc-1';
const DOC_TITLE = 'Doc';

// The compiled envelope wraps content in `<DOCUMENT>` tags plus a `N| ` line
// prefix, so a document's content is shorter than the compiled string. Measure
// that fixed overhead (for this id/title) once so a test can build content that
// lands the *compiled* length on an exact byte.
const ENVELOPE_OVERHEAD = compileProjectSource([
  { id: DOC_ID, title: DOC_TITLE, content: '' },
]).length;

/** Content whose compiled envelope is exactly `compiledLength` characters. */
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
    // The guard fires before the model call, so no plan is ever persisted.
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
    // All sources blank: this must surface VALIDATION_FAILED (the preparable-sources
    // gate), never SOURCE_TOO_LARGE, since the gate runs before compilation.
    const { controller, savePlan } = build({
      documents: [{ id: DOC_ID, title: DOC_TITLE, content: '   ' }],
    });

    const result = await controller.prepareProject('project-1');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(savePlan).not.toHaveBeenCalled();
  });
});
