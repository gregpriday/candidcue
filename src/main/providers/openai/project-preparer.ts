import type { PrepareProjectInput } from '@shared/contracts/adapters';
import type { PreparedInterviewOutput } from '@shared/domain';
import { preparedInterviewOutputSchema } from '@shared/schemas';

import { loadPromptBody, fillTemplate } from '../../prompts/prompt-loader';

import { preparedInterviewOutputJsonSchema } from './json-schemas';
import { parseStructured } from './parse';
import type { StructuredResponder } from './openai-client';

const PROMPT_NAME = 'project-preparation.system';
const SCHEMA_NAME = 'prepared_interview_output';

/**
 * Build the `prepareProject` adapter method (spec §16.4). The project
 * preparation prompt embeds the developer configuration and compiled source as
 * the system instruction; the user payload is a short directive so the model
 * acts on the configured source. Output is validated against the prepared
 * interview Zod schema before being returned as the domain type.
 */
export function createProjectPreparer(responder: StructuredResponder) {
  return async function prepareProject(
    input: PrepareProjectInput,
    signal?: AbortSignal,
  ): Promise<PreparedInterviewOutput> {
    const template = loadPromptBody(PROMPT_NAME);
    const system = fillTemplate(template, {
      targetQuestionCount: String(input.targetQuestionCount),
      toneOrDefault: input.tone ?? 'default (warm, curious, professional)',
      exclusionsOrNone: input.exclusions.length > 0 ? input.exclusions.join('; ') : 'none',
      compiledSource: input.compiledSource,
    });

    const raw = await responder({
      model: input.modelId,
      system,
      user: 'Prepare the interview plan for the project source above.',
      schemaName: SCHEMA_NAME,
      schema: preparedInterviewOutputJsonSchema,
      ...(signal ? { signal } : {}),
    });

    return parseStructured(raw, preparedInterviewOutputSchema, 'prepareProject');
  };
}
