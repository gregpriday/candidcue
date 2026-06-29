import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';

import { buildOpenAiAdapters } from '@main/providers/factory';
import { extractResponseText } from '@main/providers/openai/openai-client';
import { compileProjectSource } from '@main/interview/source-compiler';
import { preparedInterviewOutputJsonSchema } from '@main/providers/openai/json-schemas';
import { loadPromptBody, fillTemplate } from '@main/prompts/prompt-loader';
import { preparedInterviewOutputSchema } from '@shared/schemas';
import { isAppError } from '@shared/errors/app-error';
import type { PrepareProjectInput } from '@shared/contracts/adapters';

/**
 * Opt-in INTEGRATION tests for interview preparation against the real OpenAI
 * Responses API (spec §24.1.3). They cost tokens and take tens of seconds, so the
 * default `npm test` run excludes them (see vitest.config.ts) and only
 * `vitest.providers.config.ts` collects them. Run on demand:
 *
 *   OPENAI_API_KEY=sk-... npm run test:providers
 *
 * Purpose: verify our actual provider code can get a usable
 * `prepared_interview_output` from gpt-5.5 — and, when it can't, pin whether the
 * fault is OpenAI/our schema (raw probes) or our streaming reader (the path the
 * app uses). Every test gates on the key, so a keyless run skips and exits 0.
 */
const KEY = process.env.OPENAI_API_KEY;

const COMPILED_SOURCE = compileProjectSource([
  {
    id: 'd1',
    title: 'Daintree 2.0 launch brief',
    content: [
      'Daintree is a desktop interviewing app for solo founders. Version 2.0 ships',
      'this month with on-device recording, an AI interviewer named Mira, and',
      'automatic transcript cleanup. The headline feature is a teleprompter stage',
      'that lets a founder run a polished self-interview without a second operator.',
      'Over the last quarter we rebuilt the audio pipeline for low latency and added',
      'a coverage planner that keeps the conversation on track. Early testers said',
      'the biggest win was preparing a structured interview plan in under a minute.',
    ].join(' '),
  },
  {
    id: 'd2',
    title: 'Founder notes',
    content: [
      'Goals for this interview: explain why we built Daintree, what changed in 2.0,',
      'and who it is for. Avoid pricing specifics and unreleased roadmap items. Keep',
      'the tone warm and concrete, with real examples from the beta. Mention the',
      'Daintree rainforest naming origin only briefly.',
    ].join(' '),
  },
]);

const PREPARE_INPUT: PrepareProjectInput = {
  compiledSource: COMPILED_SOURCE,
  targetQuestionCount: 10,
  title: 'Daintree Release Interview',
  audience: 'developers and early adopters',
  intendedOutcome: 'a clear, honest launch story',
  tone: 'warm, curious, concrete',
  exclusions: ['pricing', 'unreleased roadmap'],
  modelId: 'gpt-5.5',
};

/** Build the project-preparation system prompt exactly as createProjectPreparer does. */
function systemPrompt(): string {
  return fillTemplate(loadPromptBody('project-preparation.system'), {
    targetQuestionCount: String(PREPARE_INPUT.targetQuestionCount),
    titleOrInferred: PREPARE_INPUT.title ?? '',
    audienceOrInferred: PREPARE_INPUT.audience ?? '',
    intendedOutcomeOrInferred: PREPARE_INPUT.intendedOutcome ?? '',
    toneOrDefault: PREPARE_INPUT.tone ?? '',
    exclusionsOrNone: PREPARE_INPUT.exclusions.join('; '),
    compiledSource: PREPARE_INPUT.compiledSource,
  });
}

/** A flat, JSON-loggable summary of a Responses result's output items. */
function summarizeOutput(output: unknown): unknown[] {
  if (!Array.isArray(output)) return [];
  return output.map((it) => {
    const item = it as { type?: unknown; status?: unknown; content?: unknown };
    const content = Array.isArray(item.content)
      ? item.content.map((c) => {
          const part = c as { type?: unknown; text?: unknown; refusal?: unknown };
          return {
            type: part.type,
            textLen: typeof part.text === 'string' ? part.text.length : undefined,
            refusalLen: typeof part.refusal === 'string' ? part.refusal.length : undefined,
          };
        })
      : undefined;
    return { type: item.type, status: item.status, content };
  });
}

interface RawResponseView {
  status?: unknown;
  incomplete_details?: { reason?: unknown } | null;
  error?: unknown;
  output_text?: unknown;
  usage?: unknown;
  output?: unknown;
}

/** Print everything we'd want to see about a raw Responses result. */
function dump(label: string, response: RawResponseView): void {
  console.info(
    `[${label}] ` +
      JSON.stringify({
        status: response.status ?? null,
        incomplete: response.incomplete_details?.reason ?? null,
        error: response.error ?? null,
        outputTextChars: typeof response.output_text === 'string' ? response.output_text.length : 0,
        usage: response.usage ?? null,
        items: summarizeOutput(response.output),
      }),
  );
}

describe.skipIf(!KEY)('OpenAI interview preparation (integration)', () => {
  it('raw NON-streaming create returns a completed, non-empty, parseable plan (OpenAI + schema sanity)', async () => {
    const client = new OpenAI({ apiKey: KEY!, fetch: globalThis.fetch });
    const response = await client.responses.create({
      model: 'gpt-5.5',
      instructions: systemPrompt(),
      input: 'Prepare the interview plan for the project source above.',
      reasoning: { effort: 'low' },
      text: {
        format: {
          type: 'json_schema',
          name: 'prepared_interview_output',
          schema: preparedInterviewOutputJsonSchema,
          strict: true,
        },
      },
    });
    dump('non-streaming create', response);

    expect(response.status).toBe('completed');
    expect(response.output_text.length, 'non-streaming output_text was empty').toBeGreaterThan(0);
    expect(() => preparedInterviewOutputSchema.parse(JSON.parse(response.output_text))).not.toThrow();
  }, 120_000);

  it('raw STREAMING finalResponse exposes the text the deltas streamed (the path the app uses)', async () => {
    const client = new OpenAI({ apiKey: KEY!, fetch: globalThis.fetch });
    const stream = client.responses.stream({
      model: 'gpt-5.5',
      instructions: systemPrompt(),
      input: 'Prepare the interview plan for the project source above.',
      reasoning: { effort: 'low' },
      text: {
        format: {
          type: 'json_schema',
          name: 'prepared_interview_output',
          schema: preparedInterviewOutputJsonSchema,
          strict: true,
        },
      },
    });
    let streamedChars = 0;
    stream.on('response.output_text.delta', (event) => {
      streamedChars = event.snapshot.length;
    });
    const response = await stream.finalResponse();
    dump('streaming finalResponse', response);
    console.info(
      `[streaming] streamedDeltaChars=${streamedChars} finalOutputTextChars=${response.output_text?.length ?? 0}`,
    );

    // The smoking gun: deltas stream the full plan, the message item holds it, but
    // `finalResponse().output_text` (the SDK getter) comes back EMPTY for gpt-5.5.
    // extractResponseText must recover the text from the output items — that's the
    // fix for the app's "status=completed, no output text" preparation failure.
    expect(response.status).toBe('completed');
    expect(streamedChars, 'no output_text deltas streamed at all').toBeGreaterThan(0);

    const recovered = extractResponseText(response, 'prepared_interview_output');
    expect(recovered.length, 'extractResponseText recovered no text from the streamed response').toBeGreaterThan(0);
    expect(() => preparedInterviewOutputSchema.parse(JSON.parse(recovered))).not.toThrow();
  }, 120_000);

  it('prepares a realistic plan via the real adapter and returns the full brief (end-to-end)', async () => {
    const { model } = buildOpenAiAdapters(KEY!);

    let out;
    try {
      out = await model.prepareProject(PREPARE_INPUT);
    } catch (err) {
      // Surface the enriched internal diagnostic so a real failure is legible.
      if (isAppError(err)) throw new Error(`prepareProject failed [${err.code}]: ${err.message}`);
      throw err;
    }

    expect(out.brief.title.trim().length).toBeGreaterThan(0);
    expect(out.brief.oneSentencePremise.trim().length).toBeGreaterThan(0);
    expect(out.brief.coverageItems.length).toBeGreaterThan(0);
    for (const item of out.brief.coverageItems) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(['must', 'should', 'could']).toContain(item.priority);
    }
    expect(out.brief.arc.length).toBeGreaterThan(0);
    expect(out.brief.openingQuestion.text).toMatch(/\?$/);
    expect(Array.isArray(out.warnings)).toBe(true);
  }, 120_000);
});
