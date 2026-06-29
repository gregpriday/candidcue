// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { StageStateProjection } from '@shared/contracts';
import { StatusOverlay } from '../../src/renderer/stage/components/StatusOverlay';

function projection(overrides: Partial<StageStateProjection> = {}): StageStateProjection {
  return {
    version: 1,
    visualState: 'standby',
    micState: 'closed',
    statusText: null,
    captions: null,
    mirror: false,
    zoom: 1,
    verticalOffsetPercent: 0,
    ...overrides,
  };
}

describe('StatusOverlay', () => {
  it('renders a dedicated error screen', () => {
    render(<StatusOverlay state={projection({ visualState: 'error' })} captionsEnabled={false} />);
    const title = screen.getByText('Something went wrong.');
    expect(title).toBeInTheDocument();
    expect(screen.getByText('Check CandidCue to retry the session.')).toBeInTheDocument();
    // The screen is an announced live region, matching standby/complete.
    const screenEl = title.closest('[role="status"]');
    expect(screenEl).not.toBeNull();
    expect(screenEl).toHaveAttribute('aria-live', 'polite');
  });

  it('still renders the standby screen', () => {
    render(
      <StatusOverlay
        state={projection({ visualState: 'standby' })}
        captionsEnabled={false}
        characterName="Mira"
      />,
    );
    expect(screen.getByText('Your interview is ready.')).toBeInTheDocument();
    expect(screen.getByText('Mira')).toBeInTheDocument();
  });

  it('still renders the complete screen', () => {
    render(
      <StatusOverlay state={projection({ visualState: 'complete' })} captionsEnabled={false} />,
    );
    expect(screen.getByText('Interview complete')).toBeInTheDocument();
  });

  it('does not render the error copy for non-error states', () => {
    render(
      <StatusOverlay state={projection({ visualState: 'listening' })} captionsEnabled={false} />,
    );
    expect(screen.queryByText('Something went wrong.')).not.toBeInTheDocument();
  });

  it('suppresses stale captions and transient status while in the error state', () => {
    render(
      <StatusOverlay
        state={projection({
          visualState: 'error',
          captions: 'a leftover caption line',
          statusText: 'a leftover status line',
        })}
        captionsEnabled
      />,
    );
    expect(screen.queryByText('a leftover caption line')).not.toBeInTheDocument();
    expect(screen.queryByText('a leftover status line')).not.toBeInTheDocument();
  });

  it('shows captions for a speaking state when enabled', () => {
    render(
      <StatusOverlay
        state={projection({ visualState: 'speaking', captions: 'hello there' })}
        captionsEnabled
      />,
    );
    expect(screen.getByText('hello there')).toBeInTheDocument();
  });
});

/** The nearest legend container (a div carrying data-visible) above a row label. */
function legendContainer(): Element {
  const el = screen.getByText('Commit answer').closest('div[data-visible]');
  if (el === null) throw new Error('legend container not found');
  return el;
}

describe('StatusOverlay — solo-interviewee legibility', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a persistent "Answer now" cue while listening, overriding statusText', () => {
    vi.useFakeTimers();
    render(
      <StatusOverlay
        state={projection({ visualState: 'listening', micState: 'armed', statusText: 'Listening' })}
        captionsEnabled={false}
      />,
    );
    const cue = screen.getByText('Answer now');
    expect(cue).toHaveAttribute('data-visible', 'true');
    // It must not fade like a transient status; still visible well past 2.4s.
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('Answer now')).toHaveAttribute('data-visible', 'true');
  });

  it('keeps the "Reconnecting" indicator visible during a recovery', () => {
    vi.useFakeTimers();
    render(
      <StatusOverlay state={projection({ visualState: 'recovering' })} captionsEnabled={false} />,
    );
    expect(screen.getByText('Reconnecting')).toHaveAttribute('data-visible', 'true');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('Reconnecting')).toHaveAttribute('data-visible', 'true');
  });

  it('still fades a genuinely transient status (thinking) after a couple of seconds', () => {
    vi.useFakeTimers();
    render(
      <StatusOverlay state={projection({ visualState: 'thinking' })} captionsEnabled={false} />,
    );
    expect(screen.getByText('Thinking')).toHaveAttribute('data-visible', 'true');
    act(() => vi.advanceTimersByTime(2400));
    expect(screen.getByText('Thinking')).toHaveAttribute('data-visible', 'false');
  });

  it('auto-shows the keyboard legend on standby', () => {
    render(<StatusOverlay state={projection({ visualState: 'standby' })} captionsEnabled={false} />);
    expect(legendContainer()).toHaveAttribute('data-visible', 'true');
    // Legend mirrors the real controls.
    expect(screen.getByText('Pause / Resume')).toBeInTheDocument();
    expect(screen.getByText('Exit stage')).toBeInTheDocument();
  });

  it('hides the legend during a live state unless explicitly toggled on', () => {
    const { rerender } = render(
      <StatusOverlay state={projection({ visualState: 'listening' })} captionsEnabled={false} />,
    );
    expect(legendContainer()).toHaveAttribute('data-visible', 'false');
    rerender(
      <StatusOverlay
        state={projection({ visualState: 'listening' })}
        captionsEnabled={false}
        legendVisible
      />,
    );
    expect(legendContainer()).toHaveAttribute('data-visible', 'true');
  });

  it('renders a reject cue without the terracotta accent', () => {
    render(
      <StatusOverlay
        state={projection({ visualState: 'speaking' })}
        captionsEnabled={false}
        commandFeedback={{ kind: 'rejected', token: 1 }}
      />,
    );
    expect(screen.getByText('Not now')).toHaveAttribute('data-kind', 'rejected');
  });

  it('renders a confirm cue when a command lands', () => {
    render(
      <StatusOverlay
        state={projection({ visualState: 'listening', micState: 'active' })}
        captionsEnabled={false}
        commandFeedback={{ kind: 'ok', token: 1 }}
      />,
    );
    expect(screen.getByText('Got it')).toHaveAttribute('data-kind', 'ok');
  });
});
