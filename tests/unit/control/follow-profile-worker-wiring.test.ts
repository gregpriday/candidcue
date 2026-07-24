/**
 * The user's §47 follow profile reaches the TRACKING WORKER, not just the stage
 * (companion §47.1, §55).
 *
 * Following has two halves. The stage owns the motion limits the text is moved
 * through; the worker owns the prediction horizons, the voice lead, and
 * `catchUpMultiplier` that decide WHERE it is being moved to. `buildStageEnvelope`
 * has resolved the user's settings into a `SmoothFollowProfile` for a while; the
 * worker was still being initialized without one, so it ran
 * `DEFAULT_SMOOTH_FOLLOW_PROFILE` no matter what the user chose. Calm limits on
 * the glass, Balanced horizons underneath, and nothing on either side able to
 * notice.
 *
 * These tests deliberately do not stop at "the message carried a field". Each
 * one builds the engine EXACTLY as `src/workers/tracking.worker.ts` does from
 * the posted `initialize` — same four arguments, same order — and then asserts a
 * profile-dependent output actually changed.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  createWorkerTrackingDriver,
  setTrackingWorkerFactoryForTesting,
  type TrackingWorkerLike,
} from '../../../src/control/services/session';
import {
  defaultFollowingSettings,
  resolveFollowProfile,
  type FollowingSettings,
} from '../../../src/control/lib/follow-profiles';
import { compile } from '../../../src/shared/markdown';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts/smooth-follow';
import type { SemanticMotionFrame } from '../../../src/shared/contracts/smooth-follow';
import type { TrackingWorkerInbound } from '../../../src/shared/tracking/worker-protocol';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

const SOURCE = `# Opening

Welcome back to the workshop where we build things that actually ship.
Today we are walking through the three decisions that matter most.

The first decision is about scope, and it is the one everybody gets wrong.
The second decision is about sequencing, which is quieter but just as costly.
`;

type InitializeMessage = Extract<TrackingWorkerInbound, { type: 'initialize' }>;

class FakeWorker implements TrackingWorkerLike {
  posted: TrackingWorkerInbound[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message as TrackingWorkerInbound);
  }
  addEventListener(): void {}
  terminate(): void {}
}

afterEach(() => {
  setTrackingWorkerFactoryForTesting(null);
});

function following(overrides: Partial<FollowingSettings> = {}): FollowingSettings {
  return { ...defaultFollowingSettings(), ...overrides };
}

/** Stand up the driver and return the `initialize` it posted. */
function initializeFor(settings?: FollowingSettings): InitializeMessage {
  const compiled = compile(SOURCE, { scriptId: 'script-follow' });
  const worker = new FakeWorker();
  setTrackingWorkerFactoryForTesting(() => worker);
  createWorkerTrackingDriver({
    sessionId: 'session-follow',
    scriptId: 'script-follow',
    sentences: compiled.sentences,
    totalTokens: compiled.spokenTokens.length,
    compiled,
    sessionGeneration: 1,
    stageGeneration: 1,
    ...(settings ? { following: settings } : {}),
    onSnapshot: () => {},
    onTranscript: () => {},
  });
  setTrackingWorkerFactoryForTesting(null);
  const init = worker.posted[0] as InitializeMessage;
  expect(init.type).toBe('initialize');
  return init;
}

/**
 * Build the engine the way the real worker builds it. If this ever drifts from
 * `src/workers/tracking.worker.ts`, these tests stop meaning what they claim —
 * so it is one function, used by every case.
 */
function engineFromInitialize(init: InitializeMessage): AlignmentEngine {
  return new AlignmentEngine(init.document, init.session, init.profile, init.smoothProfile);
}

/**
 * Read the same script through an engine and return the last motion frame.
 * Both halves of a comparison get the identical event stream from an identically
 * seeded scripter, so any difference in the result is the profile.
 */
function readThrough(engine: AlignmentEngine): SemanticMotionFrame {
  const scripter = new TranscriptScripter(10_000, 1);
  const frames: SemanticMotionFrame[] = [];
  const turns = [
    'Welcome back to the workshop where we build things that actually ship',
    'Today we are walking through the three decisions that matter most',
    'The first decision is about scope and it is the one everybody gets wrong',
  ];
  for (const text of turns) {
    for (const event of scripter.speak({ text })) {
      const output = engine.handleTranscriptEvent(event);
      if (output.frame) frames.push(output.frame);
    }
  }
  const last = frames.at(-1);
  expect(last).toBeDefined();
  return last!;
}

describe('§47 follow profile → tracking worker (companion §55)', () => {
  it('sends the resolved profile, not an empty one', () => {
    const init = initializeFor(following({ feel: 'responsive', voiceLead: 'more' }));
    expect(init.smoothProfile).toEqual(
      resolveFollowProfile(following({ feel: 'responsive', voiceLead: 'more' })),
    );
    // The wire must not be carrying the default under a chosen setting.
    expect(init.smoothProfile?.prediction?.normalHorizonMs).not.toBe(
      DEFAULT_SMOOTH_FOLLOW_PROFILE.prediction.normalHorizonMs,
    );
  });

  it('the engine APPLIES it: horizons, lead and catch-up all change', () => {
    const calm = engineFromInitialize(initializeFor(following({ feel: 'calm' })));
    const responsive = engineFromInitialize(initializeFor(following({ feel: 'responsive' })));

    // Prediction horizons (engine.ts integrate/coast) — Calm coasts longer.
    expect(calm.smoothProfile.prediction.uncertainHorizonMs).toBeGreaterThan(
      responsive.smoothProfile.prediction.uncertainHorizonMs,
    );
    // Catch-up multiplier (semantic-filter velocity schedule).
    expect(responsive.smoothProfile.motion.catchUpMultiplier).toBeGreaterThan(
      calm.smoothProfile.motion.catchUpMultiplier,
    );
    // §47.1 safety: a feel never touches alignment. Beam width, retake
    // persistence and the semantic influence bound are identical to the default
    // on BOTH sides — the sidecar clamps against that same number.
    for (const engine of [calm, responsive]) {
      expect(engine.smoothProfile.alignment).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE.alignment);
    }
  });

  it('voice lead changes where the frame says the presenter is (behaviour, not plumbing)', () => {
    const less = readThrough(engineFromInitialize(initializeFor(following({ voiceLead: 'less' }))));
    const more = readThrough(engineFromInitialize(initializeFor(following({ voiceLead: 'more' }))));

    // Identical transcript, identical clock, identical document. `estimatedUnit`
    // is `position + leadUnits(confidence)` and `leadUnits` reads
    // `prediction.leadSeconds{Min,Max}` — the only thing voice lead touches.
    expect(more.estimatedUnit).toBeGreaterThan(less.estimatedUnit);
    // The committed position is untouched: §47.3 promises lead never changes
    // where you are matched.
    expect(more.committedUnit).toBe(less.committedUnit);
  });

  it('frames are attributable — motionProfileId names the profile in force', () => {
    const chosen = following({ feel: 'responsive', voiceLead: 'more' });
    const frame = readThrough(engineFromInitialize(initializeFor(chosen)));
    expect(frame.motionProfileId).toBe(resolveFollowProfile(chosen).id);
    expect(frame.motionProfileId).not.toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE.id);

    // Balanced/balanced is the identity, and keeps the family id.
    const plain = readThrough(engineFromInitialize(initializeFor(following())));
    expect(plain.motionProfileId).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE.id);
  });

  it('survives a re-initialize: the second engine runs the same profile', () => {
    const chosen = following({ feel: 'calm', voiceLead: 'less' });
    const init = initializeFor(chosen);
    // The worker keeps no state across `initialize`; it rebuilds the engine from
    // the message. Rebuilding twice from the same message must produce the same
    // profile, so a re-initialize can never silently drop back to the default.
    const first = engineFromInitialize(init);
    const second = engineFromInitialize(init);
    expect(second.smoothProfile).toEqual(first.smoothProfile);
    expect(second.smoothProfile.id).toBe(resolveFollowProfile(chosen).id);
    expect(second.smoothProfile).not.toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE);
  });

  it('a session restart re-resolves rather than reusing the last profile', () => {
    const a = engineFromInitialize(initializeFor(following({ feel: 'calm' })));
    const b = engineFromInitialize(initializeFor(following({ feel: 'responsive' })));
    expect(b.smoothProfile.motion.naturalFrequency).toBeGreaterThan(
      a.smoothProfile.motion.naturalFrequency,
    );
  });

  it('falls back to the saved settings when the caller passes none', () => {
    // No `following` at all: the driver must still resolve a real profile
    // (defaults here, since the settings store is unloaded in a unit test)
    // rather than send nothing and leave the worker on its own default by
    // accident.
    const init = initializeFor();
    expect(init.smoothProfile).toEqual(resolveFollowProfile(defaultFollowingSettings()));
  });
});

describe('uninterpretable profiles fall back whole (companion §55)', () => {
  it('a future version is ignored entirely, not partially applied', () => {
    const init = initializeFor(following({ feel: 'responsive', voiceLead: 'more' }));
    const fromTheFuture = {
      ...(init.smoothProfile as Record<string, unknown>),
      version: DEFAULT_SMOOTH_FOLLOW_PROFILE.version + 1,
    } as InitializeMessage['smoothProfile'];

    const engine = engineFromInitialize({ ...init, smoothProfile: fromTheFuture });
    // Whole-profile fallback: not one field of the future profile survives.
    expect(engine.smoothProfile).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE);
    expect(engine.smoothProfile.prediction.normalHorizonMs).toBe(
      DEFAULT_SMOOTH_FOLLOW_PROFILE.prediction.normalHorizonMs,
    );
    expect(engine.smoothProfile.id).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE.id);
  });

  it('a non-finite number poisons the whole profile, not one field', () => {
    const init = initializeFor(following({ feel: 'calm' }));
    const corrupt = {
      ...(init.smoothProfile as Record<string, unknown>),
      motion: {
        ...(init.smoothProfile as { motion: Record<string, unknown> }).motion,
        maxJerkPxS3: Number.NaN,
      },
    } as InitializeMessage['smoothProfile'];

    const engine = engineFromInitialize({ ...init, smoothProfile: corrupt });
    expect(engine.smoothProfile).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE);
  });

  it('an ordinary partial override still merges (no version claimed)', () => {
    const init = initializeFor(following());
    const engine = engineFromInitialize({
      ...init,
      smoothProfile: { alignment: { beamWidth: 6 } },
    });
    expect(engine.smoothProfile.alignment.beamWidth).toBe(6);
    expect(engine.smoothProfile.prediction).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE.prediction);
  });
});
