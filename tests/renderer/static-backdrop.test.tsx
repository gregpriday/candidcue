// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { SpeechPlaybackPlan, StageBootstrap, StageStateProjection } from '@shared/contracts';
import { StaticBackdrop } from '../../src/renderer/stage/playback/StaticBackdrop';

function bootstrap(overrides: Partial<StageBootstrap> = {}): StageBootstrap {
  return {
    characterId: 'mira',
    staticBackground: true,
    posterUrl: 'candidcue://media/mira/poster.webp',
    listeningClips: [],
    backchannelClips: [],
    video: { fit: 'cover', mirror: false, zoom: 1, verticalOffsetPercent: 0, transitionMs: 0 },
    ...overrides,
  };
}

function projection(overrides: Partial<StageStateProjection> = {}): StageStateProjection {
  return {
    version: 1,
    visualState: 'speaking',
    micState: 'closed',
    statusText: null,
    captions: null,
    cue: null,
    mirror: false,
    zoom: 1,
    verticalOffsetPercent: 0,
    canBegin: false,
    ...overrides,
  };
}

function plan(turnId: string): SpeechPlaybackPlan {
  return {
    sessionId: 's1',
    turnId,
    text: 'hello',
    audio: { mimeType: 'audio/wav', bytes: new ArrayBuffer(0), durationMs: 1000, outputDeviceId: null },
    media: { speechDurationMs: 1000, segments: [], selectionReason: 'poster_fallback', diagnosticScore: 0 },
    captionsEnabled: false,
  };
}

afterEach(() => cleanup());

describe('StaticBackdrop', () => {
  it('renders the poster image as the static backdrop', () => {
    const { container } = render(
      <StaticBackdrop bootstrap={bootstrap()} state={projection()} plan={null} onSpeakingReady={vi.fn()} />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'candidcue://media/mira/poster.webp');
  });

  it('renders no image when the poster URL is empty (degrades to a bare backdrop)', () => {
    const { container } = render(
      <StaticBackdrop
        bootstrap={bootstrap({ posterUrl: '' })}
        state={projection()}
        plan={null}
        onSpeakingReady={vi.fn()}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('reports speaking-ready immediately when a plan arrives (no video to decode)', () => {
    const onSpeakingReady = vi.fn();
    const { rerender } = render(
      <StaticBackdrop
        bootstrap={bootstrap()}
        state={projection()}
        plan={null}
        onSpeakingReady={onSpeakingReady}
      />,
    );
    expect(onSpeakingReady).not.toHaveBeenCalled();

    rerender(
      <StaticBackdrop
        bootstrap={bootstrap()}
        state={projection()}
        plan={plan('turn-1')}
        onSpeakingReady={onSpeakingReady}
      />,
    );
    expect(onSpeakingReady).toHaveBeenCalledWith('turn-1');
  });

  it('re-acknowledges a fresh plan for the SAME turn (repeat/retake/resume)', () => {
    // The host resets its readiness refs for every plan, so a replayed turn must
    // get a fresh onSpeakingReady — keying off turnId alone would deadlock it.
    const onSpeakingReady = vi.fn();
    const { rerender } = render(
      <StaticBackdrop
        bootstrap={bootstrap()}
        state={projection()}
        plan={plan('turn-1')}
        onSpeakingReady={onSpeakingReady}
      />,
    );
    expect(onSpeakingReady).toHaveBeenCalledTimes(1);

    // A new plan OBJECT with the same turnId (a repeat) must re-fire readiness.
    rerender(
      <StaticBackdrop
        bootstrap={bootstrap()}
        state={projection()}
        plan={plan('turn-1')}
        onSpeakingReady={onSpeakingReady}
      />,
    );
    expect(onSpeakingReady).toHaveBeenCalledTimes(2);
  });
});
