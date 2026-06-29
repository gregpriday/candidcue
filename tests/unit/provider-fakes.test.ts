import {
  FakeInterviewModel,
  FakeModeration,
  FakeStt,
  FakeTts,
  AbortError,
} from '@main/providers/fakes';
import { wavDurationMs } from '@main/providers/inworld/wav';
import type {
  PrepareProjectInput,
  GenerateNextActionInput,
  CleanTranscriptInput,
  ClassifyEndpointInput,
  RepairQuestionInput,
  SttSessionConfig,
  AudioChunkPacket,
  TtsInput,
} from '@shared/contracts/adapters';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function prepareInput(overrides: Partial<PrepareProjectInput> = {}): PrepareProjectInput {
  return {
    compiledSource: 'The Future of Solar Power\nA long detailed source about solar panels.',
    targetQuestionCount: 10,
    title: null,
    audience: null,
    intendedOutcome: null,
    tone: null,
    exclusions: ['salary'],
    modelId: 'fake',
    ...overrides,
  };
}

function nextActionInput(overrides: Partial<GenerateNextActionInput> = {}): GenerateNextActionInput {
  return {
    characterSystemPrompt: 'You are a curious host.',
    brief: {
      title: 'Topic',
      oneSentencePremise: 'A premise.',
      audience: 'all',
      intendedOutcome: 'clarity',
      recommendedTone: 'warm',
      factualAnchors: [],
      terminology: [],
      coverageItems: [],
      arc: [],
      exclusions: [],
      openingQuestion: { text: 'Hi?', type: 'opening', targetCoverageItemIds: [], useWhen: 'always' },
      fallbackQuestions: [],
      closingStrategy: 'thank them',
    },
    coverage: [
      {
        coverageItemId: 'cov-1',
        label: 'Origins',
        objective: 'understand origins',
        priority: 'must',
        status: 'not_started',
        followUpCount: 0,
      },
    ],
    rollingSummary: 'so far so good',
    recentTurns: [],
    currentAnswer: 'I started in 2010.',
    rawAnswerFallback: 'I started in 2010.',
    moderationGuidance: '',
    nextOrdinal: 1,
    targetQuestionCount: 10,
    endAfterTurn: false,
    currentSectionId: 'section-1',
    modelId: 'fake',
    ...overrides,
  };
}

function audioChunk(sequence: number): AudioChunkPacket {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    sequence,
    sampleRate: 16000,
    channels: 1,
    format: 'pcm_s16le',
    capturedAtMs: 1000 + sequence,
    payload: new ArrayBuffer(8),
  };
}

const sttConfig: SttSessionConfig = {
  sampleRate: 16000,
  channels: 1,
  model: 'fake-stt',
  interimResults: true,
};

function ttsInput(overrides: Partial<TtsInput> = {}): TtsInput {
  return {
    text: 'Hello there, this is a test of the synthesis path.',
    voiceId: 'voice-1',
    style: 'neutral',
    speakingRate: 1,
    outputFormat: 'pcm_s16le',
    sampleRate: 24000,
    ...overrides,
  };
}

/** Count occurrences of '?' in a string. */
function questionMarks(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// FakeInterviewModel
// ---------------------------------------------------------------------------

describe('FakeInterviewModel', () => {
  describe('prepareProject', () => {
    it('seeds the six launch-video coverage beats, an opening question, and 2 fallbacks', async () => {
      const model = new FakeInterviewModel();
      const out = await model.prepareProject(prepareInput());

      // Issue #64: preparation always targets the launch-video beats by design.
      expect(out.brief.coverageItems.map((c) => c.id)).toEqual([
        'coverage-origin-story',
        'coverage-founding-insight',
        'coverage-wedge',
        'coverage-traction',
        'coverage-demo-aha',
        'coverage-takeaway',
      ]);
      for (const item of out.brief.coverageItems) {
        expect(item.priority).toBe('must');
        expect(item.status).toBe('not_started');
      }
      expect(out.brief.openingQuestion.text.endsWith('?')).toBe(true);
      expect(out.brief.fallbackQuestions).toHaveLength(2);
      for (const q of out.brief.fallbackQuestions) {
        expect(q.text.endsWith('?')).toBe(true);
      }
      // Exclusions are threaded through from input.
      expect(out.brief.exclusions).toContain('salary');
      // The arc references every seeded coverage id, in order.
      expect(out.brief.arc[0]?.coverageItemIds).toEqual(out.brief.coverageItems.map((c) => c.id));
      expect(out.warnings).toEqual([]);
    });

    it('derives the title from the compiled source when none is supplied', async () => {
      const model = new FakeInterviewModel();
      const out = await model.prepareProject(prepareInput());
      expect(out.brief.title.length).toBeGreaterThan(0);
      expect(out.brief.title).toContain('Solar');
    });

    it('uses the configured tone when provided', async () => {
      const model = new FakeInterviewModel();
      const out = await model.prepareProject(prepareInput({ tone: 'playful' }));
      expect(out.brief.recommendedTone).toBe('playful');
    });

    it('reflects founder-supplied title, audience, and outcome in the brief', async () => {
      const model = new FakeInterviewModel();
      const out = await model.prepareProject(
        prepareInput({
          title: 'Founders at Work',
          audience: 'aspiring founders',
          intendedOutcome: 'practical, candid lessons',
        }),
      );
      expect(out.brief.title).toBe('Founders at Work');
      expect(out.brief.audience).toBe('aspiring founders');
      expect(out.brief.intendedOutcome).toBe('practical, candid lessons');
    });

    it('falls back to defaults for audience and outcome when not supplied', async () => {
      const model = new FakeInterviewModel();
      const out = await model.prepareProject(prepareInput());
      expect(out.brief.audience).toBe('general interested listeners');
      expect(out.brief.intendedOutcome).toBe('a clear, candid account of the topic');
    });
  });

  describe('generateNextAction', () => {
    it("returns an 'ask' action with short spokenText ending in '?'", async () => {
      const model = new FakeInterviewModel();
      const action = await model.generateNextAction(nextActionInput());

      expect(action.action).toBe('ask');
      expect(action.spokenText.endsWith('?')).toBe(true);
      expect(questionMarks(action.spokenText)).toBe(1);
      expect(action.spokenText.split(' ').length).toBeLessThanOrEqual(20);
      // Targets the first coverage item from the input.
      expect(action.targetCoverageItemIds).toEqual(['cov-1']);
    });

    it('cycles question text across calls', async () => {
      const model = new FakeInterviewModel({ questionTexts: ['First one', 'Second one'] });
      const a = await model.generateNextAction(nextActionInput());
      const b = await model.generateNextAction(nextActionInput());
      const c = await model.generateNextAction(nextActionInput());

      expect(a.spokenText).toBe('First one?');
      expect(b.spokenText).toBe('Second one?');
      // Wraps back around.
      expect(c.spokenText).toBe('First one?');
      expect(model.callCount).toBe(3);
    });

    it('honours a scripted queue, then falls back to defaults', async () => {
      const model = new FakeInterviewModel({
        scriptedActions: [
          { action: 'complete', spokenText: 'Thank you, that is a wrap.' },
          { spokenText: 'A scripted follow-up?' },
        ],
        questionTexts: ['Default Q'],
      });

      const first = await model.generateNextAction(nextActionInput());
      expect(first.action).toBe('complete');
      expect(first.spokenText).toBe('Thank you, that is a wrap.');

      // Partial scripted entry overrides only the provided fields.
      const second = await model.generateNextAction(nextActionInput());
      expect(second.action).toBe('ask');
      expect(second.spokenText).toBe('A scripted follow-up?');

      // Queue exhausted -> default cycling question.
      const third = await model.generateNextAction(nextActionInput());
      expect(third.spokenText).toBe('Default Q?');
    });

    it('hangs (never resolves) when failNext is set, rejecting on abort with AbortError', async () => {
      const model = new FakeInterviewModel({ failNext: 1 });
      const controller = new AbortController();
      const promise = model.generateNextAction(nextActionInput(), controller.signal);

      // Race the hanging call against a microtask resolver; the hang wins.
      const sentinel = Symbol('pending');
      const settledFirst = await Promise.race([
        promise.then(() => 'resolved').catch(() => 'rejected'),
        Promise.resolve(sentinel),
      ]);
      expect(settledFirst).toBe(sentinel);

      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(AbortError);

      // The very next call resolves normally again.
      const next = await model.generateNextAction(nextActionInput());
      expect(next.action).toBe('ask');
    });

    it('rejects immediately when the signal is already aborted', async () => {
      const model = new FakeInterviewModel();
      const controller = new AbortController();
      controller.abort();
      await expect(
        model.generateNextAction(nextActionInput(), controller.signal),
      ).rejects.toBeInstanceOf(AbortError);
    });
  });

  describe('cleanTranscript', () => {
    it('returns cleanedText equal to raw input split into paragraphs', async () => {
      const model = new FakeInterviewModel();
      const raw = 'First paragraph here.\n\nSecond paragraph here.';
      const input: CleanTranscriptInput = { rawTranscript: raw, glossary: [], modelId: 'fake' };
      const out = await model.cleanTranscript(input);

      expect(out.cleanedText).toBe(raw);
      expect(out.paragraphs).toEqual(['First paragraph here.', 'Second paragraph here.']);
      expect(out.glossaryCorrections).toEqual([]);
      expect(out.uncertainTerms).toEqual([]);
      expect(out.materialChanges).toEqual([]);
    });
  });

  describe('classifyEndpoint', () => {
    it('defaults to shouldCommit true with probability 0.95', async () => {
      const model = new FakeInterviewModel();
      const input: ClassifyEndpointInput = {
        question: 'q?',
        transcript: 'an answer',
        speechDurationMs: 3000,
        silenceDurationMs: 1800,
        mode: 'balanced',
        modelId: 'fake',
      };
      const decision = await model.classifyEndpoint(input);
      expect(decision.shouldCommit).toBe(true);
      expect(decision.completeProbability).toBe(0.95);
      expect(decision.incompleteReason).toBe('none');
    });

    it('honours a configured endpoint decision', async () => {
      const model = new FakeInterviewModel({
        endpoint: { shouldCommit: false, completeProbability: 0.2, incompleteReason: 'too_short' },
      });
      const decision = await model.classifyEndpoint({
        question: 'q?',
        transcript: 'um',
        speechDurationMs: 200,
        silenceDurationMs: 300,
        mode: 'conservative',
        modelId: 'fake',
      });
      expect(decision.shouldCommit).toBe(false);
      expect(decision.completeProbability).toBe(0.2);
      expect(decision.incompleteReason).toBe('too_short');
    });
  });

  describe('repairQuestion', () => {
    it('trims to maxWords and ensures exactly one trailing question mark', async () => {
      const model = new FakeInterviewModel();
      const input: RepairQuestionInput = {
        spokenText: 'This is a very long question that should be trimmed down nicely?? ',
        maxWords: 5,
        reason: 'too_many_words',
        modelId: 'fake',
      };
      const out = await model.repairQuestion(input);

      expect(out.spokenText.split(' ').length).toBeLessThanOrEqual(5);
      expect(questionMarks(out.spokenText)).toBe(1);
      expect(out.spokenText.endsWith('?')).toBe(true);
      expect(out.spokenText).toBe('This is a very long?');
    });
  });
});

// ---------------------------------------------------------------------------
// FakeModeration
// ---------------------------------------------------------------------------

describe('FakeModeration', () => {
  it('allows text with no configured triggers', async () => {
    const mod = new FakeModeration();
    const rec = await mod.moderate('a perfectly fine sentence');
    expect(rec.flagged).toBe(false);
    expect(rec.decision).toBe('allow');
    expect(rec.categories).toEqual({});
    expect(mod.seen).toContain('a perfectly fine sentence');
  });

  it('flags and redirects text containing a trigger word (case-insensitive)', async () => {
    const mod = new FakeModeration({ triggers: ['forbidden'] });
    const clean = await mod.moderate('totally fine');
    expect(clean.flagged).toBe(false);

    const flagged = await mod.moderate('this is FORBIDDEN content');
    expect(flagged.flagged).toBe(true);
    expect(flagged.decision).toBe('redirect');
    expect(flagged.categories.harassment).toBe(true);
    expect(flagged.categoryScores.harassment).toBeCloseTo(0.99);
  });

  it('respects a configured flagged category and decision', async () => {
    const mod = new FakeModeration({
      triggers: ['nope'],
      flaggedCategory: 'violence',
      flaggedDecision: 'error',
    });
    const rec = await mod.moderate('nope nope nope');
    expect(rec.categories.violence).toBe(true);
    expect(rec.decision).toBe('error');
  });

  it('rejects when the signal is already aborted', async () => {
    const mod = new FakeModeration();
    const controller = new AbortController();
    controller.abort();
    await expect(mod.moderate('hi', controller.signal)).rejects.toBeInstanceOf(AbortError);
  });
});

// ---------------------------------------------------------------------------
// FakeStt
// ---------------------------------------------------------------------------

describe('FakeStt', () => {
  it('connects, accepts audio, and returns the configured transcript on endTurn', async () => {
    const stt = new FakeStt({ transcript: 'the recorded answer', finalSegments: ['the recorded answer'] });
    await stt.connect(sttConfig);
    expect(stt.connected).toBe(true);
    expect(stt.lastConfig).toEqual(sttConfig);

    await stt.beginTurn('turn-1');
    expect(stt.currentTurnId).toBe('turn-1');

    stt.writeAudio(audioChunk(0));
    stt.writeAudio(audioChunk(1));
    expect(stt.writtenChunks).toHaveLength(2);

    const result = await stt.endTurn({ deadlineMs: 1500 });
    expect(result.text).toBe('the recorded answer');
    expect(result.finalSegments).toEqual(['the recorded answer']);
    expect(result.confidence).toBe(0.9);
    expect(stt.currentTurnId).toBeNull();
  });

  it('resumeTurn re-activates the same turn without dropping accumulated transcript', async () => {
    const stt = new FakeStt({ transcript: 'config fallback' });
    await stt.connect(sttConfig);

    await stt.beginTurn('turn-1');
    expect(stt.beginTurnCalls).toBe(1);
    stt.pushTranscript('hello there');

    // A pause/resume cycle: resumeTurn restores the turn but must NOT begin a new
    // one (which would clear the accumulator) and must keep the captured words.
    await stt.resumeTurn('turn-1');
    expect(stt.resumeTurnCalls).toBe(1);
    expect(stt.lastResumedTurnId).toBe('turn-1');
    expect(stt.currentTurnId).toBe('turn-1');
    expect(stt.beginTurnCalls).toBe(1); // no second beginTurn

    const result = await stt.endTurn({ deadlineMs: 1500 });
    expect(result.text).toBe('hello there'); // accumulated transcript preserved
  });

  it('reconnect restores the transport so resumeTurn succeeds again, and counts calls', async () => {
    const stt = new FakeStt({ transcript: 'config fallback' });
    await stt.connect(sttConfig);

    // The transport dropped: resumeTurn fails until a reconnect restores it.
    stt.failResume = true;
    await expect(stt.resumeTurn('turn-1')).rejects.toThrow();
    expect(stt.resumeTurnCalls).toBe(1); // the failed attempt still counted

    await stt.reconnect();
    expect(stt.reconnectCalls).toBe(1);
    expect(stt.connected).toBe(true);
    expect(stt.failResume).toBe(false); // transport restored

    // resumeTurn now succeeds and re-activates the turn.
    await stt.resumeTurn('turn-1');
    expect(stt.resumeTurnCalls).toBe(2);
    expect(stt.lastResumedTurnId).toBe('turn-1');
  });

  it('reconnect rejects with STT_DISCONNECTED when failReconnect is set', async () => {
    const stt = new FakeStt();
    await stt.connect(sttConfig);
    stt.failReconnect = true;
    await expect(stt.reconnect()).rejects.toMatchObject({ code: 'STT_DISCONNECTED' });
    expect(stt.reconnectCalls).toBe(1);
  });

  it('beginTurn starts a fresh turn and discards previously accumulated transcript', async () => {
    const stt = new FakeStt({ transcript: 'config fallback' });
    await stt.connect(sttConfig);
    await stt.beginTurn('turn-1');
    stt.pushTranscript('stale words');
    await stt.beginTurn('turn-2'); // fresh turn → accumulator cleared

    const result = await stt.endTurn({ deadlineMs: 1500 });
    expect(result.text).toBe('config fallback');
  });

  it('recoverFromAudio returns the transcript for non-empty audio and empty for empty audio', async () => {
    const stt = new FakeStt({ transcript: 'recovered text' });
    const recovered = await stt.recoverFromAudio(new Uint8Array([1, 2, 3, 4]), {
      sampleRate: 16000,
      channels: 1,
      model: 'fake-stt',
    });
    expect(recovered.text).toBe('recovered text');

    const empty = await stt.recoverFromAudio(new Uint8Array(0), {
      sampleRate: 16000,
      channels: 1,
      model: 'fake-stt',
    });
    expect(empty.text).toBe('');
    expect(empty.finalSegments).toEqual([]);
    expect(empty.confidence).toBeNull();
  });

  it('emits events to registered listeners and supports unsubscribe', () => {
    const stt = new FakeStt();
    const partials: string[] = [];
    const started: number[] = [];

    const off = stt.on('partial', (text: string) => partials.push(text));
    stt.on('speechStarted', (at: number) => started.push(at));

    stt.emit('partial', 'hel');
    stt.emit('partial', 'hello');
    stt.emit('speechStarted', 42);
    stt.emit('finalSegment', 'ignored — no listener'); // no-op

    expect(partials).toEqual(['hel', 'hello']);
    expect(started).toEqual([42]);

    off();
    stt.emit('partial', 'after-unsub');
    expect(partials).toEqual(['hel', 'hello']);
  });

  it('clears listeners and marks closed on close()', async () => {
    const stt = new FakeStt();
    let calls = 0;
    stt.on('error', () => {
      calls += 1;
    });
    await stt.connect(sttConfig);
    await stt.close();

    expect(stt.closed).toBe(true);
    expect(stt.connected).toBe(false);
    stt.emit('error', new Error('boom'));
    expect(calls).toBe(0);
  });

  it('rejects endTurn when its signal is already aborted', async () => {
    const stt = new FakeStt();
    const controller = new AbortController();
    controller.abort();
    await expect(
      stt.endTurn({ signal: controller.signal, deadlineMs: 1500 }),
    ).rejects.toBeInstanceOf(AbortError);
  });
});

// ---------------------------------------------------------------------------
// FakeTts
// ---------------------------------------------------------------------------

describe('FakeTts', () => {
  it('synthesizes mono PCM at the requested sample rate with a derived duration', async () => {
    const tts = new FakeTts();
    const result = await tts.synthesize(ttsInput({ sampleRate: 24000 }));

    expect(result.channels).toBe(1);
    expect(result.sampleRate).toBe(24000);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.mimeType).toBe('audio/pcm');
  });

  it('is deterministic: identical text yields identical duration', async () => {
    const tts = new FakeTts();
    const a = await tts.synthesize(ttsInput({ text: 'one two three four five' }));
    const b = await tts.synthesize(ttsInput({ text: 'one two three four five' }));
    expect(a.durationMs).toBe(b.durationMs);
  });

  it('longer text yields a longer derived duration', async () => {
    const tts = new FakeTts();
    const short = await tts.synthesize(ttsInput({ text: 'short' }));
    const long = await tts.synthesize(
      ttsInput({ text: 'this is a considerably longer piece of text to synthesize aloud' }),
    );
    expect(long.durationMs).toBeGreaterThan(short.durationMs);
  });

  it('honours a fixed configured durationMs', async () => {
    const tts = new FakeTts({ durationMs: 1234 });
    const result = await tts.synthesize(ttsInput());
    expect(result.durationMs).toBe(1234);
  });

  it('testVoice mirrors synthesize and reports wav mime for wav output', async () => {
    const tts = new FakeTts({ providerRequestId: 'req-9' });
    const result = await tts.testVoice(ttsInput({ outputFormat: 'wav' }));
    expect(result.mimeType).toBe('audio/wav');
    expect(result.providerRequestId).toBe('req-9');
    expect(tts.seen).toHaveLength(1);
  });

  it('returns a real RIFF/WAVE container (not raw PCM) for wav output', async () => {
    // The real TTS contract always requests `outputFormat: 'wav'`, and the stage
    // SpeechPlayer decodes via AudioContext.decodeAudioData — which rejects a
    // bare-PCM buffer. The fake must therefore emit a well-formed WAV container.
    const tts = new FakeTts({ durationMs: 1500 });
    const result = await tts.synthesize(ttsInput({ outputFormat: 'wav', sampleRate: 24000 }));
    const bytes = result.bytes;
    const tag = (b: Uint8Array, off: number): string =>
      String.fromCharCode(b[off] ?? 0, b[off + 1] ?? 0, b[off + 2] ?? 0, b[off + 3] ?? 0);

    expect(result.mimeType).toBe('audio/wav');
    expect(bytes.length).toBeGreaterThanOrEqual(44); // 44-byte header + PCM payload
    expect(tag(bytes, 0)).toBe('RIFF');
    expect(tag(bytes, 8)).toBe('WAVE');
    // The production WAV parser walks the container without throwing.
    expect(wavDurationMs(bytes)).toBeGreaterThan(0);
  });

  it('returns raw PCM (no RIFF/WAVE container) for non-wav output', async () => {
    // The wav path wraps PCM in a container for the stage decoder; the pcm_s16le
    // path must stay bare PCM so callers counting on raw samples aren't handed a
    // WAV header. Guards the format switch from regressing into always-WAV.
    const tts = new FakeTts();
    const result = await tts.synthesize(ttsInput({ outputFormat: 'pcm_s16le' }));
    const bytes = result.bytes;
    const tag = (b: Uint8Array, off: number): string =>
      String.fromCharCode(b[off] ?? 0, b[off + 1] ?? 0, b[off + 2] ?? 0, b[off + 3] ?? 0);

    expect(result.mimeType).toBe('audio/pcm');
    expect(tag(bytes, 0)).not.toBe('RIFF');
    expect(tag(bytes, 8)).not.toBe('WAVE');
  });

  it('rejects when the signal is already aborted', async () => {
    const tts = new FakeTts();
    const controller = new AbortController();
    controller.abort();
    await expect(tts.synthesize(ttsInput(), controller.signal)).rejects.toBeInstanceOf(AbortError);
  });
});
