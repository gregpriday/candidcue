import { describe, it, expect } from 'vitest';
import { buildOpenAiAdapters } from '@main/providers/factory';

/**
 * Opt-in contract test (spec §24.1.3). Skipped unless OPENAI_API_KEY is set, so
 * CI never spends tokens by default. Run with:
 *   OPENAI_API_KEY=sk-... npm run test:providers
 */
const KEY = process.env.OPENAI_API_KEY;

describe.skipIf(!KEY)('OpenAI provider contract', () => {
  it('moderation endpoint returns a structured verdict', async () => {
    const { moderation } = buildOpenAiAdapters(KEY!);
    const record = await moderation.moderate('A friendly hello.');
    expect(typeof record.flagged).toBe('boolean');
    expect(record.modelId).toBeTruthy();
    expect(['allow', 'allow_sensitive', 'redirect', 'error']).toContain(record.decision);
  });

  it('prepares a tiny interview plan', async () => {
    const { model } = buildOpenAiAdapters(KEY!);
    const out = await model.prepareProject({
      compiledSource:
        '<CANDIDCUE_PROJECT_SOURCE version="1"><DOCUMENT id="d1" title="Topic">1| We make a desktop interview app.</DOCUMENT></CANDIDCUE_PROJECT_SOURCE>',
      targetQuestionCount: 5,
      tone: null,
      exclusions: [],
      modelId: 'gpt-5.5',
    });
    expect(out.brief.coverageItems.length).toBeGreaterThan(0);
    expect(out.brief.openingQuestion.text).toMatch(/\?$/);
  });
});
