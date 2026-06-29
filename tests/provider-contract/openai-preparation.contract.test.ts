import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';

import { buildOpenAiAdapters } from '@main/providers/factory';
import { compileProjectSource } from '@main/interview/source-compiler';
import { preparedInterviewOutputJsonSchema } from '@main/providers/openai/json-schemas';
import { loadPromptBody, fillTemplate } from '@main/prompts/prompt-loader';
import { preparedInterviewOutputSchema } from '@shared/schemas';
import { isAppError } from '@shared/errors/app-error';
import type { PrepareProjectInput } from '@shared/contracts/adapters';

/**
 * Opt-in INTEGRATION tests for interview preparation against the real OpenAI
 * Responses API (spec §24.1.3). These cost tokens and take tens of seconds, so
 * they are excluded from the default `npm test` run and only collected by
 * `vitest.providers.config.ts`. Run on demand to confirm we still get a usable
 * `prepared_interview_output` back from gpt-5.5 — and, when we don't, to see
 * exactly why (status / incomplete reason / refusal / API error):
 *
 *   OPENAI_API_KEY=sk-... npm run test:providers
 *
 * Every test is gated on the key, so a keyless run skips and exits 0.
 */
const KEY = process.env.OPENAI_API_KEY;

// A realistic, multi-document source — closer to a real launch interview than the
// one-liner in openai.contract.test.ts, so preparation exercises a full-size plan
// (the shape that surfaced the empty-response failure in the field).
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

/** Scan raw Responses output items for a model refusal string, if present. */
function findRefusal(output: readonly unknown[] | null | undefined): string | null {
  for (const item of output ?? []) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const part = raw as { type?: unknown; refusal?: unknown };
      if (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.length > 0) {
        return part.refusal;
      }
    }
  }
  return null;
}

describe.skipIf(!KEY)('OpenAI interview preparation (integration)', () => {
  it('prepares a realistic plan and returns the full brief we consume', async () => {
    const { model } = buildOpenAiAdapters(KEY!);

    let out;
    try {
      out = await model.prepareProject(PREPARE_INPUT);
    } catch (err) {
      // Surface the enriched internal diagnostic so a real failure is legible in
      // the test output instead of a bare "OPENAI_SCHEMA".
      if (isAppError(err)) {
        throw new Error(`prepareProject failed [${err.code}]: ${err.message}`);
      }
      throw err;
    }

    // The fields the app actually reads downstream — if any are missing/empty,
    // the prepared plan is unusable even when the call "succeeded".
    expect(out.brief.title.trim().length).toBeGreaterThan(0);
    expect(out.brief.oneSentencePremise.trim().length).toBeGreaterThan(0);
    expect(out.brief.audience.trim().length).toBeGreaterThan(0);
    expect(out.brief.intendedOutcome.trim().length).toBeGreaterThan(0);

    expect(out.brief.coverageItems.length).toBeGreaterThan(0);
    for (const item of out.brief.coverageItems) {
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.objective.trim().length).toBeGreaterThan(0);
      expect(['must', 'should', 'could']).toContain(item.priority);
    }

    expect(out.brief.arc.length).toBeGreaterThan(0);
    expect(out.brief.openingQuestion.text).toMatch(/\?$/);
    expect(Array.isArray(out.brief.factualAnchors)).toBe(true);
    expect(Array.isArray(out.brief.terminology)).toBe(true);
    expect(Array.isArray(out.warnings)).toBe(true);
  }, 120_000);

  it('returns a completed, parseable Responses result for the prepared_interview_output schema (raw probe)', async () => {
    // Mirror exactly what createProjectPreparer + createStreamingResponder send,
    // but inspect the RAW response so we can see status/incomplete/refusal/usage —
    // the fields the adapter collapses into a thrown error. This is the probe that
    // distinguishes an empty body, a refusal, an incomplete response, and an API
    // error when "prepare" misbehaves.
    const client = new OpenAI({ apiKey: KEY! });
    const system = fillTemplate(loadPromptBody('project-preparation.system'), {
      targetQuestionCount: String(PREPARE_INPUT.targetQuestionCount),
      titleOrInferred: PREPARE_INPUT.title!,
      audienceOrInferred: PREPARE_INPUT.audience!,
      intendedOutcomeOrInferred: PREPARE_INPUT.intendedOutcome!,
      toneOrDefault: PREPARE_INPUT.tone!,
      exclusionsOrNone: PREPARE_INPUT.exclusions.join('; '),
      compiledSource: PREPARE_INPUT.compiledSource,
    });

    const response = await client.responses.create({
      model: 'gpt-5.5',
      instructions: system,
      input: 'Prepare the interview plan for the project source above.',
      text: {
        format: {
          type: 'json_schema',
          name: 'prepared_interview_output',
          schema: preparedInterviewOutputJsonSchema,
          strict: true,
        },
      },
    });

    const refusal = findRefusal(response.output);
    // Print exactly what came back so a failing run is self-explanatory in the log.
    console.info(
      '[prepare raw probe]',
      JSON.stringify({
        status: response.status,
        incomplete: response.incomplete_details?.reason ?? null,
        error: response.error ?? null,
        outputTextChars: response.output_text?.length ?? 0,
        usage: response.usage ?? null,
        refusal,
      }),
    );

    expect(response.error, 'the API returned an error object').toBeNull();
    expect(refusal, 'the model returned a refusal instead of the plan').toBeNull();
    expect(
      response.incomplete_details?.reason ?? null,
      'the response was incomplete (e.g. max_output_tokens / content_filter)',
    ).toBeNull();
    expect(response.status).toBe('completed');
    expect(response.output_text.length, 'output_text was empty').toBeGreaterThan(0);

    const parsed = JSON.parse(response.output_text);
    expect(() => preparedInterviewOutputSchema.parse(parsed)).not.toThrow();
  }, 120_000);
});
