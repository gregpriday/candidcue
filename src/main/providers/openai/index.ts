import type OpenAI from 'openai';

import type {
  InterviewModelAdapter,
  ModerationAdapter,
} from '@shared/contracts/adapters';
import { MODEL_DEFAULTS } from '@shared/constants/runtime-defaults';

import { createProjectPreparer } from './project-preparer';
import { createInterviewer } from './interviewer';
import { createTranscriptCleaner } from './transcript-cleaner';
import {
  createEndpointClassifier,
  createQuestionRepairer,
} from './endpoint-classifier';
import { createModerationAdapter } from './moderation';
import {
  createDefaultResponder,
  createDefaultModerator,
  type StructuredResponder,
  type Moderator,
} from './openai-client';

export type {
  StructuredResponder,
  StructuredRequest,
  Moderator,
} from './openai-client';

/** Model selection the adapters need beyond the per-call `modelId` inputs. */
export interface OpenAiModelConfig {
  /** Model used for the moderation endpoint (omni-moderation by default). */
  moderationModel: string;
}

export interface OpenAiAdapterDeps {
  /** Structured-output responder (inject a fake in tests). */
  responder: StructuredResponder;
  /** Moderation runner (inject a fake in tests). */
  moderator: Moderator;
  /** Model configuration. */
  models: OpenAiModelConfig;
}

export interface OpenAiAdapters {
  model: InterviewModelAdapter;
  moderation: ModerationAdapter;
}

/**
 * Wire the OpenAI provider adapters (spec §19.2) from injected dependencies.
 * Each interview-model method builds its prompt, calls the `responder`, and
 * validates the result against the matching Zod schema; the moderation adapter
 * maps OpenAI moderation to a domain {@link ModerationAdapter}. All network
 * access is confined to the injected `responder` / `moderator`, keeping the
 * adapters fully testable with fakes.
 */
export function createOpenAiAdapters(deps: OpenAiAdapterDeps): OpenAiAdapters {
  const { responder, moderator, models } = deps;

  const model: InterviewModelAdapter = {
    prepareProject: createProjectPreparer(responder),
    generateNextAction: createInterviewer(responder),
    cleanTranscript: createTranscriptCleaner(responder),
    classifyEndpoint: createEndpointClassifier(responder),
    repairQuestion: createQuestionRepairer(responder),
  };

  const moderation = createModerationAdapter(moderator, models.moderationModel);

  return { model, moderation };
}

/**
 * Convenience factory that builds the adapters from a live OpenAI client using
 * the default Responses-API responder and moderation runner. The live SDK path
 * is intentionally not unit-tested.
 */
export function createOpenAiAdaptersFromClient(
  client: OpenAI,
  models: OpenAiModelConfig = { moderationModel: MODEL_DEFAULTS.moderationModel },
): OpenAiAdapters {
  return createOpenAiAdapters({
    responder: createDefaultResponder(client),
    moderator: createDefaultModerator(client, models.moderationModel),
    models,
  });
}
