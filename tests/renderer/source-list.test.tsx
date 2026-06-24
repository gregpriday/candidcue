// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceList, type SourceListItem } from '../../src/renderer/control/components/SourceList';

function items(): SourceListItem[] {
  return [
    { key: 'p', title: 'Founding story', isPrimary: true, characters: 1200, overLimit: false, empty: false },
    { key: 'a', title: 'Market notes', isPrimary: false, characters: 300, overLimit: false, empty: false },
    { key: 'b', title: 'Press kit', isPrimary: false, characters: 0, overLimit: false, empty: true },
  ];
}

/** Six references so the search box (gated to ≥6) is present. */
function manyItems(): SourceListItem[] {
  return [
    ...items(),
    { key: 'c', title: 'Roadmap', isPrimary: false, characters: 500, overLimit: false, empty: false },
    { key: 'd', title: 'Customer quotes', isPrimary: false, characters: 700, overLimit: false, empty: false },
    { key: 'e', title: 'Pricing memo', isPrimary: false, characters: 400, overLimit: false, empty: false },
  ];
}

/** Minimal harness that owns the search query so the search box is controllable. */
function Harness(props: Partial<Parameters<typeof SourceList>[0]>) {
  const [query, setQuery] = useState('');
  return (
    <SourceList
      items={items()}
      selectedKey="p"
      query={query}
      onQueryChange={setQuery}
      onSelect={vi.fn()}
      onMakePrimary={vi.fn()}
      onReorder={vi.fn()}
      budget="ok"
      totalCharacters={1500}
      documentCount={3}
      {...props}
    />
  );
}

describe('SourceList', () => {
  it('renders every reference as a listbox option with the primary marked', () => {
    render(<Harness />);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Founding story');
    expect(within(options[0]!).getByLabelText('Primary reference')).toBeInTheDocument();
  });

  it('hides the search box until there are enough references', () => {
    render(<Harness />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('ignores a stale query when the search box is hidden (<6 references)', () => {
    render(
      <SourceList
        items={items()}
        selectedKey="p"
        query="press"
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onMakePrimary={vi.fn()}
        onReorder={vi.fn()}
        budget="ok"
        totalCharacters={1500}
        documentCount={3}
      />,
    );
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('filters the list by the search query', async () => {
    const user = userEvent.setup();
    render(<Harness items={manyItems()} documentCount={6} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search references' }), 'press');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Press kit');
  });

  it('promotes a reference via its make-primary control', async () => {
    const user = userEvent.setup();
    const onMakePrimary = vi.fn();
    render(<Harness onMakePrimary={onMakePrimary} />);
    await user.click(screen.getByRole('button', { name: /Make .*Market notes.* the primary reference/ }));
    expect(onMakePrimary).toHaveBeenCalledWith('a');
  });

  it('reorders a reference down via its move control', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    // "Market notes" is at index 1; moving it down targets index 2.
    await user.click(screen.getByRole('button', { name: /Move .*Market notes.* down/ }));
    expect(onReorder).toHaveBeenCalledWith('a', 2);
  });

  it('disables move-up on the first reference and move-down on the last', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Move .*Market notes.* up/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Move .*Press kit.* down/ })).toBeDisabled();
  });

  it('shows an empty-state message when the query matches nothing', async () => {
    const user = userEvent.setup();
    render(<Harness items={manyItems()} documentCount={6} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search references' }), 'zzz');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText(/No references match/)).toBeInTheDocument();
  });
});
