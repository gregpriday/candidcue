/**
 * A decision and a symptom arrive at the same action (§48).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS ITS OWN FILE
 * ---------------------------------------------------------------------------
 * Three things stop automatic following, and one of them is not like the
 * others. Somebody switching it off at the dock, at the transport checkbox, or
 * at the Live panel's button is a MODE — the presenter has taken the wheel, and
 * the stage says so in words with a lit control beside them. Transcription
 * going untrustworthy (`onFollowingHold`) stops following too, and it is a
 * FAULT, worded by the hold ladder and the audio readout.
 *
 * All three funnel through `setFollowingPaused`, which is exactly why the
 * distinction has to be carried explicitly. Without it the stage would tell a
 * presenter whose microphone had just dropped that they had switched something
 * off — blaming them for the rig, in the middle of a take, on the one surface
 * they cannot look away from.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSmoothFollowStore } from '../../../src/control/stores/smooth-follow';
import { defaultFollowingSettings } from '../../../src/control/lib/follow-profiles';

const SESSION_ID = '00000000-0000-0000-0000-0000000000f2';

function storeWithSpy() {
  const setFollowingPaused = vi.fn<(paused: boolean, deliberate?: boolean) => void>();
  const store = createSmoothFollowStore();
  store.setActions({ setFollowingPaused });
  store.beginSession(SESSION_ID, defaultFollowingSettings());
  return { store, setFollowingPaused };
}

describe('pausing following says whether anybody decided to', () => {
  it('marks the switch as deliberate', () => {
    const { store, setFollowingPaused } = storeWithSpy();
    store.toggleFollowingPaused();
    expect(setFollowingPaused).toHaveBeenCalledWith(true, true);
  });

  it('marks an automatic hold as not deliberate', () => {
    // What `onFollowingHold` does when the transcript stops being trustworthy.
    const { store, setFollowingPaused } = storeWithSpy();
    store.setFollowingPaused(true, false);
    expect(setFollowingPaused).toHaveBeenCalledWith(true, false);
  });

  it('defaults to deliberate, so a caller that has not thought about it is safe', () => {
    /*
     * The default has to be the one that is wrong in the quiet direction. A
     * deliberate pause misreported as automatic leaves the stage silent about a
     * mode the presenter chose — they wonder why the script stopped. The
     * reverse blames them for a fault. Silence is recoverable; the accusation
     * is not.
     */
    const { store, setFollowingPaused } = storeWithSpy();
    store.setFollowingPaused(true);
    expect(setFollowingPaused).toHaveBeenCalledWith(true, true);
  });

  it('carries the flag through to the action on every road into it', () => {
    /*
     * Three things stop following and they arrive by different doors. If any
     * door forgets the flag, the stage either accuses the presenter of
     * switching something off or stays silent about a mode they chose — so the
     * enumeration is the test.
     */
    const { store, setFollowingPaused } = storeWithSpy();
    store.toggleFollowingPaused(); // off
    store.toggleFollowingPaused(); // back on
    store.setFollowingPaused(true, false); // the automatic hold
    expect(setFollowingPaused.mock.calls).toEqual([
      [true, true],
      [false, true],
      [true, false],
    ]);
  });

  it('reports the paused state either way — the panel still has to be honest', () => {
    const { store } = storeWithSpy();
    store.setFollowingPaused(true, false);
    expect(store.snapshot().followingPaused).toBe(true);
    expect(store.snapshot().state).toBe('paused');
  });
});
