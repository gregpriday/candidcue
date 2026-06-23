import { z } from 'zod';

export const endpointModeSchema = z.enum(['manual', 'conservative', 'balanced']);
export const targetModeSchema = z.enum(['question_count', 'approximate_duration']);
export const documentKindSchema = z.enum(['primary', 'reference']);
export const documentMimeSchema = z.enum(['text/markdown', 'text/plain']);

export const preflightConfigSchema = z.object({
  endpointMode: endpointModeSchema,
  selectedInputDeviceId: z.string().nullable(),
  selectedOutputDeviceId: z.string().nullable(),
  selectedDisplayId: z.string().nullable(),
  captionsEnabled: z.boolean(),
  mirrorStage: z.boolean(),
  zoom: z.number().min(0.5).max(2),
  verticalOffsetPercent: z.number().min(-50).max(50),
});

export const sessionCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PREPARE_SESSION'), projectId: z.string(), config: preflightConfigSchema }),
  z.object({ type: z.literal('BEGIN_SESSION') }),
  z.object({ type: z.literal('COMMIT_USER_TURN'), reason: z.enum(['manual', 'automatic']) }),
  z.object({ type: z.literal('PAUSE_SESSION') }),
  z.object({ type: z.literal('RESUME_SESSION') }),
  z.object({ type: z.literal('REPEAT_QUESTION') }),
  z.object({ type: z.literal('SKIP_QUESTION') }),
  z.object({ type: z.literal('END_AFTER_TURN') }),
  z.object({ type: z.literal('END_NOW') }),
  z.object({ type: z.literal('RETRY_RECOVERY') }),
]);

export const saveProjectDocumentInputSchema = z.object({
  id: z.string().optional(),
  kind: documentKindSchema,
  title: z.string().min(1).max(200),
  originalFilename: z.string().nullable().optional(),
  mimeType: documentMimeSchema,
  content: z.string().max(200_000),
  sortOrder: z.number().int().nonnegative(),
});

export const saveProjectInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(200),
  audience: z.string().nullable().optional(),
  intendedOutcome: z.string().nullable().optional(),
  targetMode: targetModeSchema,
  targetValue: z.number().int().positive(),
  interviewerCharacterId: z.string().min(1),
  notesToInterviewer: z.string().nullable().optional(),
  documents: z.array(saveProjectDocumentInputSchema).min(1),
});

export const providerCredentialInputSchema = z.object({
  openaiApiKey: z.string().optional(),
  inworldApiKey: z.string().optional(),
});

export const providerNameSchema = z.enum(['openai', 'inworld']);

export const exportFormatSchema = z.enum(['markdown', 'json']);

export const setDisplaySchema = z.object({ displayId: z.string() });

export const prepareSessionInputSchema = z.object({
  projectId: z.string(),
  config: preflightConfigSchema,
});

export const audioMeterSchema = z.object({
  peak: z.number(),
  average: z.number(),
  clipping: z.boolean(),
});

export const stageCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('COMMIT'), reason: z.enum(['manual', 'automatic']) }),
  z.object({ type: z.literal('PAUSE') }),
  z.object({ type: z.literal('RESUME') }),
  z.object({ type: z.literal('REPEAT') }),
  z.object({ type: z.literal('SKIP') }),
  z.object({ type: z.literal('EXIT_STAGE') }),
]);

export const openAudioPortInputSchema = z.object({
  sessionId: z.string(),
});
