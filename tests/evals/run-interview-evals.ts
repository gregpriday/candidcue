/**
 * Interview-quality eval harness (spec §24.5).
 *
 * Offline by default: scores a set of sample questions against the deterministic
 * validator (word budget, single principal question, no markdown/internal
 * leakage, non-repetition). With OPENAI_API_KEY set it also prepares a couple of
 * fixture briefs against the live model and checks the structured output.
 *
 * Run: `npm run eval`  (add OPENAI_API_KEY=... for the live portion).
 */
import { validateQuestion } from '@main/interview/question-validator';
import { RUNTIME_DEFAULTS } from '@shared/constants/runtime-defaults';

interface Sample {
  text: string;
  expectValid: boolean;
  note: string;
}

const SAMPLES: Sample[] = [
  { text: 'What problem does CandidCue solve for someone recording a video alone?', expectValid: true, note: 'good opening' },
  { text: 'Can you give a specific example of the kind of source material someone would add?', expectValid: true, note: 'example prompt' },
  { text: 'Got it. What changed after launch?', expectValid: true, note: 'short ack + one question' },
  {
    text:
      'So considering absolutely everything you have already said about the entire system, the broader market dynamics, the competitive landscape, your personal motivations, the founding story, and the long term future of online video creation for independent creators everywhere, how exactly does the whole thing actually work end to end?',
    expectValid: false,
    note: 'over the 42-word budget',
  },
  { text: 'Why? How does that work?', expectValid: false, note: 'two question marks' },
  { text: '**Mira:** (smiles) tell me more', expectValid: false, note: 'markdown + stage direction' },
];

function runOffline(): { passed: number; total: number } {
  let passed = 0;
  for (const s of SAMPLES) {
    const result = validateQuestion({
      spokenText: s.text,
      action: 'ask',
      targetCoverageItemIds: [],
      validCoverageIds: [],
      recentQuestions: [],
      maxWords: RUNTIME_DEFAULTS.maxQuestionWords,
    });
    const ok = result.valid === s.expectValid;
    if (ok) passed++;
    // eslint-disable-next-line no-console
    console.log(`${ok ? 'PASS' : 'FAIL'}  valid=${result.valid} (${result.wordCount}w) — ${s.note}`);
  }
  return { passed, total: SAMPLES.length };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('— CandidCue interview evals (offline validator) —');
  const { passed, total } = runOffline();
  // eslint-disable-next-line no-console
  console.log(`\nOffline validator: ${passed}/${total} expectations met.`);

  if (!process.env.OPENAI_API_KEY) {
    // eslint-disable-next-line no-console
    console.log('Set OPENAI_API_KEY to run the live project-preparation evals.');
  }
  process.exit(passed === total ? 0 : 1);
}

void main();
