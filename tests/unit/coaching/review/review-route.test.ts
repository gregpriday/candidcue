/**
 * `Review.svelte`, rendered with `svelte/server`.
 *
 * This repo has no jsdom, so the component is written with all of its logic in
 * `shared/coaching/review` and only markup here — which is exactly what makes
 * these assertions meaningful. They check that the numbers computed and
 * formatted locally are the ones that reach the page, that an absent
 * measurement renders as a stated absence, and that a model response full of
 * invented figures changes nothing on screen.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Review from '../../../../src/control/routes/Review.svelte';
import { buildReviewModel } from '../../../../src/shared/coaching/review';
import { summarizeSession } from '../../../../src/shared/coaching/review/session-summary';
import { makeFiller, makePass, makeRecord, TEST_SCRIPT } from './support';

function text(html: string): string {
  return html
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const twelveFillerRecord = makeRecord([
  makePass({
    coveredSpanIds: ['span-a', 'span-b', 'span-c'],
    fillers: Array.from({ length: 12 }, (_, index) =>
      makeFiller({ atMs: 10_000 + index * 25_000, scriptAnchorTokenId: 't4' }),
    ),
    paceSamples: [
      { startMs: 0, endMs: 180_000, audibleWpm: 140, state: 'on_target' },
      { startMs: 180_000, endMs: 360_000, audibleWpm: 190, state: 'fast' },
    ],
  }),
]);

function renderModel(overrides: Parameters<typeof buildReviewModel>[0]): string {
  return render(Review, { props: { model: buildReviewModel(overrides) } }).body;
}

describe('§31.2 cards', () => {
  const html = renderModel({ record: twelveFillerRecord, script: TEST_SCRIPT });
  const flat = text(html);

  it('renders every card the specification lists', () => {
    for (const id of [
      'audible_wpm',
      'articulation_wpm',
      'time_in_target_pace',
      'projected_vs_actual',
      'fillers',
      'most_frequent_filler',
      'longest_filler_free',
      'variety',
      'terminal_rush',
      'cadence_events',
      'retakes',
      'critical_discrepancies',
      'microphone',
    ]) {
      expect(html).toContain(`data-card="${id}"`);
    }
  });

  it('shows the locally computed figures', () => {
    expect(flat).toContain('150 WPM');
    expect(flat).toContain('180 WPM');
    expect(flat).toContain('1.33 per 100 words');
    // 180 000 of 360 000 measured milliseconds inside 115–160 WPM.
    expect(flat).toContain('50%');
  });

  it('states an absence instead of printing a zero', () => {
    // Variety was never sampled here; no target duration was set either.
    expect(flat).toContain('Variety was never sampled during this take.');
    expect(flat).toContain('The take never had enough evidence to project a finish.');
    // The variety card shows no number at all — not a 0.
    expect(flat).not.toMatch(/Vocal variety\s+0\b/);
  });

  it('distinguishes "never sampled" from "pitch was unusable"', () => {
    const unusablePitch = renderModel({
      record: makeRecord([
        makePass({
          varietySamples: [
            {
              startMs: 0,
              endMs: 60_000,
              level: null,
              state: 'low_confidence',
              energyRangeDb: 8,
              pitchSpanSemitones: null,
            },
          ],
        }),
      ]),
      script: TEST_SCRIPT,
    });
    expect(text(unusablePitch)).toContain('Not enough usable pitch to score variety.');
  });
});

describe('§31.3 audio playback', () => {
  it('offers no playback and says why when the take was not recorded', () => {
    const html = renderModel({ record: twelveFillerRecord, script: TEST_SCRIPT });
    expect(text(html)).toContain('Audio playback is unavailable: this take was not recorded.');
    expect(html).not.toContain('Play the take');
  });

  it('offers playback only when a recording exists', () => {
    const html = renderModel({
      record: makeRecord([makePass()], {
        audio: { available: true, recordingId: 'rec-1', durationMs: 360_000 },
      }),
      script: TEST_SCRIPT,
    });
    expect(html).toContain('Play the take');
    expect(html).not.toContain('Audio playback is unavailable');
  });

  it('names the reason a kept recording is gone', () => {
    const html = renderModel({
      record: makeRecord([makePass()], {
        audio: { available: false, reason: 'consent_withdrawn' },
      }),
      script: TEST_SCRIPT,
    });
    expect(text(html)).toContain('Audio playback is unavailable: the recording was not kept.');
  });
});

describe('§31.4 script view', () => {
  const html = renderModel({ record: twelveFillerRecord, script: TEST_SCRIPT });

  it('renders the authored text exactly as authored', () => {
    for (const passage of TEST_SCRIPT.passages) {
      expect(text(html)).toContain(passage.text);
    }
  });

  it('renders annotations beside the text, labelled by take pass', () => {
    expect(html).toContain('data-span="span-b"');
    expect(text(html)).toContain('Take 1');
    expect(text(html)).toContain('“um”');
  });

  it('says so when the script is not available rather than showing nothing', () => {
    const withoutScript = renderModel({ record: twelveFillerRecord, script: null });
    expect(text(withoutScript)).toContain('The script for this take is not available.');
  });
});

describe('§31.5 recommendations', () => {
  it('shows the locally measured counts', () => {
    const html = renderModel({ record: twelveFillerRecord, script: TEST_SCRIPT });
    expect(text(html)).toContain(
      'You used 12 fillers in this take — 1.33 per 100 words. A silent pause is shorter than it feels.',
    );
  });

  it('renders none of a model response’s own figures', () => {
    const html = renderModel({
      record: twelveFillerRecord,
      script: TEST_SCRIPT,
      lunaSelection: {
        selections: [
          {
            pattern_id: 'FILLER_RATE',
            variant_id: 'default',
            text: 'You said um 47 times, which is 5.2 per 100 words.',
          },
        ],
        summary: 'Your average pace was 999 WPM.',
      },
    });
    const flat = text(html);
    expect(flat).toContain('You used 12 fillers in this take');
    expect(flat).not.toContain('47');
    expect(flat).not.toContain('999');
    expect(flat).not.toContain('5.2');
  });
});

describe('§31.6 comparison', () => {
  it('says there is nothing to compare with rather than inventing a baseline', () => {
    const html = renderModel({ record: twelveFillerRecord, script: TEST_SCRIPT });
    const flat = text(html);
    expect(flat).toContain('This is the first saved session for this script');
    expect(html).not.toContain('data-metric=');
  });

  it('shows trends once there is comparable history', () => {
    const prior = summarizeSession(
      makeRecord(
        [
          makePass({
            audibleWords: 900,
            fillers: Array.from({ length: 18 }, (_, i) => makeFiller({ atMs: 1_000 + i * 1_000 })),
          }),
        ],
        { sessionId: 'prior', startedAtIso: '2026-06-30T09:00:00.000Z' },
      ),
    );
    const html = renderModel({
      record: twelveFillerRecord,
      script: TEST_SCRIPT,
      priorSummaries: [prior],
    });
    expect(html).toContain('data-metric="filler_rate_per_100_words"');
    expect(text(html)).not.toContain('percentile');
  });
});

describe('§32.2 retention statement', () => {
  it('states exactly what is retained', () => {
    const html = renderModel({ record: twelveFillerRecord, script: TEST_SCRIPT });
    const flat = text(html);
    expect(flat).toContain('Your coaching measurements for this take are saved on this device.');
    expect(flat).toContain('The transcript is not saved');
    expect(flat).toContain('No audio is saved.');
  });
});

describe('timeline events', () => {
  it('renders a clickable tick per event, labelled with its take pass', () => {
    const html = renderModel({
      record: makeRecord([
        makePass({ takePassId: 'p1', passOrdinal: 1, startMs: 0, endMs: 50_000 }),
        makePass({
          takePassId: 'p2',
          passOrdinal: 2,
          startMs: 50_000,
          endMs: 100_000,
          fillers: [makeFiller({ atMs: 60_000, takePassId: 'p2' })],
        }),
      ]),
      script: TEST_SCRIPT,
    });
    expect(html).toContain('aria-label="“um” — Take 2"');
    expect(html).toContain('aria-label="Take 2 — Take 2"');
  });
});
