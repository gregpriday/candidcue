// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { VideoDeck } from '../../src/renderer/stage/playback/VideoDeck';
import type { SpeechPlaybackPlan, StageBootstrap, StageStateProjection } from '@shared/contracts';

const bootstrap: StageBootstrap = {
  characterId: 'mira',
  staticBackground: false,
  posterUrl: 'candidcue://media/mira/poster.webp',
  listeningClips: [
    { clipId: 'listen_001', url: 'candidcue://media/mira/listening/a.mp4', durationMs: 7000 },
    { clipId: 'listen_002', url: 'candidcue://media/mira/listening/b.mp4', durationMs: 10000 },
  ],
  backchannelClips: [],
  video: { fit: 'cover', mirror: false, zoom: 1, verticalOffsetPercent: 0, transitionMs: 100 },
};

function stateWith(visualState: StageStateProjection['visualState']): StageStateProjection {
  return {
    version: 1,
    visualState,
    micState: 'closed',
    statusText: null,
    captions: null,
    cue: null,
    mirror: false,
    zoom: 1,
    verticalOffsetPercent: 0,
    canBegin: false,
  };
}

function speakingPlan(turnId: string, playbackRate = 1): SpeechPlaybackPlan {
  return {
    sessionId: 's1',
    turnId,
    text: 'Tell me about your work.',
    audio: { mimeType: 'audio/wav', bytes: new ArrayBuffer(8), durationMs: 5000, outputDeviceId: null },
    media: {
      speechDurationMs: 5000,
      segments: [
        {
          clipId: 'speaki_004',
          relativePath: 'mira/speaking/mira-speaking-5s.mp4',
          playbackRate,
          expectedPlaybackDurationMs: 5000,
        },
      ],
      selectionReason: 'single_match',
      diagnosticScore: 1,
    },
    captionsEnabled: false,
  };
}

/** Force a media element to report a given readyState (jsdom defaults to 0). */
function setReadyState(el: HTMLMediaElement, value: number): void {
  Object.defineProperty(el, 'readyState', { configurable: true, get: () => value });
}

/** The <video> elements the deck rendered: [0] is layer 'a', [1] is layer 'b'. */
function videoLayers(container: HTMLElement): [HTMLVideoElement, HTMLVideoElement] {
  const videos = container.querySelectorAll('video');
  return [videos[0] as HTMLVideoElement, videos[1] as HTMLVideoElement];
}

describe('VideoDeck speaking playback', () => {
  let playSpy: ReturnType<typeof vi.fn>;
  let pauseSpy: ReturnType<typeof vi.fn>;
  let loadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom does not implement media playback; stub the methods the deck calls.
    playSpy = vi.fn(function (this: HTMLMediaElement) {
      return Promise.resolve();
    });
    pauseSpy = vi.fn();
    loadSpy = vi.fn();
    HTMLMediaElement.prototype.play = playSpy as unknown as HTMLMediaElement['play'];
    HTMLMediaElement.prototype.pause = pauseSpy as unknown as HTMLMediaElement['pause'];
    HTMLMediaElement.prototype.load = loadSpy as unknown as HTMLMediaElement['load'];
  });

  afterEach(() => cleanup());

  it('plays the speaking clip on the speaking layer (at its rate) once the stage reaches speaking', async () => {
    const onSpeakingReady = vi.fn();
    const plan = speakingPlan('t1', 1.04);

    const { container, rerender } = render(
      <VideoDeck
        bootstrap={bootstrap}
        state={stateWith('thinking')}
        plan={null}
        speechEndedTurnId={null}
        onSpeakingReady={onSpeakingReady}
      />,
    );
    const [, videoB] = videoLayers(container); // speakingLayerRef starts at 'b'

    // 1. Plan arrives while still 'thinking' → deck preloads the speaking clip
    //    onto the speaking layer and reports ready on its 'canplay'.
    await act(async () => {
      rerender(
        <VideoDeck
          bootstrap={bootstrap}
          state={stateWith('thinking')}
          plan={plan}
          speechEndedTurnId={null}
          onSpeakingReady={onSpeakingReady}
        />,
      );
    });
    expect(videoB.src).toContain('mira-speaking-5s');

    await act(async () => {
      fireEvent(videoB, new Event('canplay'));
    });
    expect(onSpeakingReady).toHaveBeenCalledWith('t1');

    // The orchestrator only reaches 'speaking' after the deck reports ready, so
    // by then the clip is decoded and the element can play.
    setReadyState(videoB, 4 /* HAVE_ENOUGH_DATA */);
    playSpy.mockClear();

    // 2. Stage reaches 'speaking' → the speaking layer must actually play.
    await act(async () => {
      rerender(
        <VideoDeck
          bootstrap={bootstrap}
          state={stateWith('speaking')}
          plan={plan}
          speechEndedTurnId={null}
          onSpeakingReady={onSpeakingReady}
        />,
      );
    });

    expect(playSpy).toHaveBeenCalled();
    expect(playSpy.mock.instances as HTMLVideoElement[]).toContain(videoB);
    expect(videoB.className).toMatch(/front/);
    // The duration-matching rate is applied when playback starts.
    expect(videoB.playbackRate).toBeCloseTo(1.04, 5);
    // The redundant el.load() that stranded the clip on its first frame is gone.
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('does not report deck readiness until the speaking clip can actually play', async () => {
    const onSpeakingReady = vi.fn();
    const plan = speakingPlan('t2');

    const { container, rerender } = render(
      <VideoDeck
        bootstrap={bootstrap}
        state={stateWith('thinking')}
        plan={null}
        speechEndedTurnId={null}
        onSpeakingReady={onSpeakingReady}
      />,
    );
    const [, videoB] = videoLayers(container);
    // Simulate a reused layer that still reports the previous clip as ready.
    setReadyState(videoB, 4 /* HAVE_ENOUGH_DATA */);

    await act(async () => {
      rerender(
        <VideoDeck
          bootstrap={bootstrap}
          state={stateWith('thinking')}
          plan={plan}
          speechEndedTurnId={null}
          onSpeakingReady={onSpeakingReady}
        />,
      );
    });

    // Despite the stale high readyState, readiness must wait for THIS clip's
    // 'canplay' — never reported off the previous clip's decode state.
    expect(onSpeakingReady).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent(videoB, new Event('canplay'));
    });
    expect(onSpeakingReady).toHaveBeenCalledWith('t2');
  });
});
