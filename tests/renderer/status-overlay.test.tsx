// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    expect(screen.getByText('Check CandidCue to retry the session.')).toBeInTheDocument();
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

  it('suppresses stale captions while in the error state', () => {
    render(
      <StatusOverlay
        state={projection({ visualState: 'error', captions: 'a leftover caption line' })}
        captionsEnabled
      />,
    );
    expect(screen.queryByText('a leftover caption line')).not.toBeInTheDocument();
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
