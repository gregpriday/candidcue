/**
 * FollowControls in a Read take (#243).
 *
 * A Read take opens no microphone, so "Hold text" / "Follow voice" would be a
 * switch for a voice that is not there — and pressing "Follow voice" would hand
 * the script away from a running Auto-scroll to nothing; "Set my place" asks
 * the engine to find the presenter from speech it will never hear. The single
 * steps are how a Read take is moved by hand, so they stay.
 *
 * Both directions are asserted: dropping the switch everywhere would pass the
 * Read case and break every voice take.
 */
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import FollowControls from '../../src/control/components/FollowControls.svelte';
import { createSmoothFollowStore } from '../../src/control/stores/smooth-follow';
import { defaultFollowingSettings } from '../../src/control/lib/follow-profiles';
import { TAKE_ACTIONS } from '../../src/shared/take-vocabulary';

function followState() {
  const store = createSmoothFollowStore();
  store.beginSession('00000000-0000-0000-0000-0000000000f2', defaultFollowingSettings());
  return store.snapshot();
}

function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
}

describe('FollowControls', () => {
  it('offers the follow switch in a take that listens', () => {
    const { container } = render(FollowControls, {
      props: { follow: followState(), part: 'routine' },
    });
    flushSync();
    expect(labels(container)).toEqual([
      TAKE_ACTIONS.hold,
      TAKE_ACTIONS.setPlace,
      TAKE_ACTIONS.previousSentence,
      TAKE_ACTIONS.nextSentence,
    ]);
  });

  it('keeps the single steps and drops what needs a voice in a Read take', () => {
    const { container } = render(FollowControls, {
      props: { follow: followState(), part: 'routine', voiceInput: false },
    });
    flushSync();
    // "Set my place" asks the engine to re-find the presenter from speech.
    expect(labels(container)).toEqual([
      TAKE_ACTIONS.previousSentence,
      TAKE_ACTIONS.nextSentence,
    ]);
  });
});
