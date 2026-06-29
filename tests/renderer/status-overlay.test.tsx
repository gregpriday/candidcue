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
    cue: null,
    mirror: false,
    zoom: 1,
    verticalOffsetPercent: 0,
    canBegin: false,
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

  it('prompts the founder to begin once the session is ready (canBegin)', () => {
    render(
      <StatusOverlay
        state={projection({ visualState: 'standby', canBegin: true })}
        captionsEnabled={false}
      />,
    );
    expect(screen.getByText('Press Space to begin.')).toBeInTheDocument();
    // No "Press Start in CandidCue" — the founder starts from the stage now.
    expect(screen.queryByText(/Press Start in CandidCue/)).not.toBeInTheDocument();
  });

  it('shows a preparing hint while standby is not yet begin-able', () => {
    render(
      <StatusOverlay
        state={projection({ visualState: 'standby', canBegin: false })}
        captionsEnabled={false}
      />,
    );
    expect(screen.getByText('Getting everything ready…')).toBeInTheDocument();
    expect(screen.queryByText('Press Space to begin.')).not.toBeInTheDocument();
  });

  it('renders the countdown in an assertive timer region, replacing the begin hint', () => {
    render(
      <StatusOverlay
        state={projection({ visualState: 'standby', canBegin: true })}
        captionsEnabled={false}
        countdown={3}
      />,
    );
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('Starting in 3');
    expect(timer).toHaveAttribute('aria-live', 'assertive');
    // The begin hint is gone while counting; the timer is a sibling of (not
    // nested in) the polite standby status region.
    expect(screen.queryByText('Press Space to begin.')).not.toBeInTheDocument();
    expect(timer.closest('[role="status"]')).toBeNull();
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

  it('renders the model cue headline and coaching prompt while Mira is speaking', () => {
    render(
      <StatusOverlay
        state={projection({
          visualState: 'speaking',
          cue: { headline: 'What changed your mind?', prompt: 'Name one moment' },
        })}
        captionsEnabled={false}
      />,
    );
    // The headline shows even though the verbatim-captions toggle is OFF — the
    // cue is the core teleprompter prompt, not an accessibility caption.
    expect(screen.getByText('What changed your mind?')).toBeInTheDocument();
    expect(screen.getByText('Name one moment')).toBeInTheDocument();
  });

  it('keeps the cue headline but drops the coaching prompt once the founder is answering', () => {
    render(
      <StatusOverlay
        state={projection({
          visualState: 'listening',
          cue: { headline: 'What changed your mind?', prompt: 'Name one moment' },
        })}
        captionsEnabled={false}
      />,
    );
    expect(screen.getByText('What changed your mind?')).toBeInTheDocument();
    // The "how to answer" steer belongs to Mira's turn, not the founder's.
    expect(screen.queryByText('Name one moment')).not.toBeInTheDocument();
  });

  it('lets the cue replace the verbatim caption plate so the question is not shown twice', () => {
    render(
      <StatusOverlay
        state={projection({
          visualState: 'speaking',
          captions: 'the spoken verbatim line',
          cue: { headline: 'a tightened headline', prompt: null },
        })}
        captionsEnabled
      />,
    );
    expect(screen.getByText('a tightened headline')).toBeInTheDocument();
    expect(screen.queryByText('the spoken verbatim line')).not.toBeInTheDocument();
  });

  it('never renders the cue in the error state', () => {
    render(
      <StatusOverlay
        state={projection({
          visualState: 'error',
          cue: { headline: 'a stale headline', prompt: null },
        })}
        captionsEnabled={false}
      />,
    );
    expect(screen.queryByText('a stale headline')).not.toBeInTheDocument();
  });

  it('keeps the cue headline visible while paused, without the coaching prompt', () => {
    render(
      <StatusOverlay
        state={projection({
          visualState: 'paused',
          cue: { headline: 'What changed your mind?', prompt: 'Name one moment' },
        })}
        captionsEnabled={false}
      />,
    );
    expect(screen.getByText('What changed your mind?')).toBeInTheDocument();
    expect(screen.queryByText('Name one moment')).not.toBeInTheDocument();
  });

  it('renders nothing for an empty cue headline', () => {
    const { container } = render(
      <StatusOverlay
        state={projection({ visualState: 'speaking', cue: { headline: '', prompt: 'orphan steer' } })}
        captionsEnabled={false}
      />,
    );
    // No headline, and the prompt never shows on its own.
    expect(screen.queryByText('orphan steer')).not.toBeInTheDocument();
    expect(container.querySelector('p')).toBeNull();
  });
});

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

  it('holds the between-turns "thinking" status on screen (the gap must never go blank)', () => {
    vi.useFakeTimers();
    render(
      <StatusOverlay state={projection({ visualState: 'thinking' })} captionsEnabled={false} />,
    );
    expect(screen.getByText('Thinking')).toHaveAttribute('data-visible', 'true');
    // The working gap must not fade like a transient cue — it is the moment the
    // founder reported as "it just stopped". Still visible well past the old 2.4s.
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('Thinking')).toHaveAttribute('data-visible', 'true');
  });

  it('keeps the new "Answer now" cue visible across a thinking → listening handoff', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <StatusOverlay state={projection({ visualState: 'thinking' })} captionsEnabled={false} />,
    );
    act(() => vi.advanceTimersByTime(2000));
    rerender(
      <StatusOverlay
        state={projection({ visualState: 'listening', micState: 'armed' })}
        captionsEnabled={false}
      />,
    );
    // The stale timer must not fire against the now-persistent listening cue.
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('Answer now')).toHaveAttribute('data-visible', 'true');
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
