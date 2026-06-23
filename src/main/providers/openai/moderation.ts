import type { ModerationAdapter } from '@shared/contracts/adapters';
import type { ModerationRecord } from '@shared/domain';

import type { Moderator } from './openai-client';

/**
 * Build the {@link ModerationAdapter} (spec §16.11). Runs the supplied
 * {@link Moderator} over `text` and maps the raw OpenAI moderation result to a
 * domain {@link ModerationRecord}: `flagged` content is routed to a `redirect`
 * decision, clean content to `allow`. The orchestrator owns any escalation to
 * `allow_sensitive`; this adapter only produces the binary outcome.
 */
export function createModerationAdapter(moderator: Moderator, modelId: string): ModerationAdapter {
  return {
    async moderate(text: string, signal?: AbortSignal): Promise<ModerationRecord> {
      const result = await moderator(text, signal);
      return {
        modelId,
        flagged: result.flagged,
        categories: result.categories,
        categoryScores: result.category_scores,
        decision: result.flagged ? 'redirect' : 'allow',
      };
    },
  };
}
