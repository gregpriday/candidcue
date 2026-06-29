// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// StageApp constructs a SpeechPlayer (real `new AudioContext()`) on mount and a
// CaptureController on capture-config; VideoDeck drives a <video>. None are
// relevant to the end-interview wiring under test, so stub them out to keep the
// mount headless in jsdom.
vi.mock('../../src/renderer/stage/playback/SpeechPlayer', () => ({
  SpeechPlayer: class {
    load = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/playback/BackchannelPlayer', () => ({
  BackchannelPlayer: class {
    init = vi.fn(async () => {});
    play = vi.fn();
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/audio/SyncBeeper', () => ({
  SyncBeeper: class {
    play = vi.fn();
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

const send = vi.fn();

function installStageBridge(): void {
  (window as unknown as { candidcueStage: unknown }).candidcueStage = {
    bootstrap: vi.fn(async () => ({
      characterId: 'mira',
      staticBackground: false,
      posterUrl: '',
      listeningClips: [],
      backchannelClips: [],
      video: { fit: 'cover', mirror: false, zoom: 1, verticalOffsetPercent: 0, transitionMs: 0 },
    })),
    commands: { send },
    playback: {
      reportReady: vi.fn(),
      reportStarted: vi.fn(),
      reportEnded: vi.fn(),
      reportError: vi.fn(),
    },
    audio: { reportMeter: vi.fn(), openCapturePort: vi.fn() },
    events: {
      onState: vi.fn(() => () => {}),
      onPlaybackPlan: vi.fn(() => () => {}),
      onPlayBackchannel: vi.fn(() => () => {}),
      onCaptureConfig: vi.fn(() => () => {}),
    },
  };
}

/** Mount StageApp and wait past the bootstrap so the live stage chrome renders. */
async function mountStage(): Promise<void> {
  render(<StageApp />);
  // The standby screen only appears once bootstrap resolves and state is applied.
  await screen.findByText('Your interview is ready.');
}

beforeEach(() => {
  send.mockClear();
  installStageBridge();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { candidcueStage?: unknown }).candidcueStage;
});

describe('StageApp end-interview control', () => {
  it('opens the confirm on Shift+E without sending any command', async () => {
    await mountStage();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(window, { code: 'KeyE', key: 'E', shiftKey: true });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('dispatches exactly one END_AFTER_TURN when the founder confirms', async () => {
    await mountStage();
    fireEvent.keyDown(window, { code: 'KeyE', key: 'E', shiftKey: true });

    fireEvent.click(screen.getByRole('button', { name: 'End interview' }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'END_AFTER_TURN' });
    // The dialog closes after confirming.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes without sending when the founder keeps going', async () => {
    await mountStage();
    fireEvent.keyDown(window, { code: 'KeyE', key: 'E', shiftKey: true });

    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));

    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a bare E (no shift) — the chord requires Shift', async () => {
    await mountStage();
    fireEvent.keyDown(window, { code: 'KeyE', key: 'e' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('suppresses the normal stage commands while the confirm is open', async () => {
    await mountStage();
    fireEvent.keyDown(window, { code: 'KeyE', key: 'E', shiftKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // With the modal open, the global handler must bail before command routing.
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    fireEvent.keyDown(window, { code: 'KeyP', key: 'p' });
    fireEvent.keyDown(window, { code: 'KeyR', key: 'r' });
    fireEvent.keyDown(window, { code: 'KeyS', key: 's' });
    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape', shiftKey: true });

    expect(send).not.toHaveBeenCalled();
  });

  it('sends a normal command when no modal is open (guard is scoped)', async () => {
    await mountStage();
    // Sanity check the guard does not over-block: Space commits when unobstructed.
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(send).toHaveBeenCalledWith({ type: 'COMMIT', reason: 'manual' });
  });
});
