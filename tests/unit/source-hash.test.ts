import { describe, it, expect } from 'vitest';

import { hashProjectPreparation, type PreparationSettings, type PreparationDocument } from '@shared/utils';

const SETTINGS: PreparationSettings = {
  title: 'Shipping CandidCue',
  audience: 'indie founders',
  intendedOutcome: 'a candid build story',
  targetMode: 'question_count',
  targetValue: 8,
  interviewerCharacterId: 'mira',
  notesToInterviewer: 'Keep it warm.',
};

const DOCS: PreparationDocument[] = [
  { id: 'd1', title: 'Brief', mimeType: 'text/markdown', content: '# Story', sortOrder: 0 },
  { id: 'd2', title: 'Notes', mimeType: 'text/markdown', content: 'Details', sortOrder: 1 },
];

function hashWith(overrides: Partial<PreparationSettings>): string {
  return hashProjectPreparation({ ...SETTINGS, ...overrides }, DOCS);
}

describe('hashProjectPreparation', () => {
  it('is deterministic for identical inputs', () => {
    expect(hashWith({})).toBe(hashWith({}));
    expect(hashWith({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the interview title changes (regression: title must be hashed)', () => {
    expect(hashWith({ title: 'A different title' })).not.toBe(hashWith({}));
  });

  it('changes when the intended outcome changes', () => {
    expect(hashWith({ intendedOutcome: 'a different outcome' })).not.toBe(hashWith({}));
  });

  it('changes when the audience changes', () => {
    expect(hashWith({ audience: 'a different audience' })).not.toBe(hashWith({}));
  });

  it('changes when interviewer notes change', () => {
    expect(hashWith({ notesToInterviewer: 'Be playful.' })).not.toBe(hashWith({}));
  });

  it('treats a null title distinctly from an empty/placeholder string', () => {
    expect(hashWith({ title: null })).not.toBe(hashWith({ title: 'x' }));
  });

  it('is independent of the document array order (sorted by sortOrder, then id)', () => {
    const forward = hashProjectPreparation(SETTINGS, DOCS);
    const reversed = hashProjectPreparation(SETTINGS, [...DOCS].reverse());
    expect(forward).toBe(reversed);
  });
});
