// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { StageStateProjection } from '@shared/contracts';

// Shared spy so we can assert how many times the (single) SyncBeeper instance's
// play() fires across state transitions. The other stage engines are stubbed to
// keep the mount headless in jsdom, matching stage-app-end.test.tsx.
const beeperPlay = vi.fn();
vi.mock('../../src/renderer/stage/audio/SyncBeeper', () => ({
  SyncBeeper: class {
    play = beeperPlay;
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/playback/SpeechPlayer', () => ({
  SpeechPlayer: class {
    load = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/audio/CaptureController', () => ({
  CaptureController: class {
    start = vi.fn(async () => {});
    setGate = vi.fn();
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/playback/VideoDeck', () => ({
  VideoDeck: () => null,
}));

import { StageApp } from '../../src/renderer/stage/stage-app';

type StateListener = (next: StageStateProjection) => void;
let stateListener: StateListener | null = null;

function makeState(visualState: StageStateProjection['visualState']): StageStateProjection {
  return {
    version: 1,
    visualState,
    micState: 'closed',
    statusText: null,
    captions: null,
    mirror: false,
    zoom: 1,
    verticalOffsetPercent: 0,
  };
}

function installStageBridge(): void {
  stateListener = null;
  (window as unknown as { candidcueStage: unknown }).candidcueStage = {
    bootstrap: vi.fn(async () => ({
      characterId: 'mira',
      posterUrl: '',
      listeningClips: [],
      video: { fit: 'cover', mirror: false, zoom: 1, verticalOffsetPercent: 0, transitionMs: 0 },
    })),
    commands: { send: vi.fn() },
    playback: {
      reportReady: vi.fn(),
      reportStarted: vi.fn(),
      reportEnded: vi.fn(),
      reportError: vi.fn(),
    },
    audio: { reportMeter: vi.fn(), openCapturePort: vi.fn() },
    events: {
      onState: vi.fn((cb: StateListener) => {
        stateListener = cb;
        return () => {};
      }),
      onPlaybackPlan: vi.fn(() => () => {}),
      onCaptureConfig: vi.fn(() => () => {}),
    },
  };
}

/** Push a state through the captured onState listener inside an act() flush. */
function pushState(visualState: StageStateProjection['visualState']): void {
  act(() => {
    stateListener?.(makeState(visualState));
  });
}

function slate(): Element | null {
  return document.querySelector('[class*="syncSlate"]');
}

/** Mount StageApp and wait past bootstrap so the live stage chrome renders. */
async function mountStage(): Promise<void> {
  render(<StageApp />);
  await screen.findByText('Your interview is ready.');
}

beforeEach(() => {
  beeperPlay.mockClear();
  installStageBridge();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { candidcueStage?: unknown }).candidcueStage;
});

describe('StageApp session-start sync marker', () => {
  it('fires the beep and shows the slate on the first move off standby', async () => {
    await mountStage();
    expect(beeperPlay).not.toHaveBeenCalled();
    expect(slate()).toBeNull();

    pushState('thinking');

    expect(beeperPlay).toHaveBeenCalledOnce();
    expect(slate()).not.toBeNull();
  });

  it('auto-clears the slate after ~250ms', async () => {
    await mountStage();
    pushState('thinking');
    expect(slate()).not.toBeNull();

    await waitFor(() => expect(slate()).toBeNull());
  });

  it('does not re-fire on subsequent live transitions within a session', async () => {
    await mountStage();
    pushState('thinking');
    expect(beeperPlay).toHaveBeenCalledOnce();

    pushState('speaking');
    pushState('listening');
    pushState('thinking');

    expect(beeperPlay).toHaveBeenCalledOnce();
  });

  it('re-arms after returning to standby (a fresh session start)', async () => {
    await mountStage();
    pushState('thinking');
    expect(beeperPlay).toHaveBeenCalledOnce();

    pushState('standby');
    pushState('thinking');

    expect(beeperPlay).toHaveBeenCalledTimes(2);
  });

  it('ignores a standby->error transition (only live states count as start)', async () => {
    await mountStage();
    pushState('error');
    expect(beeperPlay).not.toHaveBeenCalled();
    expect(slate()).toBeNull();
  });
});
