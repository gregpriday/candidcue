// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectSummary } from '@shared/domain';
import { HomeScreen } from '../../src/renderer/control/routes/HomeScreen';

type Resumable = { sessionId: string; projectId: string; projectTitle: string; startedAt: string | null };

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'proj-1',
    title: 'My project',
    status: 'draft',
    planState: 'ready',
    interviewerCharacterId: 'mira',
    sessionCount: 0,
    lastSessionAt: null,
    updatedAt: '2026-06-29T10:00:00.000Z',
    ...overrides,
  };
}

/** Wire `window.candidcue` with the three calls HomeScreen makes on mount.
 *  Missing any one causes unhandled rejections that surface as flaky warnings. */
function mockApi(opts: {
  resumable?: Resumable[];
  resumableError?: boolean;
  projects?: ProjectSummary[];
}): void {
  const resumableFn = opts.resumableError
    ? vi.fn().mockRejectedValue(new Error('boom'))
    : vi.fn().mockResolvedValue(opts.resumable ?? []);
  (window as unknown as { candidcue: unknown }).candidcue = {
    sessions: { resumable: resumableFn },
    projects: { list: vi.fn().mockResolvedValue(opts.projects ?? []) },
    characters: { list: vi.fn().mockResolvedValue([]) },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { candidcue?: unknown }).candidcue;
});

describe('HomeScreen — resumable sessions', () => {
  it('lists interrupted sessions and resumes into preflight on click', async () => {
    const session: Resumable = {
      sessionId: 's1',
      projectId: 'proj-42',
      projectTitle: 'Founding story',
      startedAt: '2026-06-29T10:00:00.000Z',
    };
    mockApi({ resumable: [session] });
    const nav = { go: vi.fn() };
    const user = userEvent.setup();

    render(<HomeScreen nav={nav} />);

    expect(await screen.findByRole('heading', { name: 'Interrupted interviews' })).toBeInTheDocument();
    expect(screen.getByText('Founding story')).toBeInTheDocument();

    // Both the row and its trailing CTA carry the same per-session label; either
    // resumes the same session.
    await user.click(screen.getAllByRole('button', { name: 'Resume Founding story' })[0]);

    expect(nav.go).toHaveBeenCalledWith({ name: 'preflight', projectId: 'proj-42' });
    expect(nav.go).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'operator' }));
  });

  it('resumes each session into its own project', async () => {
    mockApi({
      resumable: [
        { sessionId: 's1', projectId: 'proj-1', projectTitle: 'Alpha', startedAt: null },
        { sessionId: 's2', projectId: 'proj-2', projectTitle: 'Beta', startedAt: null },
      ],
    });
    const nav = { go: vi.fn() };
    const user = userEvent.setup();

    render(<HomeScreen nav={nav} />);

    // Click the trailing CTA for each row (the row button shares the same label).
    await user.click((await screen.findAllByRole('button', { name: 'Resume Alpha' }))[1]);
    await user.click(screen.getAllByRole('button', { name: 'Resume Beta' })[1]);

    expect(nav.go).toHaveBeenNthCalledWith(1, { name: 'preflight', projectId: 'proj-1' });
    expect(nav.go).toHaveBeenNthCalledWith(2, { name: 'preflight', projectId: 'proj-2' });
  });

  it('omits the section when there are no resumable sessions', async () => {
    mockApi({ resumable: [] });
    render(<HomeScreen nav={{ go: vi.fn() }} />);

    // The empty project list settles into its own empty state.
    expect(await screen.findByText('Start your first interview')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Interrupted interviews' })).not.toBeInTheDocument();
  });

  it('omits the section and still renders projects when the resumable fetch fails', async () => {
    mockApi({ resumableError: true, projects: [project({ title: 'My project' })] });
    render(<HomeScreen nav={{ go: vi.fn() }} />);

    // The project list is independent of the resumable fetch and renders normally.
    expect(await screen.findByText('My project')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Interrupted interviews' })).not.toBeInTheDocument();
  });

  it('renders a session with no start time without crashing', async () => {
    mockApi({
      resumable: [{ sessionId: 's2', projectId: 'proj-7', projectTitle: 'Untimed run', startedAt: null }],
    });
    render(<HomeScreen nav={{ go: vi.fn() }} />);

    expect(await screen.findByText('Untimed run')).toBeInTheDocument();
    expect(screen.getByText('Started never')).toBeInTheDocument();
  });
});
