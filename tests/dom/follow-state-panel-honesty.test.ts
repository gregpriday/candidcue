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
import type { AlignmentSnapshot } from '../../src/shared/contracts';

const SESSION_ID = '00000000-0000-0000-0000-0000000000f1';

/**
 * A real store state, driven through the real ingest path — a hand-built object
 * literal would drift from the store and prove nothing about what the panel is
 * actually handed.
 */
function followState(state: SmoothFollowState['state']): SmoothFollowState {
  if (state === 'paused') {
    const paused = createSmoothFollowStore();
    paused.beginSession(SESSION_ID, defaultFollowingSettings());
    paused.setFollowingPaused(true);
    return paused.snapshot();
  }
  const store = createSmoothFollowStore();
  store.beginSession(SESSION_ID, defaultFollowingSettings());
  const snapshot: AlignmentSnapshot = {
    sessionGeneration: 1,
    seq: 1,
    state,
    decision: 'noEvidence',
    confirmedToken: 0,
    observedToken: 0,
    rateTokensPerSecond: 0,
    evidenceAudioMs: 1000,
    atAudioMs: 1000,
    maxPredictionMs: 900,
    confidence: 0.4,
    suggestionToken: null,
    scriptLenTokens: 100,
    observedAtom: 0,
    confirmedAtom: 0,
  };
  store.ingestSnapshot(snapshot);
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
    expect(paused).toContain('Following paused');
    // A manual take has no microphone, so it must not offer to be spoken to
    // nor claim a feed it does not have.
    expect(paused).toContain('Use the transport to move it');
    expect(paused).not.toContain('CandidCue');
    expect(paused).not.toContain('Transcription');

    const searching = textOf(false, 'searching');
    expect(searching).not.toContain('Start speaking');
    expect(searching).toContain('nothing is listening');
  });

  it('a voice take keeps the transcription copy', () => {
    const paused = textOf(true, 'paused');
    expect(paused).toContain('Following paused');
    // §48: pausing FOLLOWING is not pausing the session. The panel has to say
    // so, or a presenter reasonably concludes the microphone is off.
    expect(paused).toContain('Transcription and voice commands keep running');

    const searching = textOf(true, 'searching');
    expect(searching).toContain('Start speaking and the stage picks up your place.');
    expect(searching).not.toContain('nothing is listening');
  });
});
