import {
  buildMarkdownExport,
  buildJsonExport,
  resolveAnswerText,
  isIncompleteTurn,
  PORTABLE_EXPORT_SCHEMA_VERSION,
  INTERVIEWER_DISPLAY_NAME,
} from '@main/export';
import type { SessionExportInput } from '@main/export';
import type { InterviewBrief } from '@shared/domain';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal but valid brief; the exporters treat it as an opaque plan payload. */
function makeBrief(): InterviewBrief {
  return {
    title: 'The Plan Title',
    oneSentencePremise: 'A premise.',
    audience: 'Everyone',
    intendedOutcome: 'An outcome.',
    recommendedTone: 'warm',
    factualAnchors: [],
    terminology: [],
    coverageItems: [],
    arc: [],
    exclusions: [],
    openingQuestion: {
      text: 'Opening?',
      type: 'opening',
      targetCoverageItemIds: [],
      useWhen: 'start',
    },
    fallbackQuestions: [],
    closingStrategy: 'wrap up',
  };
}

type Turn = SessionExportInput['turns'][number];

function makeAnswer(
  overrides: Partial<NonNullable<Turn['answer']>> = {},
): NonNullable<Turn['answer']> {
  return {
    rawTranscript: 'raw text',
    cleanedTranscript: 'cleaned text',
    userEditedTranscript: null,
    endpointReason: 'automatic',
    ...overrides,
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    ordinal: 1,
    question: {
      text: 'What is your name?',
      type: 'context',
      targetCoverageItemIds: ['cov-1'],
      source: 'model',
    },
    answer: makeAnswer(),
    coverageDelta: [
      {
        coverageItemId: 'cov-1',
        fromStatus: 'not_started',
        toStatus: 'covered',
        evidenceTurnIds: ['turn-1'],
      },
    ],
    ...overrides,
  };
}

function makeInput(overrides: Partial<SessionExportInput> = {}): SessionExportInput {
  return {
    projectTitle: 'My Interview Project',
    sourceHash: 'sha256:abcdef',
    brief: makeBrief(),
    session: {
      id: 'sess-1',
      characterId: 'mira',
      startedAt: '2026-06-23T10:00:00.000Z',
      endedAt: '2026-06-23T10:12:30.000Z',
      endpointMode: 'balanced',
      rollingSummary: 'They talked about things.',
    },
    turns: [makeTurn()],
    coverage: [{ label: 'Background', status: 'covered' }],
    durationLabel: '12m 30s',
    date: '2026-06-23',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveAnswerText / isIncompleteTurn helpers
// ---------------------------------------------------------------------------

describe('resolveAnswerText', () => {
  it('prefers the user-edited transcript above all', () => {
    const turn = makeTurn({
      answer: makeAnswer({
        userEditedTranscript: 'edited',
        cleanedTranscript: 'cleaned',
        rawTranscript: 'raw',
      }),
    });
    expect(resolveAnswerText(turn)).toBe('edited');
  });

  it('falls back to the cleaned transcript when there is no edit', () => {
    const turn = makeTurn({
      answer: makeAnswer({
        userEditedTranscript: null,
        cleanedTranscript: 'cleaned',
        rawTranscript: 'raw',
      }),
    });
    expect(resolveAnswerText(turn)).toBe('cleaned');
  });

  it('falls back to the raw transcript only when cleaned is null (??-semantics, not falsy)', () => {
    // The documented precedence uses `??`, so a present-but-empty cleaned
    // transcript is a real value and is NOT skipped over to raw.
    const emptyCleaned = makeTurn({
      answer: makeAnswer({
        userEditedTranscript: null,
        cleanedTranscript: '',
        rawTranscript: 'raw only',
      }),
    });
    expect(resolveAnswerText(emptyCleaned)).toBe('');

    // cleanedTranscript is typed non-nullable, but transcripts can in practice
    // be absent; verify raw is used when cleaned is nullish.
    const nullishCleaned = makeTurn({
      answer: makeAnswer({
        userEditedTranscript: null,
        cleanedTranscript: null as unknown as string,
        rawTranscript: 'raw only',
      }),
    });
    expect(resolveAnswerText(nullishCleaned)).toBe('raw only');
  });

  it('returns the placeholder when there is no answer', () => {
    const turn = makeTurn({ answer: null });
    expect(resolveAnswerText(turn)).toBe('(no answer)');
  });
});

describe('isIncompleteTurn', () => {
  it('flags turns with no answer', () => {
    expect(isIncompleteTurn(makeTurn({ answer: null }))).toBe(true);
  });

  it('flags recovered turns', () => {
    expect(
      isIncompleteTurn(makeTurn({ answer: makeAnswer({ endpointReason: 'recovery' }) })),
    ).toBe(true);
  });

  it('does not flag a normally completed turn', () => {
    expect(
      isIncompleteTurn(makeTurn({ answer: makeAnswer({ endpointReason: 'automatic' }) })),
    ).toBe(false);
  });

  it('does not flag a manual or timeout endpoint as incomplete', () => {
    expect(isIncompleteTurn(makeTurn({ answer: makeAnswer({ endpointReason: 'manual' }) }))).toBe(
      false,
    );
    expect(isIncompleteTurn(makeTurn({ answer: makeAnswer({ endpointReason: 'timeout' }) }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

describe('buildMarkdownExport', () => {
  it('renders the project title as the document heading', () => {
    const md = buildMarkdownExport(makeInput({ projectTitle: 'Title Of Record' }));
    expect(md).toContain('# Title Of Record');
  });

  it('includes the metadata bullets (date, interviewer, duration, questions completed)', () => {
    const md = buildMarkdownExport(
      makeInput({ date: '2026-06-23', durationLabel: '12m 30s' }),
    );
    expect(md).toContain('- **Date:** 2026-06-23');
    expect(md).toContain(`- **Interviewer:** ${INTERVIEWER_DISPLAY_NAME}`);
    expect(md).toContain('- **Interviewer:** Mira');
    expect(md).toContain('- **Duration:** 12m 30s');
    expect(md).toContain('- **Questions completed:** 1 of 1');
  });

  it('renders one numbered section per turn with the question type', () => {
    const md = buildMarkdownExport(
      makeInput({
        turns: [
          makeTurn({ ordinal: 1, question: { ...makeTurn().question, type: 'opening' } }),
          makeTurn({ ordinal: 2, question: { ...makeTurn().question, type: 'clarification' } }),
        ],
      }),
    );
    expect(md).toContain('## 1. opening');
    expect(md).toContain('## 2. clarification');
  });

  it('renders each question prefixed with the interviewer name', () => {
    const md = buildMarkdownExport(
      makeInput({
        turns: [
          makeTurn({ question: { ...makeTurn().question, text: 'Why did you start?' } }),
        ],
      }),
    );
    expect(md).toContain('**Mira:** Why did you start?');
  });

  it('renders answers using the precedence (edited > cleaned > raw)', () => {
    const md = buildMarkdownExport(
      makeInput({
        turns: [
          makeTurn({
            ordinal: 1,
            answer: makeAnswer({ userEditedTranscript: 'the edited answer' }),
          }),
          makeTurn({
            ordinal: 2,
            answer: makeAnswer({
              userEditedTranscript: null,
              cleanedTranscript: 'the cleaned answer',
            }),
          }),
          makeTurn({
            ordinal: 3,
            answer: makeAnswer({
              userEditedTranscript: null,
              cleanedTranscript: null as unknown as string,
              rawTranscript: 'the raw answer',
            }),
          }),
        ],
      }),
    );
    expect(md).toContain('the edited answer');
    expect(md).toContain('the cleaned answer');
    expect(md).toContain('the raw answer');
    // The Answer label precedes the body.
    expect(md).toContain('**Answer:**');
  });

  it('marks an incomplete (unanswered) turn with a note', () => {
    const md = buildMarkdownExport(
      makeInput({ turns: [makeTurn({ ordinal: 1, answer: null })] }),
    );
    expect(md).toContain('(no answer)');
    expect(md.toLowerCase()).toContain('incomplete or recovered');
  });

  it('marks a recovered turn with a note', () => {
    const md = buildMarkdownExport(
      makeInput({
        turns: [makeTurn({ answer: makeAnswer({ endpointReason: 'recovery' }) })],
      }),
    );
    expect(md.toLowerCase()).toContain('incomplete or recovered');
  });

  it('does not annotate a normally completed turn', () => {
    const md = buildMarkdownExport(makeInput());
    expect(md.toLowerCase()).not.toContain('incomplete or recovered');
  });

  it('renders a coverage checklist with [x] for covered and [ ] otherwise', () => {
    const md = buildMarkdownExport(
      makeInput({
        coverage: [
          { label: 'Background', status: 'covered' },
          { label: 'Motivation', status: 'partial' },
          { label: 'Future', status: 'not_started' },
          { label: 'Skipped topic', status: 'skipped' },
        ],
      }),
    );
    expect(md).toContain('## Coverage');
    expect(md).toContain('- [x] Background');
    expect(md).toContain('- [ ] Motivation');
    expect(md).toContain('- [ ] Future');
    expect(md).toContain('- [ ] Skipped topic');
  });

  it('reports the count of completed questions correctly with a mix', () => {
    const md = buildMarkdownExport(
      makeInput({
        turns: [
          makeTurn({ ordinal: 1, answer: makeAnswer() }),
          makeTurn({ ordinal: 2, answer: null }),
          makeTurn({ ordinal: 3, answer: makeAnswer() }),
        ],
      }),
    );
    expect(md).toContain('- **Questions completed:** 2 of 3');
  });

  it('handles a session with no coverage items gracefully', () => {
    const md = buildMarkdownExport(makeInput({ coverage: [] }));
    expect(md).toContain('## Coverage');
    expect(md).toContain('_No coverage items._');
  });

  it('ends with a trailing newline', () => {
    const md = buildMarkdownExport(makeInput());
    expect(md.endsWith('\n')).toBe(true);
  });

  it('does not leak credential-ish or internal fields', () => {
    const md = buildMarkdownExport(makeInput());
    const lower = md.toLowerCase();
    expect(lower).not.toContain('apikey');
    expect(lower).not.toContain('api_key');
    expect(lower).not.toContain('credential');
    expect(lower).not.toContain('system prompt');
    expect(lower).not.toContain('/users/');
  });
});

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

describe('buildJsonExport', () => {
  it('stamps schemaVersion 1', () => {
    const out = buildJsonExport(makeInput());
    expect(out.schemaVersion).toBe(1);
    expect(out.schemaVersion).toBe(PORTABLE_EXPORT_SCHEMA_VERSION);
  });

  it('reflects the caller-supplied date in exportedAt', () => {
    const out = buildJsonExport(makeInput({ date: '2026-12-25T09:30:00.000Z' }));
    expect(out.exportedAt).toBe('2026-12-25T09:30:00.000Z');
  });

  it('carries the project metadata and full plan', () => {
    const brief = makeBrief();
    const out = buildJsonExport(
      makeInput({ projectTitle: 'P', sourceHash: 'sha256:zz', brief }),
    );
    expect(out.project.title).toBe('P');
    expect(out.project.sourceHash).toBe('sha256:zz');
    expect(out.project.plan).toEqual(brief);
  });

  it('carries the scrubbed session metadata', () => {
    const out = buildJsonExport(makeInput());
    expect(out.session).toEqual({
      id: 'sess-1',
      characterId: 'mira',
      startedAt: '2026-06-23T10:00:00.000Z',
      endedAt: '2026-06-23T10:12:30.000Z',
      endpointMode: 'balanced',
      rollingSummary: 'They talked about things.',
    });
  });

  it('produces the correct number of turns', () => {
    const out = buildJsonExport(
      makeInput({
        turns: [makeTurn({ ordinal: 1 }), makeTurn({ ordinal: 2 }), makeTurn({ ordinal: 3 })],
      }),
    );
    expect(out.turns).toHaveLength(3);
    expect(out.turns.map((t) => t.ordinal)).toEqual([1, 2, 3]);
  });

  it('projects the question down to text, type, targetCoverageItemIds, source', () => {
    const out = buildJsonExport(makeInput());
    const turn = out.turns[0];
    expect(turn).toBeDefined();
    expect(turn?.question).toEqual({
      text: 'What is your name?',
      type: 'context',
      targetCoverageItemIds: ['cov-1'],
      source: 'model',
    });
    // No leftover question internals.
    expect(turn?.question).not.toHaveProperty('modelId');
    expect(turn?.question).not.toHaveProperty('promptVersion');
    expect(turn?.question).not.toHaveProperty('mediaPlan');
  });

  it('projects the answer down to transcripts plus endpointReason', () => {
    const out = buildJsonExport(
      makeInput({
        turns: [
          makeTurn({
            answer: makeAnswer({
              rawTranscript: 'r',
              cleanedTranscript: 'c',
              userEditedTranscript: 'u',
              endpointReason: 'manual',
            }),
          }),
        ],
      }),
    );
    const answer = out.turns[0]?.answer;
    expect(answer).toEqual({
      rawTranscript: 'r',
      cleanedTranscript: 'c',
      userEditedTranscript: 'u',
      endpointReason: 'manual',
    });
    // Provider/audio internals must not survive.
    expect(answer).not.toHaveProperty('sttProvider');
    expect(answer).not.toHaveProperty('moderation');
    expect(answer).not.toHaveProperty('durationMs');
  });

  it('keeps a null answer null', () => {
    const out = buildJsonExport(makeInput({ turns: [makeTurn({ answer: null })] }));
    expect(out.turns[0]?.answer).toBeNull();
  });

  it('preserves the coverage delta for each turn', () => {
    const out = buildJsonExport(makeInput());
    expect(out.turns[0]?.coverageDelta).toEqual([
      {
        coverageItemId: 'cov-1',
        fromStatus: 'not_started',
        toStatus: 'covered',
        evidenceTurnIds: ['turn-1'],
      },
    ]);
  });

  it('honours answer precedence indirectly: it preserves all three transcripts so a reader can apply it', () => {
    // The JSON form is lossless over the documented subset; the renderer (or a
    // re-importer) applies precedence. Verify the raw fields are all present.
    const out = buildJsonExport(
      makeInput({
        turns: [
          makeTurn({
            answer: makeAnswer({
              userEditedTranscript: 'edited',
              cleanedTranscript: 'cleaned',
              rawTranscript: 'raw',
            }),
          }),
        ],
      }),
    );
    const answer = out.turns[0]?.answer;
    expect(answer?.userEditedTranscript).toBe('edited');
    expect(answer?.cleanedTranscript).toBe('cleaned');
    expect(answer?.rawTranscript).toBe('raw');
  });

  it('omits any credential-ish field anywhere in the serialized output', () => {
    const out = buildJsonExport(makeInput());
    const serialized = JSON.stringify(out).toLowerCase();
    for (const banned of [
      'apikey',
      'api_key',
      'secret',
      'credential',
      'token',
      'password',
      'bearer',
      'audiodata',
      'rawaudio',
      'absolutepath',
      'systemprompt',
      'system prompt',
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('serializes round-trip to valid JSON', () => {
    const out = buildJsonExport(makeInput());
    const round = JSON.parse(JSON.stringify(out));
    expect(round.schemaVersion).toBe(1);
    expect(round.turns).toHaveLength(1);
  });
});
