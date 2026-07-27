import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  currentRoute,
  navigate,
  registerNavigationGuard,
  route,
  setInitialRoute,
} from '../../../src/control/stores/router';

describe('router', () => {
  beforeEach(() => {
    setInitialRoute({ name: 'library', view: 'all' });
  });

  it('navigates between routes', async () => {
    const moved = await navigate({ name: 'settings', section: 'inworld' });
    expect(moved).toBe(true);
    expect(get(route)).toEqual({ name: 'settings', section: 'inworld' });
  });

  it('carries route params', async () => {
    await navigate({ name: 'editor', scriptId: 'abc' });
    expect(currentRoute()).toEqual({ name: 'editor', scriptId: 'abc' });
  });

  it('guards can block a transition', async () => {
    const unregister = registerNavigationGuard((to) => to.name !== 'live');
    const blocked = await navigate({ name: 'live', sessionId: 's-1', scriptId: 'abc' });
    expect(blocked).toBe(false);
    expect(currentRoute().name).toBe('library');

    const allowed = await navigate({ name: 'editor', scriptId: 'abc' });
    expect(allowed).toBe(true);
    unregister();
  });

  it('async guards are awaited in order', async () => {
    const calls: string[] = [];
    const un1 = registerNavigationGuard(async () => {
      calls.push('first');
      return true;
    });
    const un2 = registerNavigationGuard(async () => {
      calls.push('second');
      return false;
    });
    const moved = await navigate({ name: 'settings', section: 'general' });
    expect(moved).toBe(false);
    expect(calls).toEqual(['first', 'second']);
    un1();
    un2();
  });
});
