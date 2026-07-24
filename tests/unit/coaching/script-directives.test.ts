/**
 * §19.4 / §19.5 — from the authored script to a suppressed candidate.
 *
 * `coachingDisabledSpanIds`, `suppressVarietyCoaching`, `authoredFastSection`
 * and `suppressSlowTip` were all wired through the orchestrator and could never
 * be true, because nothing parsed the directives that set them. Asserting that
 * they are now populated would prove almost nothing — the question is whether a
 * candidate that would otherwise exist stops existing.
 *
 * So every test in the second half drives the *real* orchestrator with the real
 * lanes, in a matched pair: an identical take with and without the directive.
 * The control half exists to prove the take genuinely produces the candidate,
 * which is the only thing that makes its absence in the other half meaningful.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown/compile';
import {
  applyCoachFrontMatter,
  resolveScriptDirectives,
} from '../../../src/shared/coaching/integration';
import type { CompiledScript } from '../../../src/shared/contracts';
import type { CoachingSettings } from '../../../src/shared/contracts/coaching';
import { TakeHarness, makeSettings, prose } from './integration/harness';
import {
  CoachingSessionController,
  type CoachingSessionDeps,
} from '../../../src/control/services/coaching-session';
import { defaultCoachingSettings } from '../../../src/control/lib/coaching-profiles';
import type { AudioFrameFeatures, CoachRailState } from '../../../src/shared/contracts/coaching';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The span ids are content hashes, so tests name spans by their text. */
function spanIdFor(compiled: CompiledScript, normalizedText: string): string {
  const sentence = compiled.sentences.find((s) => s.normalizedText === normalizedText);
  if (!sentence) {
    throw new Error(
      `no sentence "${normalizedText}"; have ${compiled.sentences
        .map((s) => `"${s.normalizedText}"`)
        .join(', ')}`,
    );
  }
  return sentence.id;
}

const SESSION_TARGETS: Pick<CoachingSettings, 'targetWpmLow' | 'targetWpmHigh'> = {
  targetWpmLow: 115,
  targetWpmHigh: 160,
};

/* ------------------------------------------------------------------ */
/* 1. Compiled directives resolve to the right host-state facts        */
/* ------------------------------------------------------------------ */

describe('§19.4 directives resolve against the session targets', () => {
  it('turns cc:coach off into a disabled span and nothing else', () => {
    const compiled = compile('<!-- cc:coach off -->\n\nThe disclaimer text.\n', {
      scriptId: 'd',
    });
    const spanId = spanIdFor(compiled, 'the disclaimer text');
    const map = resolveScriptDirectives(compiled.coaching, SESSION_TARGETS);
    expect([...map.coachingDisabledSpanIds]).toEqual([spanId]);
    expect([...map.suppressVarietySpanIds]).toEqual([]);
    expect([...map.authoredFastSpanIds]).toEqual([]);
    expect([...map.suppressSlowTipSpanIds]).toEqual([]);
  });

  it('reads an authored band above the session band as a fast section', () => {
    const compiled = compile('<!-- cc:pace 150-190 -->\n\nRattle through this.\n', {
      scriptId: 'd',
    });
    const spanId = spanIdFor(compiled, 'rattle through this');
    const map = resolveScriptDirectives(compiled.coaching, SESSION_TARGETS);
    expect([...map.authoredFastSpanIds]).toEqual([spanId]);
    // The author asked for a *fast* read, not a slow one: only one suppression.
    expect([...map.suppressSlowTipSpanIds]).toEqual([]);
  });

  it('reads a restrained authored style as slow plus variety suppression', () => {
    const compiled = compile('<!-- cc:style calm -->\n\nSaid slowly and evenly.\n', {
      scriptId: 'd',
    });
    const spanId = spanIdFor(compiled, 'said slowly and evenly');
    const map = resolveScriptDirectives(compiled.coaching, SESSION_TARGETS);
    // `calm` is 110-145 against a 115-160 session band: slower at the bottom,
    // not faster at the top, and restrained on variety.
    expect([...map.suppressSlowTipSpanIds]).toEqual([spanId]);
    expect([...map.suppressVarietySpanIds]).toEqual([spanId]);
    expect([...map.authoredFastSpanIds]).toEqual([]);
  });

  /**
   * §19.4's own example, and the honest answer: `125-145` sits *inside* a
   * 115-160 session band, so there is nothing to suppress. The directive is not
   * a no-op — its effect is conditional on the settings it is measured against,
   * and against a slower session band the same annotation does fire.
   */
  it('does nothing when the authored band sits inside the session band', () => {
    const compiled = compile('<!-- cc:pace 125-145 -->\n\nA measured stretch.\n', {
      scriptId: 'd',
    });
    const spanId = spanIdFor(compiled, 'a measured stretch');
    const inside = resolveScriptDirectives(compiled.coaching, SESSION_TARGETS);
    expect([...inside.authoredFastSpanIds]).toEqual([]);
    expect([...inside.suppressSlowTipSpanIds]).toEqual([]);

    const narrower = resolveScriptDirectives(compiled.coaching, {
      targetWpmLow: 130,
      targetWpmHigh: 145,
    });
    expect([...narrower.authoredFastSpanIds]).toEqual([spanId]);
    expect([...narrower.suppressSlowTipSpanIds]).toEqual([spanId]);
  });

  it('applies §19.5 front matter to the settings the session runs with', () => {
    const compiled = compile(
      [
        '---',
        'coach:',
        '  mode: studio',
        '  style: calm',
        '  target_wpm: [100, 130]',
        '  target_variety: [20, 50]',
        '  target_duration: "01:30"',
        '  live_tips: low',
        '  positive_feedback: true',
        '---',
        '',
        'Words for the take.',
        '',
      ].join('\n'),
      { scriptId: 'd' },
    );
    const settings = applyCoachFrontMatter(makeSettings(), compiled.coaching?.frontMatter);
    expect(settings.mode).toBe('studio');
    expect(settings.deliveryStyle).toBe('calm');
    expect(settings.targetWpmLow).toBe(100);
    expect(settings.targetWpmHigh).toBe(130);
    expect(settings.pacePreset).toBe('custom');
    expect(settings.targetVarietyLow).toBe(20);
    expect(settings.targetVarietyHigh).toBe(50);
    expect(settings.targetDurationSeconds).toBe(90);
    expect(settings.liveTipFrequency).toBe('low');
    expect(settings.positiveReinforcementEnabled).toBe(true);
    // Never settable from a script: one spends the user's API budget, the other
    // decides whether audio is retained.
    expect(settings.precisionTranscriptionMode).toBe(makeSettings().precisionTranscriptionMode);
    expect(settings.retainAudioRecordingEnabled).toBe(false);
  });

  it('leaves the settings untouched when there is no front matter', () => {
    const compiled = compile('Just words.\n', { scriptId: 'd' });
    const base = makeSettings();
    expect(applyCoachFrontMatter(base, compiled.coaching?.frontMatter)).toEqual(base);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The orchestrator actually stops producing coaching               */
/* ------------------------------------------------------------------ */

describe('§19.4 cc:coach off refuses candidates at the registry', () => {
  const script = '<!-- cc:coach off -->\n\nWe should start here now.\n';
  const compiled = compile(script, { scriptId: 'd' });
  const spanId = spanIdFor(compiled, 'we should start here now');
  const map = resolveScriptDirectives(compiled.coaching, SESSION_TARGETS);

  const runTake = (coachingDisabledSpanIds: ReadonlySet<string>) => {
    const harness = new TakeHarness({ host: { coachingDisabledSpanIds } });
    for (let index = 0; index < 3; index += 1) {
      harness.say('um we should start here', 2_000, { spanId });
    }
    return harness.orchestrator.telemetry().activeCandidates;
  };

  it('control: the same take does raise filler candidates for that span', () => {
    const candidates = runTake(new Set<string>());
    expect(candidates.map((c) => c.type)).toContain('filler_cluster');
    expect(candidates.every((c) => c.scriptSpanId === spanId)).toBe(true);
  });

  it('the directive refuses every candidate carrying that span', () => {
    expect(map.coachingDisabledSpanIds.has(spanId)).toBe(true);
    expect(runTake(map.coachingDisabledSpanIds)).toEqual([]);
  });

  it('refuses only the marked span, not the whole take', () => {
    const harness = new TakeHarness({ host: { coachingDisabledSpanIds: map.coachingDisabledSpanIds } });
    for (let index = 0; index < 3; index += 1) {
      harness.say('um we should start here', 2_000, { spanId: 'some-other-span' });
    }
    expect(
      harness.orchestrator.telemetry().activeCandidates.map((c) => c.type),
    ).toContain('filler_cluster');
  });
});

describe('§19.4 cc:pace marks a section as a deliberate fast read', () => {
  const compiled = compile('<!-- cc:pace 150-190 -->\n\nRattle through this.\n', {
    scriptId: 'd',
  });
  const spanId = spanIdFor(compiled, 'rattle through this');
  const map = resolveScriptDirectives(compiled.coaching, SESSION_TARGETS);

  const runFastTake = (authoredFastSection: boolean) => {
    const harness = new TakeHarness({ host: { activeScriptSpanId: spanId, authoredFastSection } });
    // ~300 WPM: comfortably past the 160 + 12 shoulder, held far longer than
    // the 4 s dwell and the 6 s tip persistence §14.8 requires.
    for (let index = 0; index < 8; index += 1) harness.say(prose(30), 6_000, { spanId });
    harness.orchestrator.tick();
    return harness.orchestrator.telemetry();
  };

  it('control: an unmarked fast read raises pace_too_fast', () => {
    const telemetry = runFastTake(false);
    expect(telemetry.pace.state).toBe('fast');
    expect(telemetry.activeCandidates.map((c) => c.type)).toContain('pace_too_fast');
  });

  it('the marked section still measures fast but never says so', () => {
    expect(map.authoredFastSpanIds.has(spanId)).toBe(true);
    const telemetry = runFastTake(true);
    // The measurement is untouched — §6.1 keeps analysing — only the tip is gone.
    expect(telemetry.pace.state).toBe('fast');
    expect(telemetry.activeCandidates.map((c) => c.type)).not.toContain('pace_too_fast');
  });
});

describe('§19.4 cc:style calm suppresses the "lift the pace" tip', () => {
  const compiled = compile('<!-- cc:style calm -->\n\nSaid slowly and evenly.\n', {
    scriptId: 'd',
  });
  const spanId = spanIdFor(compiled, 'said slowly and evenly');
  const map = resolveScriptDirectives(compiled.coaching, SESSION_TARGETS);

  const runSlowTake = (suppressSlowTip: boolean) => {
    const harness = new TakeHarness({ host: { activeScriptSpanId: spanId, suppressSlowTip } });
    // ~80 WPM against a 115 floor: slow, and held past the 5 s dwell.
    for (let index = 0; index < 8; index += 1) harness.say(prose(8), 6_000, { spanId });
    harness.orchestrator.tick();
    return harness.orchestrator.telemetry();
  };

  it('control: an unmarked slow read raises pace_too_slow', () => {
    const telemetry = runSlowTake(false);
    expect(telemetry.pace.state).toBe('slow');
    expect(telemetry.activeCandidates.map((c) => c.type)).toContain('pace_too_slow');
  });

  it('the calm section still measures slow but never says so', () => {
    expect(map.suppressSlowTipSpanIds.has(spanId)).toBe(true);
    const telemetry = runSlowTake(true);
    expect(telemetry.pace.state).toBe('slow');
    expect(telemetry.activeCandidates.map((c) => c.type)).not.toContain('pace_too_slow');
  });
});

describe('§19.4 cc:style calm suppresses variety coaching', () => {
  const compiled = compile('<!-- cc:style calm -->\n\nSaid slowly and evenly.\n', {
    scriptId: 'd',
  });
  const spanId = spanIdFor(compiled, 'said slowly and evenly');
  const map = resolveScriptDirectives(compiled.coaching, SESSION_TARGETS);

  const runFlatTake = (suppressVarietyCoaching: boolean) => {
    const harness = new TakeHarness({
      host: { activeScriptSpanId: spanId, completedSentences: 2, suppressVarietyCoaching },
    });
    // A dead-flat pitch and a dead-flat level, held past §17.10's 20 s sustain.
    for (let index = 0; index < 10; index += 1) {
      harness.speak(4_000, { f0Hz: 140, rmsDbfs: -20, peakDbfs: -10 });
      harness.orchestrator.setHostState({ completedSentences: index + 2 });
    }
    harness.orchestrator.tick();
    return harness.orchestrator.telemetry();
  };

  it('control: a flat delivery raises low_variety', () => {
    const telemetry = runFlatTake(false);
    expect(telemetry.variety.state).toBe('very_steady');
    expect(telemetry.activeCandidates.map((c) => c.type)).toContain('low_variety');
  });

  it('the calm section still measures very steady but never says so', () => {
    expect(map.suppressVarietySpanIds.has(spanId)).toBe(true);
    const telemetry = runFlatTake(true);
    expect(telemetry.variety.state).toBe('very_steady');
    expect(telemetry.activeCandidates.map((c) => c.type)).not.toContain('low_variety');
  });
});

/* ------------------------------------------------------------------ */
/* 3. The control-side controller carries it all the way               */
/* ------------------------------------------------------------------ */

const stream = {
  getAudioTracks: () => [{ kind: 'audio' }],
} as unknown as CoachingSessionDeps['stream'];

function speechFrame(audioTimeMs: number, speaking: boolean): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs: speaking ? -20 : -70,
    peakDbfs: speaking ? -10 : -60,
    clippingRatio: 0,
    noiseFloorDbfs: -70,
    estimatedSnrDb: speaking ? 25 : 2,
    speechProbability: speaking ? 0.92 : 0.02,
    voicedProbability: speaking ? 0.88 : 0,
    f0Hz: speaking ? 140 : null,
    f0Confidence: speaking ? 0.9 : 0,
    spectralFlux: speaking ? 0.4 : 0.02,
    zeroCrossingRate: 0.05,
    processorDropout: false,
  };
}

/** A controller wired to a fake analyzer, so the audio clock actually runs. */
function makeController(source: string, published: CoachRailState[] = []) {
  const compiled = compile(source, { scriptId: 'session-script' });
  let onFrames: ((frames: AudioFrameFeatures[]) => void) | null = null;
  const startAnalyzer = (async (options: { onFrames: (f: AudioFrameFeatures[]) => void }) => {
    onFrames = options.onFrames;
    return {
      sampleRate: 48_000,
      currentTimeMs: () => 0,
      clearBuffer: () => {},
      extract: async () => null,
      reset: () => {},
      close: async () => {},
      frameCount: 0,
      keepAliveInstalled: false,
    };
  }) as unknown as CoachingSessionDeps['startAnalyzer'];

  const controller = new CoachingSessionController({
    sessionId: '00000000-0000-0000-0000-000000000009',
    settings: defaultCoachingSettings(),
    compiled,
    stream,
    takePassId: 'take-1',
    publish: (state) => published.push(state),
    startAnalyzer,
  });

  let audioMs = 0;
  const pump = (durationMs: number, speaking: boolean) => {
    const until = audioMs + durationMs;
    for (; audioMs <= until; audioMs += 20) onFrames?.([speechFrame(audioMs, speaking)]);
  };

  /**
   * Speak, endpoint, then commit — the order a real session produces, because
   * a transcript lands after the VAD closes the run. Committing mid-run leaves
   * the detection uncorroborated and it never reaches `confirmed`.
   */
  const say = (spanId: string | null, transcript: string, itemId: string, sequence: number) => {
    controller.setTrackingState({ ...tracking, activeScriptSpanId: spanId });
    pump(2_600, true);
    pump(600, false);
    controller.noteFinalTranscript({ itemId, commitSequence: sequence, transcript });
    pump(400, false);
    controller.setTrackingState({ ...tracking, activeScriptSpanId: spanId });
  };

  return { compiled, controller, published, say, start: () => controller.start() };
}

const tracking = {
  tokenIndex: 4,
  alignmentConfidence: 0.9,
  reacquiring: false,
  commandActive: false,
  trackingEpoch: 0,
};

describe('the coaching session controller carries §19.4 into the live session', () => {
  it('publishes the disabled span set from the compiled script', async () => {
    const { compiled, controller } = makeController(
      'Coached opening line.\n\n<!-- cc:coach off -->\n\nThe disclaimer text.\n',
    );
    const disabled = spanIdFor(compiled, 'the disclaimer text');
    const coached = spanIdFor(compiled, 'coached opening line');
    expect([...controller.hostState().coachingDisabledSpanIds]).toEqual([disabled]);
    expect(controller.hostState().coachingDisabledSpanIds.has(coached)).toBe(false);
    await controller.dispose();
  });

  it('flips the per-span suppressions as the presenter moves through the script', async () => {
    const { compiled, controller } = makeController(
      [
        'An ordinary opening line.',
        '',
        '<!-- cc:style calm -->',
        '',
        'The calm passage runs here.',
        '',
        '<!-- cc:pace 150-190 -->',
        '',
        'The fast passage runs here.',
        '',
      ].join('\n'),
    );
    const ordinary = spanIdFor(compiled, 'an ordinary opening line');
    const calm = spanIdFor(compiled, 'the calm passage runs here');
    const fast = spanIdFor(compiled, 'the fast passage runs here');

    controller.setTrackingState({ ...tracking, activeScriptSpanId: ordinary });
    expect(controller.hostState().suppressVarietyCoaching).toBe(false);
    expect(controller.hostState().suppressSlowTip).toBe(false);
    expect(controller.hostState().authoredFastSection).toBe(false);

    controller.setTrackingState({ ...tracking, activeScriptSpanId: calm });
    expect(controller.hostState().suppressVarietyCoaching).toBe(true);
    expect(controller.hostState().suppressSlowTip).toBe(true);
    expect(controller.hostState().authoredFastSection).toBe(false);

    controller.setTrackingState({ ...tracking, activeScriptSpanId: fast });
    expect(controller.hostState().authoredFastSection).toBe(true);
    expect(controller.hostState().suppressVarietyCoaching).toBe(false);

    // Back to no span at all: every suppression drops, rather than sticking.
    controller.setTrackingState({ ...tracking, activeScriptSpanId: null });
    expect(controller.hostState().authoredFastSection).toBe(false);
    expect(controller.hostState().suppressSlowTip).toBe(false);
    await controller.dispose();
  });

  /**
   * The strongest end-to-end claim available at this layer: `cc:coach off`
   * reaches `AuthoredSpanContext.coachingDisabled`, and the disfluency lane
   * therefore never *creates* the event — as opposed to creating it and hiding
   * it, which would still put it in the post-take report.
   */
  it('stops the disfluency lane creating events inside an uncoached span', async () => {
    const source = 'Coached opening line.\n\n<!-- cc:coach off -->\n\nThe disclaimer text.\n';
    const { compiled, controller, say, start } = makeController(source);
    await start();
    const disabled = spanIdFor(compiled, 'the disclaimer text');
    const coached = spanIdFor(compiled, 'coached opening line');

    say(coached, 'so um we should start with the second section', 'item-1', 1);
    expect(controller.lastRailState()?.fillers.confirmedCount).toBe(1);

    say(disabled, 'um the disclaimer text follows here', 'item-2', 2);
    // Still 1: the second "um" was never turned into an event at all, so it is
    // absent from the post-take report as well as from the rail.
    expect(controller.lastRailState()?.fillers.confirmedCount).toBe(1);
    await controller.dispose();
  });

  it('treats fillers inside a cc:filler intentional span as authored delivery', async () => {
    const { compiled, controller, say, start } = makeController(
      '<!-- cc:filler intentional -->\n\nSo um the point is this.\n',
    );
    await start();
    const spanId = spanIdFor(compiled, 'so um the point is this');
    say(spanId, 'so um the point is this', 'item-1', 1);
    expect(controller.lastRailState()).not.toBeNull();
    // The event exists — it really was said — but is marked authored, so it is
    // never counted and never quoted back.
    expect(controller.lastRailState()?.fillers.confirmedCount).toBe(0);
    expect(
      controller.telemetry().activeCandidates.some((c) => c.type.startsWith('filler')),
    ).toBe(false);
    await controller.dispose();
  });

  it('control: the same filler without the directive is counted', async () => {
    const { compiled, controller, say, start } = makeController('So um the point is this.\n');
    await start();
    const spanId = spanIdFor(compiled, 'so um the point is this');
    say(spanId, 'so um the point is this', 'item-1', 1);
    expect(controller.lastRailState()?.fillers.confirmedCount).toBe(1);
    await controller.dispose();
  });

  it('runs the session on the settings the script asked for (§19.5)', async () => {
    const { controller } = makeController(
      [
        '---',
        'coach:',
        '  target_duration: "01:30"',
        '---',
        '',
        'Words for the take.',
        '',
      ].join('\n'),
    );
    // §14.10's target-duration status only exists because the front matter set
    // one; the persisted default is `null`.
    expect(defaultCoachingSettings().targetDurationSeconds).toBeNull();
    controller.setTrackingState({ ...tracking, activeScriptSpanId: null });
    expect(controller.lastRailState()?.pace.targetDurationMs).toBe(90_000);
    await controller.dispose();
  });
});
