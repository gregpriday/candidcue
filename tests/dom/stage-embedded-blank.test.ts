/**
 * The blank switch, reaching the embedded stage (§108).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS A MOUNTED STAGE
 * ---------------------------------------------------------------------------
 * Single-window presentation mounts `StageApp` inside the control window, so
 * there is no separate window's IPC to reach. `toggleBlankStage` kept the
 * session store's own `stageBlanked` correct, but nothing carried it across the
 * embedded bridge, so the operator's own switch did nothing on the one screen
 * most people use.
 *
 * `app.blanked` gates six surfaces, not one (script visibility, the
 * motion/render loop, the ack chip, hold status, the transcript tap and the
 * dock's audio readout) — a single derived read site the way `followPaused`
 * is bridged would have left five of them visibly wrong. This drives the real
 * bridge prop through the real reducer path and checks the surfaces that do
 * not depend on diagnostic mode being on: the script holder, the hold status
 * chip, and the session dock — which stays, so a blank keeps a way out, while
 * its readout goes.
 */
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StageIntent, StageRenderDocument, StageSessionEnvelope } from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';

const StageApp = (await import('../../src/stage/StageApp.svelte')).default;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve(), load: async () => [] },
    });
  }
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

function renderDocument(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Hello there friend', tokenIndexes: [0, 1, 2] }],
        startTokenIndex: 0,
        endTokenIndex: 2,
        source: { utf16Start: 0, utf16End: 18 },
        spoken: true,
      },
    ],
    tokenToNode: [0, 1, 2].map((tokenIndex) => ({ tokenIndex, blockId: 'b1', nodeKey: '' })),
    assets: {},
    sentences: [{ id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 2 }],
  } as unknown as StageRenderDocument;
}

function envelope(): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    sessionGeneration: 1,
    stageGeneration: 0,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'hash-abc',
    compileRevision: 1,
    stageSettings: buildStageSettings({}),
    renderDocument: renderDocument(),
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

/** Mount and WAIT for the script layer, the same way stage-manual-scroll.test.ts does. */
async function mount(blanked: boolean, env: StageSessionEnvelope = envelope()) {
  const onexit = vi.fn();
  const onintent = vi.fn<(intent: StageIntent) => void>();
  const result = render(StageApp, {
    props: {
      embedded: {
        envelope: env,
        alignment: null,
        transcript: '',
        voicePill: null,
        onexit,
        onintent,
        blanked,
      },
    } as never,
  });
  await vi.advanceTimersByTimeAsync(20);
  flushSync();
  if (!result.container.querySelector('.script-layer')) {
    throw new Error('the script layer never mounted; this test would prove nothing');
  }
  return { ...result, env };
}

function phaseOf(container: HTMLElement): string | null {
  return container.querySelector('.stage-root')?.getAttribute('data-phase') ?? null;
}

function scriptHolderBlanked(container: HTMLElement): boolean {
  return container.querySelector('.script-holder')?.classList.contains('blanked') ?? false;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllTimers();
});

describe('mounting embedded, blanked from the start', () => {
  it('opens on every gated surface hidden', async () => {
    const { container } = await mount(true);

    expect(phaseOf(container)).toBe('blank');
    expect(scriptHolderBlanked(container)).toBe(true);
    expect(container.querySelector('.hold-status')).toBeNull();
    expect(container.querySelector('.stage-dock')).not.toBeNull();
    expect(container.querySelector('.stage-dock .dock-audio')).toBeNull();
  });
});

describe('mounting embedded, not blanked', () => {
  it('shows the ordinary surfaces', async () => {
    const { container } = await mount(false);

    expect(phaseOf(container)).not.toBe('blank');
    expect(scriptHolderBlanked(container)).toBe(false);
    expect(container.querySelector('.hold-status')).not.toBeNull();
    expect(container.querySelector('.stage-dock .dock-audio')).not.toBeNull();
  });
});

describe('the switch flipping mid-take', () => {
  it('hides every gated surface together, and restores them together', async () => {
    // The SAME envelope object throughout: each step below changes exactly
    // one thing, so an assertion failure points at the field that moved it.
    const { container, rerender, env } = await mount(false);
    expect(phaseOf(container)).not.toBe('blank');

    await rerender({
      embedded: {
        envelope: env,
        alignment: null,
        transcript: '',
        voicePill: null,
        onexit: vi.fn(),
        onintent: vi.fn(),
        blanked: true,
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    flushSync();

    expect(phaseOf(container)).toBe('blank');
    expect(scriptHolderBlanked(container)).toBe(true);
    expect(container.querySelector('.hold-status')).toBeNull();
    expect(container.querySelector('.stage-dock')).not.toBeNull();
    expect(container.querySelector('.stage-dock .dock-audio')).toBeNull();

    /*
     * An unrelated bridge tick — a transcript word arriving, envelope
     * identity unchanged — must not disturb the blank state.
     */
    await rerender({
      embedded: {
        envelope: env,
        alignment: null,
        transcript: 'hello',
        voicePill: null,
        onexit: vi.fn(),
        onintent: vi.fn(),
        blanked: true,
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    flushSync();
    expect(phaseOf(container)).toBe('blank');
    expect(scriptHolderBlanked(container)).toBe(true);
    expect(container.querySelector('.stage-dock .dock-audio')).toBeNull();

    await rerender({
      embedded: {
        envelope: env,
        alignment: null,
        transcript: 'hello',
        voicePill: null,
        onexit: vi.fn(),
        onintent: vi.fn(),
        blanked: false,
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    flushSync();

    expect(phaseOf(container)).not.toBe('blank');
    expect(scriptHolderBlanked(container)).toBe(false);
    expect(container.querySelector('.hold-status')).not.toBeNull();
    expect(container.querySelector('.stage-dock .dock-audio')).not.toBeNull();
  });
});
