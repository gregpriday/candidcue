/**
 * FollowStatePanel — never claim a microphone you do not have.
 *
 * The shared follow copy is written for a voice take ("CandidCue is still
 * listening", "Transcription is still connected", "Start speaking and
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
import { osCopy } from '../../src/control/lib/os-copy';
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

interface PanelInputs {
  micState?: 'live' | 'muted' | 'disconnected';
  inputDeviceLost?: boolean;
  microphoneRefused?: boolean;
  heardAnything?: boolean;
  heldByUser?: boolean;
  rollingAtPace?: boolean;
  takePaused?: 'none' | 'listening' | 'hard';
}

function textOf(
  voiceInput: boolean,
  state: SmoothFollowState['state'],
  inputs: PanelInputs = {},
): string {
  const { container } = render(FollowStatePanel, {
    props: { follow: followState(state), voiceInput, ...inputs },
  });
  return container.textContent ?? '';
}

/*
 * A deliberate hold is expressed with the `heldByUser` PROP, not by driving the
 * store's `followingPaused`. That flag is also raised automatically on device
 * loss, so the panel deliberately no longer reads it — see the note on
 * `FollowStatusInput.heldByUser`.
 */
describe('FollowStatePanel honesty', () => {
  it('a manual take never offers a wake word or a transcription feed', () => {
    const paused = textOf(false, 'paused', { heldByUser: true });
    /*
     * The no-microphone branch wins over the hold, and that is the point: on a
     * take that never opened an input, "Text held — CandidCue is still
     * listening" would be false in its second half. So a manual take says
     * `paused` in its own words even when the operator did hold the text.
     */
    expect(paused).toContain('Paused');
    // A manual take has no microphone, so it must not offer to be spoken to
    // nor claim a feed it does not have.
    expect(paused).toMatch(/transport moves the script/i);
    expect(paused).not.toContain('CandidCue');
    expect(paused).not.toContain('Transcription');

    const searching = textOf(false, 'searching');
    expect(searching).not.toContain('Start speaking');
    expect(searching.toLowerCase()).toContain('nothing is listening');
  });

  it('a voice take keeps the transcription copy', () => {
    const paused = textOf(true, 'paused', { heldByUser: true });
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

  /*
   * ------------------------------------------------------------------------
   * The props actually rendered, not just defaulted.
   * ------------------------------------------------------------------------
   * The first version of this file passed neither new input, so it proved the
   * component compiled and nothing about CCUX-018. These drive the panel
   * through the states the feature exists for.
   */
  it('renders a lost device as a fault with a way out', () => {
    const text = textOf(true, 'holding', { micState: 'disconnected', inputDeviceLost: true });
    expect(text).toContain('Microphone disconnected');
    expect(text).toMatch(/another input/i);
  });

  it('does not offer the input picker for a recogniser failure', () => {
    // Same `micState`, different cause. Telling somebody to change microphone
    // because the recogniser stopped is an instruction they cannot follow.
    const text = textOf(true, 'holding', { micState: 'disconnected', inputDeviceLost: false });
    expect(text).toMatch(/not the microphone/i);
    expect(text).not.toMatch(/another input/i);
  });

  it('names a refused microphone as a refusal, with neither other remedy (#303)', () => {
    // Same `micState` again, a third cause: the OS said no. Neither another
    // input nor "this is not the microphone" is true of it.
    const text = textOf(true, 'holding', {
      micState: 'disconnected',
      inputDeviceLost: false,
      microphoneRefused: true,
    });
    expect(text).toContain('Microphone not allowed');
    // Where it is allowed, in the OS's own words. jsdom names no platform, so
    // this is the neutral column on every host; what each platform's column
    // says is pinned in os-copy.test.ts, and this proves the panel shows it.
    expect(text).toContain(osCopy().micRefusedStatusDetail);
    expect(text).not.toMatch(/another input/i);
    expect(text).not.toMatch(/not the microphone/i);
  });

  it('never says the text is stationary while it rolls', () => {
    // Auto-scroll raises the same pause flag a deliberate hold does, and the
    // text is moving down the glass the whole time.
    const text = textOf(true, 'following', { rollingAtPace: true, heldByUser: true });
    expect(text).toContain('Rolling at pace');
    expect(text).not.toMatch(/stays where it is/i);
  });

  /*
   * A soft pause offered "Say “CandidCue, resume”", and nothing in the app
   * listens for a wake word or a voice command. It names the key that works,
   * and keeps telling a soft pause from a hard one by the microphone.
   */
  it('offers only the way back from a pause that actually works', () => {
    const soft = textOf(true, 'following', { takePaused: 'listening' });
    expect(soft).toContain('Take paused');
    expect(soft).not.toMatch(/CandidCue, resume|say “/i);
    expect(soft).toMatch(/close this panel and press Space/i);
    expect(soft).toMatch(/microphone stays on/i);

    const hard = textOf(true, 'following', { takePaused: 'hard' });
    expect(hard).toMatch(/microphone is off/i);
    expect(hard).not.toMatch(/CandidCue, resume/i);
  });

  it('separates an operator hold from an automatic one', () => {
    const chosen = textOf(true, 'holding', { heldByUser: true });
    expect(chosen).toContain('Text held');
    expect(chosen).toMatch(/still listening/i);

    // The store's broad pause flag is raised by device loss too. Reading it as
    // a decision claimed CandidCue was listening to a microphone that had gone.
    const automatic = textOf(true, 'holding', {
      heldByUser: false,
      micState: 'disconnected',
      inputDeviceLost: true,
    });
    expect(automatic).not.toMatch(/still listening/i);
  });
});
