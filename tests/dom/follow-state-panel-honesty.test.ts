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
  pauseOnsetMs: 1800,
  leadFloorMs: 550,
  maxLeadTokens: 2.5,
  leadMarginTokens: 1.2,
  leadEaseMs: 450,
  leadHoldMs: 0,
  leadDecayMs: 1200,
  displayLimitToken: 100,
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
    // "Hold text" rather than "Pause following" (CCUX-002) — the retired label
    // shared a verb with pausing the TAKE and pausing the MICROPHONE.
    expect(paused).toContain('Text held');
    // A manual take has no microphone, so it must not offer to be spoken to
    // nor claim a feed it does not have.
    expect(paused).toContain('Use the transport to move it');
    expect(paused).not.toContain('CandidCue');
    expect(paused).not.toContain('Transcription');

    const searching = textOf(false, 'searching');
    expect(searching).not.toContain('Start speaking');
    expect(searching.toLowerCase()).toContain('nothing is listening');
  });

  it('a voice take keeps the transcription copy', () => {
    const paused = textOf(true, 'paused');
    expect(paused).toContain('Text held');
    /*
     * §48: pausing FOLLOWING is not pausing the session. The panel has to say
     * so, or a presenter reasonably concludes the microphone is off.
     *
     * The sentence carrying that promise changed with the vocabulary — it used
     * to be "Transcription and voice commands keep running" — so the assertion
     * is on the promise rather than on the old wording: the take is still
     * running AND something is still listening.
     */
    expect(paused).toMatch(/take is still running/i);
    expect(paused).toMatch(/still listening/i);

    const searching = textOf(true, 'searching');
    expect(searching).toContain('Start speaking and the stage picks up your place.');
    expect(searching.toLowerCase()).not.toContain('nothing is listening');
  });

  /*
   * The default that stops an unwired caller inventing a fault. `heardAnything`
   * is the one prop here whose failure mode is a standing accusation over a
   * take that is going perfectly, so it defaults to "assume we heard you".
   */
  it('accuses nothing when the caller has not wired the input signals', () => {
    const text = textOf(true, 'following');
    expect(text).not.toMatch(/microphone/i);
    expect(text).not.toMatch(/nothing heard/i);
  });
});
