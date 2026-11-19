/**
 * The compiled store remembers the exact text its result was compiled from
 * (#448).
 *
 * "From last ending" may be offered only from a compile of the text on screen.
 * A request superseded by a newer one never reaches the store, so the result in
 * hand can be of older text than the editor holds; the editor revision cannot
 * say whether that text is the same again after an undo. `source` can.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const calls = vi.hoisted(() => ({ compileScript: vi.fn() }));

vi.mock('../../../src/control/services/compiler', () => ({
  compileScript: calls.compileScript,
}));

import { compiled, requestCompile, resetCompiled } from '../../../src/control/stores/compiled';

function output(source: string, stale = false) {
  return { stale, scriptId: 's1', sourceHash: `h:${source}`, script: {}, diagnostics: [] };
}

describe('compiled store source', () => {
  beforeEach(() => {
    resetCompiled();
    calls.compileScript.mockReset();
  });

  it('records the text a ready result was compiled from', async () => {
    calls.compileScript.mockResolvedValueOnce(output('Hello.'));
    await requestCompile('s1', 'Hello.', 0);
    expect(get(compiled).status).toBe('ready');
    expect(get(compiled).source).toBe('Hello.');
  });

  it('keeps the previous text with its result when a newer request is superseded', async () => {
    calls.compileScript.mockResolvedValueOnce(output('Hello.'));
    await requestCompile('s1', 'Hello.', 0);
    // The editor's next compile is overtaken (a take's compile on the same
    // worker), so its result never lands.
    calls.compileScript.mockResolvedValueOnce(output('Hello there.', true));
    await requestCompile('s1', 'Hello there.', 1);
    const state = get(compiled);
    expect(state.status).toBe('compiling');
    expect(state.result?.sourceHash).toBe('h:Hello.');
    // The result in hand still says which text it is of.
    expect(state.source).toBe('Hello.');
  });

  it('has no source without a result', async () => {
    calls.compileScript.mockRejectedValueOnce(new Error('broken'));
    await requestCompile('s1', 'Hello.', 0);
    expect(get(compiled).status).toBe('error');
    expect(get(compiled).source).toBeNull();
    resetCompiled();
    expect(get(compiled).source).toBeNull();
  });
});
