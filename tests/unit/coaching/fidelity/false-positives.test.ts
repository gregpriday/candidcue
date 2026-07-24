/**
 * The false-positive corpus — the primary deliverable of this module.
 *
 * Every case below is a **correct** reading of the script in different words.
 * The comparator must produce zero candidates for all of them.
 *
 * Asserting "zero candidates" on its own would be worthless: a comparator that
 * returned `[]` unconditionally would pass this entire file. So every case also
 * asserts that the term under test reached the verdict `matched` — meaning the
 * comparator found the term, located the spoken window for it, and actively
 * decided the presenter got it right. A term that was silently skipped reports
 * `unknown` and fails the assertion.
 *
 * The companion true-positive suite is what proves the comparator can fire at
 * all; read the two together.
 */
import { describe, expect, it } from 'vitest';
import { compareSpanFidelity } from '../../../../src/shared/coaching/fidelity/comparator';
import type { CriticalTermKind } from '../../../../src/shared/coaching/fidelity/terms';
import { makeSpan, type SpanOptions } from './harness';

interface Case {
  name: string;
  script: string;
  spoken: string;
  /** The term kind that must reach `matched`. */
  kind: CriticalTermKind;
  options?: SpanOptions;
}

function run(testCase: Case): void {
  const result = compareSpanFidelity(makeSpan(testCase.script, testCase.spoken, testCase.options));
  const summary = result.verdicts
    .map((entry) => `${entry.term.kind}:${entry.term.authoredText}=${entry.verdict}`)
    .join(' | ');
  const matched = result.verdicts.some(
    (entry) => entry.term.kind === testCase.kind && entry.verdict === 'matched',
  );
  // A `true` here means the comparator located the term and actively decided
  // the presenter read it correctly. On failure the verdict summary is shown
  // instead, which distinguishes "never seen" from "judged wrong".
  expect(matched || summary).toBe(true);
  expect(result.candidates.map((candidate) => `${candidate.type}:${candidate.spokenFragment}`)).toEqual([]);
}

const NUMBER_CASES: Case[] = [
  {
    name: 'digits read as words: 50% / fifty percent',
    script: 'We grew 50% last year across every single market.',
    spoken: 'We grew fifty percent last year across every single market.',
    kind: 'number',
  },
  {
    name: 'words read as digits: fifty percent / 50%',
    script: 'We grew fifty percent last year across every single market.',
    spoken: 'We grew 50% last year across every single market.',
    kind: 'number',
  },
  {
    name: 'thousands separator read as a hundreds phrase: 1,500 / fifteen hundred',
    script: 'That is 1,500 customers signed up already this month.',
    spoken: 'That is fifteen hundred customers signed up already this month.',
    kind: 'number',
  },
  {
    name: 'thousands separator read in full: 1,500 / one thousand five hundred',
    script: 'That is 1,500 customers signed up already this month.',
    spoken: 'That is one thousand five hundred customers signed up already this month.',
    kind: 'number',
  },
  {
    name: 'year read as a pair: 2026 / twenty twenty-six',
    script: 'The rollout completes in 2026 for every remaining region.',
    spoken: 'The rollout completes in twenty twenty-six for every remaining region.',
    kind: 'number',
  },
  {
    name: 'year read in full: 2026 / two thousand and twenty six',
    script: 'The rollout completes in 2026 for every remaining region.',
    spoken: 'The rollout completes in two thousand and twenty six for every remaining region.',
    kind: 'number',
  },
  {
    name: 'year read digit by digit: 1984 / nineteen eighty four',
    script: 'The first edition appeared in 1984 and never went out of print.',
    spoken: 'The first edition appeared in nineteen eighty four and never went out of print.',
    kind: 'number',
  },
  {
    name: 'currency with a scale word: $1.5 million / one point five million dollars',
    script: 'The programme cost $1.5 million over the full three years.',
    spoken: 'The programme cost one point five million dollars over the full three years.',
    kind: 'number',
  },
  {
    name: 'currency with a half: $1.5 million / one and a half million dollars',
    script: 'The programme cost $1.5 million over the full three years.',
    spoken: 'The programme cost one and a half million dollars over the full three years.',
    kind: 'number',
  },
  {
    name: 'decimal read out: 3.14 / three point one four',
    script: 'Round the constant 3.14 before you show it on screen.',
    spoken: 'Round the constant three point one four before you show it on screen.',
    kind: 'number',
  },
  {
    name: 'hundred read with an article: 100 / a hundred',
    script: 'It took 100 hours to rebuild the index from scratch.',
    spoken: 'It took a hundred hours to rebuild the index from scratch.',
    kind: 'number',
  },
  {
    name: 'ordinal digits read as an ordinal word: 3rd / third',
    script: 'We finished 3rd in the regional standings again this season.',
    spoken: 'We finished third in the regional standings again this season.',
    kind: 'number',
  },
  {
    name: 'British "and": 250 / two hundred and fifty',
    script: 'Response time is 250 milliseconds on a warm cache today.',
    spoken: 'Response time is two hundred and fifty milliseconds on a warm cache today.',
    kind: 'number',
  },
  {
    name: 'large round value: 50 million / fifty million',
    script: 'The fund manages $50 million on behalf of its members.',
    spoken: 'The fund manages fifty million dollars on behalf of its members.',
    kind: 'number',
  },
];

const UNIT_CASES: Case[] = [
  {
    name: 'abbreviation read in full: ms / milliseconds',
    script: 'Latency dropped to 40 ms across the whole fleet last week.',
    spoken: 'Latency dropped to forty milliseconds across the whole fleet last week.',
    kind: 'unit',
  },
  {
    name: 'abbreviation read in full: kg / kilograms',
    script: 'The unit weighs 5 kg once the battery is installed.',
    spoken: 'The unit weighs five kilograms once the battery is installed.',
    kind: 'unit',
  },
  {
    name: 'percent sign read as the word',
    script: 'Adoption sits at 62% among the paid accounts this quarter.',
    spoken: 'Adoption sits at sixty two percent among the paid accounts this quarter.',
    kind: 'unit',
  },
];

const NAME_CASES: Case[] = [
  {
    name: 'surname split into a phonetic rendering: Ndlovu / and Lovu',
    script: 'Please welcome Ndlovu to the stage for the closing remarks.',
    spoken: 'Please welcome and Lovu to the stage for the closing remarks.',
    kind: 'name',
  },
  {
    name: 'surname respelled phonetically: Kowalczyk / Kovalchik',
    script: 'Ask Kowalczyk about the revised figures before the panel starts.',
    spoken: 'Ask Kovalchik about the revised figures before the panel starts.',
    kind: 'name',
  },
  {
    name: 'irish spelling rendered by sound: Siobhan / Shevaun',
    script: 'Thank you Siobhan for pulling those numbers together so quickly.',
    spoken: 'Thank you Shevaun for pulling those numbers together so quickly.',
    kind: 'name',
  },
  {
    name: 'compiler-flagged proper noun rendered phonetically',
    script: 'Our partner Nkemdirim confirmed the schedule earlier this morning.',
    spoken: 'Our partner Nkem Dirim confirmed the schedule earlier this morning.',
    kind: 'name',
    options: { properNouns: ['Nkemdirim'] },
  },
];

const NEGATION_CASES: Case[] = [
  {
    name: 'expansion read as a contraction: is not / isn’t',
    script: 'The data is not available yet for the second half of the year.',
    spoken: 'The data isn’t available yet for the second half of the year.',
    kind: 'negation',
  },
  {
    name: 'contraction read as an expansion: don’t / do not',
    script: 'We don’t ship on Fridays under any circumstances at all.',
    spoken: 'We do not ship on Fridays under any circumstances at all.',
    kind: 'negation',
  },
  {
    name: 'cannot read as can’t',
    script: 'We cannot confirm the launch date until the review completes.',
    spoken: 'We can’t confirm the launch date until the review completes.',
    kind: 'negation',
  },
  {
    name: 'negation carried by a prefix: not available / unavailable',
    script: 'The service is not available during the maintenance window tonight.',
    spoken: 'The service is unavailable during the maintenance window tonight.',
    kind: 'negation',
  },
  {
    name: 'never read as never, with words either side reworded',
    script: 'These figures never leave the finance team without approval first.',
    spoken: 'These figures never leave the finance team without approval first.',
    kind: 'negation',
  },
];

describe('critical-term comparator — false positives', () => {
  describe('numbers', () => {
    for (const testCase of NUMBER_CASES) {
      it(testCase.name, () => run(testCase));
    }
  });

  describe('units', () => {
    for (const testCase of UNIT_CASES) {
      it(testCase.name, () => run(testCase));
    }
  });

  describe('names', () => {
    for (const testCase of NAME_CASES) {
      it(testCase.name, () => run(testCase));
    }
  });

  describe('negations', () => {
    for (const testCase of NEGATION_CASES) {
      it(testCase.name, () => run(testCase));
    }
  });

  describe('adversarial deliveries that are still correct', () => {
    const ADVERSARIAL: Case[] = [
      {
        name: 'a filler sits between the presenter and the number',
        script: 'We grew 50% last year across every single market.',
        spoken: 'We grew, uh, fifty percent last year across every single market.',
        kind: 'number',
      },
      {
        name: 'the presenter stutters into the number',
        script: 'We grew 50% last year across every single market.',
        spoken: 'We grew fif fifty percent last year across every single market.',
        kind: 'number',
      },
      {
        name: 'the presenter repeats the number',
        script: 'We grew 50% last year across every single market.',
        spoken: 'We grew fifty fifty percent last year across every single market.',
        kind: 'number',
      },
      {
        name: 'the same value appears twice in the sentence',
        script: 'We grew 50% in 2024 and 50% again in 2025 across the group.',
        spoken:
          'We grew fifty percent in twenty twenty-four and fifty percent again in twenty twenty-five across the group.',
        kind: 'number',
      },
      {
        name: 'a unit abbreviation is read with the number spelled out',
        script: 'The file is 120 MB once the assets are bundled together.',
        spoken: 'The file is one hundred and twenty megabytes once the assets are bundled together.',
        kind: 'unit',
      },
      {
        name: 'a nearby word is mis-transcribed but the term is correct',
        script: 'Latency dropped to 40 ms across the whole fleet last week.',
        spoken: 'Latency dropped to forty milliseconds across the hole fleet last week.',
        kind: 'unit',
      },
    ];
    for (const testCase of ADVERSARIAL) {
      it(testCase.name, () => run(testCase));
    }

    it('does not treat a sentence-initial capital as a name', () => {
      const result = compareSpanFidelity(
        makeSpan(
          'Revenue grew steadily across the year in every single market.',
          'Revenue grew steadily across the year in every single market.',
        ),
      );
      expect(result.verdicts.filter((entry) => entry.term.kind === 'name')).toEqual([]);
      expect(result.candidates).toEqual([]);
    });

    it('stays silent when a negated clause was reworded rather than dropped', () => {
      // "not final" read as "still preliminary" preserves the meaning exactly.
      // Whether a rewording keeps the negation is a semantic judgement, and
      // §25.5 gives that to Luna — so the honest local answer is "unknown",
      // not an alert.
      const script = 'The results are not final at this stage of the review.';
      const spoken = 'The results are still preliminary at this stage of the review.';
      const result = compareSpanFidelity(makeSpan(script, spoken));
      expect(result.candidates).toEqual([]);
      expect(
        result.verdicts.filter((entry) => entry.term.kind === 'negation').map((e) => e.verdict),
      ).toEqual(['unknown']);
    });

    it('still reports a negation replaced only by a filler', () => {
      // Control for the rule above: "uh" is not a rewording, it is a gap.
      const result = compareSpanFidelity(
        makeSpan(
          'The results are not final at this stage of the review.',
          'The results are uh final at this stage of the review.',
        ),
      );
      expect(result.candidates.map((candidate) => candidate.detailCode)).toEqual([
        'negation_dropped',
      ]);
    });

    it('does not treat a bare "one" as a checkable quantity', () => {
      // "one" here is a pronoun; a comparator that checked it would fire the
      // moment the presenter said "a customer" instead.
      const result = compareSpanFidelity(
        makeSpan(
          'That is one of the biggest changes we have shipped this year.',
          'That is a customer facing change we have shipped this year.',
        ),
      );
      expect(
        result.verdicts.filter((entry) => entry.term.kind === 'number').map((e) => e.term.authoredText),
      ).toEqual([]);
      expect(result.candidates).toEqual([]);
    });
  });

  it('reports nothing at all when the span disables coaching (§19.4)', () => {
    const result = compareSpanFidelity(
      makeSpan(
        'We grew 50% last year across every single market.',
        'We grew fifteen percent last year across every single market.',
        { coachingDisabled: true },
      ),
    );
    expect(result.candidates).toEqual([]);
    expect(result.verdicts).toEqual([]);
  });
});
