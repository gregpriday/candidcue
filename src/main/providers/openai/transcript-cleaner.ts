import type { CleanTranscriptInput } from '@shared/contracts/adapters';
import type { TranscriptCleanupResult } from '@shared/domain';
import { transcriptCleanupResultSchema } from '@shared/schemas';

import { loadPromptBody, fillTemplate } from '../../prompts/prompt-loader';

import { transcriptCleanupResultJsonSchema } from './json-schemas';
import { parseStructured } from './parse';
import type { StructuredResponder } from './openai-client';

const PROMPT_NAME = 'transcript-cleanup.system';
const SCHEMA_NAME = 'transcript_cleanup_result';

/**
 * Build the `cleanTranscript` adapter method (spec §16.10). The glossary and raw
 * transcript are embedded in the system prompt; only the project glossary is
 * serialized as JSON so the model can apply canonical spellings when context
 * supports a match. The result is validated against the cleanup Zod schema.
 */
export function createTranscriptCleaner(responder: StructuredResponder) {
  return async function cleanTranscript(
    input: CleanTranscriptInput,
    signal?: AbortSignal,
  ): Promise<TranscriptCleanupResult> {
    const template = loadPromptBody(PROMPT_NAME);
    const system = fillTemplate(template, {
      glossaryJson: JSON.stringify(input.glossary),
      rawTranscript: input.rawTranscript,
    });

    const raw = await responder({
      model: input.modelId,
      system,
      user: 'Clean the raw transcript above using the project glossary.',
      schemaName: SCHEMA_NAME,
      schema: transcriptCleanupResultJsonSchema,
      ...(signal ? { signal } : {}),
    });

    return parseStructured(raw, transcriptCleanupResultSchema, 'cleanTranscript');
  };
}
