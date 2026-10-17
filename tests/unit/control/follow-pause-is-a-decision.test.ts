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

/**
 * A deliberate pause belongs to the take it was made in (#277).
 *
 * A take that ends with following switched off — by the presenter, or by a
 * transport still rolling when Stop was pressed — must not hand the next take a
 * pause nobody made in it. Otherwise that take's first automatic hold never
 * releases, under a switch that reads on.
 */
describe('the next take starts with nothing switched off', () => {
  for (const [label, boundary] of [
    ['a new session', (store: ReturnType<typeof createSmoothFollowStore>) => {
      store.endSession();
      store.beginSession(SESSION_ID, defaultFollowingSettings());
    }],
    // On its own: `beginSession` resets it too, and would hide a reset that did not.
    ['a reset', (store: ReturnType<typeof createSmoothFollowStore>) => store.reset()],
  ] as const) {
    it(`lets a hold release after ${label}`, () => {
      const { store, setFollowingPaused } = storeWithSpy();
      store.setFollowingPaused(true); // switched off, and never back on
      boundary(store);
      setFollowingPaused.mockClear();

      store.setFollowingPaused(true, false); // the next take's first hold
      store.setFollowingPaused(false, false); // and its recovery
      expect(setFollowingPaused.mock.calls).toEqual([
        [true, false],
        [false, false],
      ]);
      expect(store.snapshot().followingPaused).toBe(false);
    });
  }
});

describe('a manual move while paused (#275)', () => {
  const move = (seq: number, token: number) => ({
    sessionGeneration: 1,
    seq,
    // The engine says `following` after a move: it was told where the reader is.
    state: 'following' as const,
    decision: 'manualAnchor' as const,
    confirmedToken: token,
    observedToken: token,
    rateTokensPerSecond: 2,
    evidenceAudioMs: 0,
    atAudioMs: 0,
    maxPredictionMs: 900,
    pauseOnsetMs: 1800,
    leadFloorMs: 550,
    maxLeadTokens: 2.5,
    leadMarginTokens: 1.2,
    leadEaseMs: 450,
    leadHoldMs: 0,
    leadDecayMs: 1200,
    displayLimitToken: token,
    confidence: 0.9,
    suggestionToken: null,
    scriptLenTokens: 200,
    observedAtom: token,
    confirmedAtom: token,
  });

  it('moves the position and leaves the take paused', () => {
    const { store, setFollowingPaused } = storeWithSpy();
    store.toggleFollowingPaused();
    store.ingestSnapshot(move(1, 24));

    const s = store.snapshot();
    expect(s.confirmedToken).toBe(24);
    expect(s.followingPaused).toBe(true);
    expect(s.state).toBe('paused');
    // And nothing was resumed on the way through.
    expect(setFollowingPaused.mock.calls).toEqual([[true, true]]);
  });

  it('takes the engine’s state again once following is back', () => {
    const { store } = storeWithSpy();
    store.toggleFollowingPaused();
    store.ingestSnapshot(move(1, 24));
    store.toggleFollowingPaused();
    store.ingestSnapshot(move(2, 36));
    expect(store.snapshot().state).toBe('following');
  });
});
