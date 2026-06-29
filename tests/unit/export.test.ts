import {
  buildMarkdownExport,
  buildJsonExport,
  resolveAnswerText,
  isIncompleteTurn,
  formatTimecodeOffset,
  computeSessionDurationLabel,
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
    // Default speech window: started 12s into the session, ran for 8s.
    speechStartedAt: '2026-06-23T10:00:12.000Z',
    speechEndedAt: '2026-06-23T10:00:20.000Z',
    durationMs: 8000,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    ordinal: 1,
    createdAt: '2026-06-23T10:00:10.000Z',
    completedAt: '2026-06-23T10:00:21.000Z',
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
// Timecode / duration helpers (issue #49)
// ---------------------------------------------------------------------------

describe('formatTimecodeOffset', () => {
  it('formats sub-minute offsets as M:SS with a zero minute', () => {
    expect(formatTimecodeOffset(0)).toBe('0:00');
    expect(formatTimecodeOffset(12000)).toBe('0:12');
    expect(formatTimecodeOffset(59_999)).toBe('0:59');
  });

  it('rolls over to minutes at exactly 60s', () => {
    expect(formatTimecodeOffset(60_000)).toBe('1:00');
    expect(formatTimecodeOffset(135_000)).toBe('2:15');
  });

  it('switches to H:MM:SS at and beyond one hour', () => {
    expect(formatTimecodeOffset(3_599_999)).toBe('59:59');
    expect(formatTimecodeOffset(3_600_000)).toBe('1:00:00');
    expect(formatTimecodeOffset(3_600_000 + 12_000)).toBe('1:00:12');
    expect(formatTimecodeOffset(3_661_000)).toBe('1:01:01');
  });

  it('clamps negative offsets to 0:00', () => {
    expect(formatTimecodeOffset(-5000)).toBe('0:00');
  });
});

describe('computeSessionDurationLabel', () => {
  it('returns — when either timestamp is missing', () => {
    expect(computeSessionDurationLabel(null, '2026-06-23T10:12:30.000Z')).toBe('—');
    expect(computeSessionDurationLabel('2026-06-23T10:00:00.000Z', null)).toBe('—');
    expect(computeSessionDurationLabel(null, null)).toBe('—');
  });

  it('returns — when a timestamp is unparseable or the order is inverted', () => {
    expect(computeSessionDurationLabel('not-a-date', '2026-06-23T10:12:30.000Z')).toBe('—');
    expect(
      computeSessionDurationLabel('2026-06-23T10:12:30.000Z', '2026-06-23T10:00:00.000Z'),
    ).toBe('—');
  });

  it('formats a degenerate zero-length session as 0s (start === end is valid)', () => {
    expect(
      computeSessionDurationLabel('2026-06-23T10:00:00.000Z', '2026-06-23T10:00:00.000Z'),
    ).toBe('0s');
  });

  it('formats sub-minute durations as Ns', () => {
    expect(
      computeSessionDurationLabel('2026-06-23T10:00:00.000Z', '2026-06-23T10:00:45.000Z'),
    ).toBe('45s');
  });

  it('formats minute-scale durations as Mm Ss (matching the existing 12m 30s example)', () => {
    expect(
      computeSessionDurationLabel('2026-06-23T10:00:00.000Z', '2026-06-23T10:12:30.000Z'),
    ).toBe('12m 30s');
  });

  it('formats hour-scale durations as Hh MMm SSs', () => {
    expect(
      computeSessionDurationLabel('2026-06-23T10:00:00.000Z', '2026-06-23T11:05:03.000Z'),
    ).toBe('1h 05m 03s');
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

  it('stamps the turn heading with a seek timecode and spoken duration', () => {
    // speechStartedAt is 12s after the session start; durationMs is 8000.
    const md = buildMarkdownExport(makeInput());
    expect(md).toContain('## 1. context [0:12] (8s)');
  });

  it('omits the timecode bracket when the session has no start timestamp', () => {
    const md = buildMarkdownExport(
      makeInput({
        session: { ...makeInput().session, startedAt: null },
      }),
    );
    expect(md).toContain('## 1. context');
    expect(md).not.toContain('[0:12]');
    // Spoken duration is independent of the session anchor, so it still shows.
    expect(md).toContain('(8s)');
  });

  it('omits the timecode bracket when the answer has no speech start', () => {
    const md = buildMarkdownExport(
      makeInput({
        turns: [makeTurn({ answer: makeAnswer({ speechStartedAt: null }) })],
      }),
    );
    expect(md).not.toContain('[0:12]');
    // The spoken duration is independent of the seek anchor, so the heading
    // still carries `(8s)` with no timecode bracket at all.
    expect(md).toContain('## 1. context (8s)\n');
  });

  it('computes each turn timecode independently across multiple turns', () => {
    const md = buildMarkdownExport(
      makeInput({
        // Session starts 10:00:00; speech starts at +12s, +2m15s, +1h01m01s.
        turns: [
          makeTurn({
            ordinal: 1,
            answer: makeAnswer({ speechStartedAt: '2026-06-23T10:00:12.000Z', durationMs: 8000 }),
          }),
          makeTurn({
            ordinal: 2,
            answer: makeAnswer({ speechStartedAt: '2026-06-23T10:02:15.000Z', durationMs: 30_000 }),
          }),
          makeTurn({
            ordinal: 3,
            answer: makeAnswer({ speechStartedAt: '2026-06-23T11:01:01.000Z', durationMs: 5000 }),
          }),
        ],
      }),
    );
    expect(md).toContain('## 1. context [0:12] (8s)');
    expect(md).toContain('## 2. context [2:15] (30s)');
    expect(md).toContain('## 3. context [1:01:01] (5s)');
  });

  it('renders no timecode or duration for an unanswered turn', () => {
    const md = buildMarkdownExport(makeInput({ turns: [makeTurn({ ordinal: 1, answer: null })] }));
    // The heading line carries no timecode/duration suffix (the coverage
    // checklist below legitimately uses `[x]`/`[ ]`, so check the heading line).
    expect(md).toContain('## 1. context\n');
    expect(md).not.toContain('[0:12]');
    expect(md).not.toContain('(8s)');
  });

  it('renders the computed session duration in the metadata', () => {
    // makeInput's session runs 10:00:00 → 10:12:30, but durationLabel is the
    // caller's responsibility; the exporter just prints what it's given.
    const md = buildMarkdownExport(makeInput({ durationLabel: '12m 30s' }));
    expect(md).toContain('- **Duration:** 12m 30s');
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

  it('projects the answer down to transcripts, endpointReason, and speech timing', () => {
    const out = buildJsonExport(
      makeInput({
        turns: [
          makeTurn({
            answer: makeAnswer({
              rawTranscript: 'r',
              cleanedTranscript: 'c',
              userEditedTranscript: 'u',
              endpointReason: 'manual',
              speechStartedAt: '2026-06-23T10:00:12.000Z',
              speechEndedAt: '2026-06-23T10:00:20.000Z',
              durationMs: 8000,
            }),
          }),
        ],
      }),
    );
    const answer = out.turns[0]?.answer;
    // Timing (issue #49) is now a deliberate, carried field.
    expect(answer).toEqual({
      rawTranscript: 'r',
      cleanedTranscript: 'c',
      userEditedTranscript: 'u',
      endpointReason: 'manual',
      speechStartedAt: '2026-06-23T10:00:12.000Z',
      speechEndedAt: '2026-06-23T10:00:20.000Z',
      durationMs: 8000,
    });
    // Provider/audio/moderation internals must still not survive.
    expect(answer).not.toHaveProperty('sttProvider');
    expect(answer).not.toHaveProperty('moderation');
    expect(answer).not.toHaveProperty('sttLatencyMs');
    expect(answer).not.toHaveProperty('transcriptParagraphs');
  });

  it('keeps a null answer null', () => {
    const out = buildJsonExport(makeInput({ turns: [makeTurn({ answer: null })] }));
    expect(out.turns[0]?.answer).toBeNull();
  });

  it('carries the answer speech timing through losslessly', () => {
    const out = buildJsonExport(
      makeInput({
        turns: [
          makeTurn({
            answer: makeAnswer({
              speechStartedAt: '2026-06-23T10:00:12.500Z',
              speechEndedAt: '2026-06-23T10:00:20.500Z',
              durationMs: 8000,
            }),
          }),
        ],
      }),
    );
    const answer = out.turns[0]?.answer;
    expect(answer?.speechStartedAt).toBe('2026-06-23T10:00:12.500Z');
    expect(answer?.speechEndedAt).toBe('2026-06-23T10:00:20.500Z');
    expect(answer?.durationMs).toBe(8000);
  });

  it('carries the turn createdAt/completedAt timestamps', () => {
    const out = buildJsonExport(
      makeInput({
        turns: [
          makeTurn({
            createdAt: '2026-06-23T10:00:10.000Z',
            completedAt: '2026-06-23T10:00:21.000Z',
          }),
        ],
      }),
    );
    expect(out.turns[0]?.createdAt).toBe('2026-06-23T10:00:10.000Z');
    expect(out.turns[0]?.completedAt).toBe('2026-06-23T10:00:21.000Z');
  });

  it('computes offsetFromStartMs from session start to speech start', () => {
    // session starts 10:00:00, speech starts 10:00:12 → 12000ms.
    const out = buildJsonExport(makeInput());
    expect(out.turns[0]?.offsetFromStartMs).toBe(12000);
  });

  it('nulls offsetFromStartMs when the turn has no answer', () => {
    const out = buildJsonExport(makeInput({ turns: [makeTurn({ answer: null })] }));
    expect(out.turns[0]?.offsetFromStartMs).toBeNull();
  });

  it('nulls offsetFromStartMs when the session has no start timestamp', () => {
    const out = buildJsonExport(
      makeInput({ session: { ...makeInput().session, startedAt: null } }),
    );
    expect(out.turns[0]?.offsetFromStartMs).toBeNull();
  });

  it('clamps a negative offset (clock skew) to 0 while preserving raw ISO', () => {
    // Speech start precedes session start by 1s — a clock-skew artifact.
    const out = buildJsonExport(
      makeInput({
        session: { ...makeInput().session, startedAt: '2026-06-23T10:00:00.000Z' },
        turns: [
          makeTurn({
            answer: makeAnswer({ speechStartedAt: '2026-06-23T09:59:59.000Z' }),
          }),
        ],
      }),
    );
    expect(out.turns[0]?.offsetFromStartMs).toBe(0);
    // The raw ISO value is unchanged — losslessness is preserved.
    expect(out.turns[0]?.answer?.speechStartedAt).toBe('2026-06-23T09:59:59.000Z');
  });

  it('computes offsetFromStartMs independently per turn', () => {
    const out = buildJsonExport(
      makeInput({
        turns: [
          makeTurn({ ordinal: 1, answer: makeAnswer({ speechStartedAt: '2026-06-23T10:00:12.000Z' }) }),
          makeTurn({ ordinal: 2, answer: makeAnswer({ speechStartedAt: '2026-06-23T10:02:15.000Z' }) }),
          makeTurn({ ordinal: 3, answer: makeAnswer({ speechStartedAt: '2026-06-23T11:01:01.000Z' }) }),
        ],
      }),
    );
    expect(out.turns.map((t) => t.offsetFromStartMs)).toEqual([12_000, 135_000, 3_661_000]);
  });

  it('drops unknown/sensitive answer fields via the explicit projection (no spread)', () => {
    // Poison the answer with fields the portable projection must never carry.
    // The exporter builds its output field-by-field, so injected internals are
    // structurally dropped — this guards against a future spread regression.
    const poisoned = {
      ...makeAnswer(),
      sttProvider: 'inworld',
      moderation: { flagged: false },
      apiKey: 'sk-should-never-leak',
      rawAudio: 'BASE64AUDIO',
    } as unknown as NonNullable<Turn['answer']>;
    const out = buildJsonExport(makeInput({ turns: [makeTurn({ answer: poisoned })] }));
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('sttProvider');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('sk-should-never-leak');
    expect(serialized).not.toContain('rawAudio');
    expect(serialized).not.toContain('BASE64AUDIO');
    // The legitimate timing fields still survive.
    expect(out.turns[0]?.answer?.durationMs).toBe(8000);
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
