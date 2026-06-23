import type {
  ClassifyEndpointInput,
  RepairQuestionInput,
} from '@shared/contracts/adapters';
import type { EndpointDecision } from '@shared/domain';
import { endpointDecisionSchema, questionRepairResultSchema } from '@shared/schemas';

import { loadPromptBody, fillTemplate } from '../../prompts/prompt-loader';

import {
  endpointDecisionJsonSchema,
  questionRepairResultJsonSchema,
} from './json-schemas';
import { parseStructured } from './parse';
import type { StructuredResponder } from './openai-client';

const ENDPOINT_PROMPT_NAME = 'endpoint-classifier.system';
const ENDPOINT_SCHEMA_NAME = 'endpoint_decision';

const REPAIR_PROMPT_NAME = 'question-repair.system';
const REPAIR_SCHEMA_NAME = 'question_repair_result';

/**
 * Build the `classifyEndpoint` adapter method (spec §14.4). The question,
 * transcript, durations, and mode are interpolated into the classifier prompt;
 * the structured decision is validated against the endpoint Zod schema.
 */
export function createEndpointClassifier(responder: StructuredResponder) {
  return async function classifyEndpoint(
    input: ClassifyEndpointInput,
    signal?: AbortSignal,
  ): Promise<EndpointDecision> {
    const template = loadPromptBody(ENDPOINT_PROMPT_NAME);
    const system = fillTemplate(template, {
      question: input.question,
      transcript: input.transcript,
      speechDurationMs: String(input.speechDurationMs),
      silenceDurationMs: String(input.silenceDurationMs),
      mode: input.mode,
    });

    const raw = await responder({
      model: input.modelId,
      system,
      user: 'Classify whether the speaker has completed their answer.',
      schemaName: ENDPOINT_SCHEMA_NAME,
      schema: endpointDecisionJsonSchema,
      ...(signal ? { signal } : {}),
    });

    return parseStructured(raw, endpointDecisionSchema, 'classifyEndpoint');
  };
}

/**
 * Build the `repairQuestion` adapter method (spec §16.14). Compresses an
 * over-budget interviewer question to fit its speaking limit without changing
 * what it asks. Returns only the repaired spoken text.
 */
export function createQuestionRepairer(responder: StructuredResponder) {
  return async function repairQuestion(
    input: RepairQuestionInput,
    signal?: AbortSignal,
  ): Promise<{ spokenText: string }> {
    const template = loadPromptBody(REPAIR_PROMPT_NAME);
    const system = fillTemplate(template, {
      spokenText: input.spokenText,
      maxWords: String(input.maxWords),
      reason: input.reason,
    });

    const raw = await responder({
      model: input.modelId,
      system,
      user: 'Compress the question to fit the word limit.',
      schemaName: REPAIR_SCHEMA_NAME,
      schema: questionRepairResultJsonSchema,
      ...(signal ? { signal } : {}),
    });

    const result = parseStructured(raw, questionRepairResultSchema, 'repairQuestion');
    return { spokenText: result.spokenText };
  };
}
