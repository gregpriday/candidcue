// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceList, type SourceListItem } from '../../src/renderer/control/components/SourceList';

function items(): SourceListItem[] {
  return [
    { key: 'p', title: 'Founding story', characters: 1200, empty: false },
    { key: 'a', title: 'Market notes', characters: 300, empty: false },
    { key: 'b', title: 'Press kit', characters: 0, empty: true },
  ];
}

/** Six sources so the search box (gated to ≥6) is present. */
function manyItems(): SourceListItem[] {
  return [
    ...items(),
    { key: 'c', title: 'Roadmap', characters: 500, empty: false },
    { key: 'd', title: 'Customer quotes', characters: 700, empty: false },
    { key: 'e', title: 'Pricing memo', characters: 400, empty: false },
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
      onReorder={vi.fn()}
      totalCharacters={1500}
      documentCount={3}
      {...props}
    />
  );
}

describe('SourceList', () => {
  it('renders every source as a listbox option', () => {
    render(<Harness />);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Founding story');
  });

  it('hides the search box until there are enough sources', () => {
    render(<Harness />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('ignores a stale query when the search box is hidden (<6 sources)', () => {
    render(
      <SourceList
        items={items()}
        selectedKey="p"
        query="press"
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
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
    await user.type(screen.getByRole('searchbox', { name: 'Search sources' }), 'press');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Press kit');
  });

  it('reorders a source down via its move control', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    // "Market notes" is at index 1; moving it down targets index 2.
    await user.click(screen.getByRole('button', { name: /Move .*Market notes.* down/ }));
    expect(onReorder).toHaveBeenCalledWith('a', 2);
  });

  it('moves relative to the next visible row when a search filter is active', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    render(<Harness items={manyItems()} documentCount={6} onReorder={onReorder} />);
    // "o" matches every title except "Press kit" (items index 2), so the visible
    // list is non-contiguous: [Founding story, Market notes, Roadmap, …].
    await user.type(screen.getByRole('searchbox', { name: 'Search sources' }), 'o');
    // Moving "Market notes" (index 1) down must target the next *visible* row
    // "Roadmap" (index 3), not the hidden "Press kit" (index 2).
    await user.click(screen.getByRole('button', { name: /Move .*Market notes.* down/ }));
    expect(onReorder).toHaveBeenCalledWith('a', 3);
  });

  it('disables move-up on the first source and move-down on the last', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Move .*Founding story.* up/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Move .*Press kit.* down/ })).toBeDisabled();
  });

  it('shows an empty-state message when the query matches nothing', async () => {
    const user = userEvent.setup();
    render(<Harness items={manyItems()} documentCount={6} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search sources' }), 'zzz');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText(/No sources match/)).toBeInTheDocument();
  });
});
