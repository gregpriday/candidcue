import type { ModerationAdapter } from '@shared/contracts/adapters';
import type { ModerationRecord } from '@shared/domain';

import { throwIfAborted, delay } from './abort';

/** Knobs for {@link FakeModeration}. */
export interface FakeModerationConfig {
  /**
   * Case-insensitive substrings that, when present in the moderated text, cause
   * the record to be flagged. Default: empty (everything is allowed).
   */
  triggers?: string[];
  /** Category reported (and scored 0.99) when a trigger matches. */
  flaggedCategory?: string;
  /** Decision returned when a trigger matches. Default 'redirect'. */
  flaggedDecision?: ModerationRecord['decision'];
  /** Model id recorded on every result. */
  modelId?: string;
  /** Artificial latency (ms) applied to each call. Default 0. */
  delayMs?: number;
}

/**
 * Deterministic stand-in for the OpenAI moderation adapter. Allows all text by
 * default and only flags input containing a configured trigger word, so tests
 * can drive the moderation-redirect path on demand.
 */
export class FakeModeration implements ModerationAdapter {
  private readonly triggers: string[];
  private readonly flaggedCategory: string;
  private readonly flaggedDecision: ModerationRecord['decision'];
  private readonly modelId: string;
  private readonly delayMs: number;

  /** Texts seen so far, for test assertions. */
  public readonly seen: string[] = [];

  constructor(config: FakeModerationConfig = {}) {
    this.triggers = (config.triggers ?? []).map((t) => t.toLowerCase());
    this.flaggedCategory = config.flaggedCategory ?? 'harassment';
    this.flaggedDecision = config.flaggedDecision ?? 'redirect';
    this.modelId = config.modelId ?? 'fake-moderation';
    this.delayMs = config.delayMs ?? 0;
  }

  async moderate(text: string, signal?: AbortSignal): Promise<ModerationRecord> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);

    this.seen.push(text);
    const haystack = text.toLowerCase();
    const matched = this.triggers.find((t) => t.length > 0 && haystack.includes(t));

    if (matched === undefined) {
      return {
        modelId: this.modelId,
        flagged: false,
        categories: {},
        categoryScores: {},
        decision: 'allow',
      };
    }

    return {
      modelId: this.modelId,
      flagged: true,
      categories: { [this.flaggedCategory]: true },
      categoryScores: { [this.flaggedCategory]: 0.99 },
      decision: this.flaggedDecision,
    };
  }
}
