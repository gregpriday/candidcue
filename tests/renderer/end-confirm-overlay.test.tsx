// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EndConfirmOverlay } from '../../src/renderer/stage/components/EndConfirmOverlay';

afterEach(() => {
  cleanup();
});

describe('EndConfirmOverlay', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <EndConfirmOverlay open={false} onClose={() => {}} onConfirm={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('renders an accessible confirm dialog when open', () => {
    render(<EndConfirmOverlay open onClose={() => {}} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Labelled + described by the title/copy for assistive tech.
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(screen.getByText('End the interview?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep going' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End interview' })).toBeInTheDocument();
  });

  it('focuses the safe "Keep going" action on open', () => {
    render(<EndConfirmOverlay open onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole('button', { name: 'Keep going' })).toHaveFocus();
  });

  it('dispatches the end action only on the explicit "End interview" press', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<EndConfirmOverlay open onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'End interview' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without ending on "Keep going"', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<EndConfirmOverlay open onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('closes without ending on Escape', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<EndConfirmOverlay open onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('closes without ending when the backdrop is pressed', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<EndConfirmOverlay open onClose={onClose} onConfirm={onConfirm} />);

    // The scrim is the dialog's parent; a press on it (not the panel) closes.
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
