import type { GenerateNextActionInput } from '@shared/contracts/adapters';
import type { NextInterviewerAction } from '@shared/domain';
import { nextInterviewerActionSchema } from '@shared/schemas';

import { nextInterviewerActionJsonSchema } from './json-schemas';
import { parseStructured } from './parse';
import type { StructuredResponder } from './openai-client';

const SCHEMA_NAME = 'next_interviewer_action';

/**
 * Assemble the JSON user payload the interviewer model reasons over. The
 * character system prompt (Mira's persona + behavioral rules) is supplied by
 * the caller and used verbatim as the system instruction, so the payload here
 * carries only the per-turn state: the brief, live coverage, recent turns, the
 * current answer, and session-control flags (spec §16.6).
 */
function buildUserPayload(input: GenerateNextActionInput): string {
  return JSON.stringify({
    brief: input.brief,
    coverage: input.coverage,
    rollingSummary: input.rollingSummary,
    recentTurns: input.recentTurns,
    currentAnswer: input.currentAnswer,
    rawAnswerFallback: input.rawAnswerFallback,
    moderationGuidance: input.moderationGuidance,
    sessionControl: {
      nextOrdinal: input.nextOrdinal,
      targetQuestionCount: input.targetQuestionCount,
      endAfterTurn: input.endAfterTurn,
      currentSectionId: input.currentSectionId,
    },
  });
}

/**
 * Build the `generateNextAction` adapter method (spec §16.6). Uses the supplied
 * `characterSystemPrompt` as the system instruction and a JSON state payload as
 * the user input, then validates the model's structured action against the Zod
 * schema before returning the domain action.
 */
export function createInterviewer(responder: StructuredResponder) {
  return async function generateNextAction(
    input: GenerateNextActionInput,
    signal?: AbortSignal,
  ): Promise<NextInterviewerAction> {
    const raw = await responder({
      model: input.modelId,
      system: input.characterSystemPrompt,
      user: buildUserPayload(input),
      schemaName: SCHEMA_NAME,
      schema: nextInterviewerActionJsonSchema,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(signal ? { signal } : {}),
    });

    return parseStructured(raw, nextInterviewerActionSchema, 'generateNextAction');
  };
}
