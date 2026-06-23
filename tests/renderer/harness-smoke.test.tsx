// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Validates the renderer test harness end to end — the jsdom environment, the
 * `@vitejs/plugin-react` JSX transform, React Testing Library rendering/queries,
 * `user-event` interaction, and `jest-dom` matchers. Intentionally self-contained
 * (no app component imports) so it stays green across the in-flight UI redesign.
 */
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      count: {count}
    </button>
  );
}

describe('renderer test harness', () => {
  it('renders a component and reacts to user events', async () => {
    const user = userEvent.setup();
    render(<Counter />);

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('count: 0');

    await user.click(button);
    expect(button).toHaveTextContent('count: 1');
  });
});
