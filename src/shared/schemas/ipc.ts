import { z } from 'zod';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';

export const endpointModeSchema = z.enum(['manual', 'conservative', 'balanced']);
export const targetModeSchema = z.enum(['question_count', 'approximate_duration']);
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
  z.object({ type: z.literal('RETAKE_TURN') }),
  z.object({ type: z.literal('END_AFTER_TURN') }),
  z.object({ type: z.literal('END_NOW') }),
  z.object({ type: z.literal('RETRY_RECOVERY') }),
]);

export const saveProjectDocumentInputSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(PROJECT_SOURCE_LIMITS.maxTitleCharacters),
  originalFilename: z.string().max(PROJECT_SOURCE_LIMITS.maxOriginalFilenameCharacters).nullable().optional(),
  // New writes are Markdown-only; `text/plain` survives only for legacy reads
  // and is normalized to `text/markdown` by migration + read coercion.
  mimeType: z.literal('text/markdown'),
  // Content size is intentionally uncapped — the operator supplies their own
  // material and the app only reports counts, never enforces an upper bound.
  content: z.string(),
  sortOrder: z.number().int().nonnegative(),
});

/**
 * Cross-document invariants the per-field schema cannot express: unique document
 * IDs and a dense `0..n-1` sort order. Sources are equal, user-ordered peers —
 * there is no primary, and content size and document count are intentionally
 * uncapped. Main-process Zod validation is authoritative.
 */
function validateProjectSourceInvariants(
  input: { documents: Array<z.infer<typeof saveProjectDocumentInputSchema>> },
  ctx: z.RefinementCtx,
): void {
  const docs = input.documents;

  const ids = docs.map((d) => d.id).filter((id): id is string => typeof id === 'string');
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Document IDs must be unique.',
      path: ['documents'],
    });
  }

  const orders = docs.map((d) => d.sortOrder).sort((a, b) => a - b);
  const dense = orders.every((value, index) => value === index);
  if (!dense) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Document sort order must be dense (0..n-1) and unique.',
      path: ['documents'],
    });
  }
}

export const saveProjectInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).max(200),
    audience: z.string().nullable().optional(),
    intendedOutcome: z.string().nullable().optional(),
    targetMode: targetModeSchema,
    targetValue: z.number().int().positive(),
    interviewerCharacterId: z.string().min(1),
    notesToInterviewer: z.string().nullable().optional(),
    // At least one source; the count is otherwise uncapped — reported, never enforced.
    documents: z.array(saveProjectDocumentInputSchema).min(1),
  })
  .superRefine(validateProjectSourceInvariants);

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
  z.object({ type: z.literal('BEGIN') }),
  z.object({ type: z.literal('PAUSE') }),
  z.object({ type: z.literal('RESUME') }),
  z.object({ type: z.literal('REPEAT') }),
  z.object({ type: z.literal('SKIP') }),
  z.object({ type: z.literal('RETAKE') }),
  z.object({ type: z.literal('EXIT_STAGE') }),
  z.object({ type: z.literal('END_AFTER_TURN') }),
]);

export const openAudioPortInputSchema = z.object({
  sessionId: z.string(),
});
