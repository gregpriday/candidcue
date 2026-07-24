/**
 * FollowStatePanel — never claim a microphone you do not have.
 *
 * The shared follow copy is written for a voice take ("still listening for
 * CandidCue, resume", "Transcription is still connected", "Start speaking and
 * the stage picks up your place"). A manual or fixed-speed take has no realtime
 * connection and no open microphone, and the panel was showing all three of
 * those sentences anyway — including before the take had started.
 *
 * Both directions are asserted here on purpose: deleting the indicator would
 * satisfy the manual case and fail the voice one.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import FollowStatePanel from '../../src/control/components/FollowStatePanel.svelte';
import { createSmoothFollowStore } from '../../src/control/stores/smooth-follow';
import { defaultFollowingSettings } from '../../src/control/lib/follow-profiles';
import type { SmoothFollowState } from '../../src/control/stores/smooth-follow';
import type { SemanticMotionFrame } from '../../src/shared/contracts';

const SESSION_ID = '00000000-0000-0000-0000-0000000000f1';

/**
 * A real store state, driven through the real ingest path — a hand-built object
 * literal would drift from the store and prove nothing about what the panel is
 * actually handed.
 */
function followState(state: SmoothFollowState['state']): SmoothFollowState {
  const store = createSmoothFollowStore();
  store.beginSession(SESSION_ID, defaultFollowingSettings());
  const frame: SemanticMotionFrame = {
    sessionId: SESSION_ID,
    sessionGeneration: 1,
    scriptCompileHash: 'hash',
    layoutGeneration: 0,
    revision: 1,
    epoch: 0,
    sessionTimeMs: 1000,
    state,
    behavior: 'acquire',
    confidence: 0.4,
    sectionId: 'section-1',
    blockId: 'block-1',
    sentenceId: 'sentence-1',
    tokenIndex: 0,
    estimatedUnit: 0,
    committedUnit: 0,
    motionProfileId: defaultFollowingSettings().motionProfileId,
    velocityUnitsPerSecond: 0,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0,
    finalEvidence: false,
  };
  store.ingestMotionFrame(frame);
  return store.snapshot();
}

function textOf(voiceInput: boolean, state: SmoothFollowState['state']): string {
  const { container } = render(FollowStatePanel, {
    props: { follow: followState(state), voiceInput },
  });
  return container.textContent ?? '';
}

describe('FollowStatePanel honesty', () => {
  it('a manual take never offers a wake word or a transcription feed', () => {
    const paused = textOf(false, 'paused');
    expect(paused).toContain('Paused — the script stays where it is');
    expect(paused).not.toContain('CandidCue, resume');
    expect(paused).not.toContain('Transcription is still connected');

    const acquiring = textOf(false, 'acquiring');
    expect(acquiring).not.toContain('Start speaking');
    expect(acquiring).toContain('nothing is listening');
  });

  it('a voice take keeps the wake-word and transcription copy', () => {
    const paused = textOf(true, 'paused');
    expect(paused).toContain('Paused — still listening for “CandidCue, resume”');
    expect(paused).toContain('Transcription is still connected');

    const acquiring = textOf(true, 'acquiring');
    expect(acquiring).toContain('Start speaking and the stage picks up your place.');
    expect(acquiring).not.toContain('nothing is listening');
  });
});
