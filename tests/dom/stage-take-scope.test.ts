/**
 * What is running, said on the glass (#241).
 *
 * A practice and a take used to look identical while reading, and the part a
 * take was recording was readable only in a drawer closed over the script.
 * This drives the real bridge props into a mounted embedded stage and checks
 * the label: what it says, that it is in the mirrored talent plane (so a
 * beamsplitter reads it the right way round), which corner it takes under a
 * mirror, and that a blank hides it.
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

function envelope(
  mirror: { mirrorX?: boolean; mirrorY?: boolean; readingBandCenterPercent?: number } = {},
): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    sessionGeneration: 1,
    stageGeneration: 0,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'hash-abc',
    compileRevision: 1,
    stageSettings: buildStageSettings(mirror),
    renderDocument: renderDocument(),
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

/** Mount and WAIT for the script layer, the same way stage-embedded-blank.test.ts does. */
async function mount(bridge: Record<string, unknown>, env: StageSessionEnvelope = envelope()) {
  const result = render(StageApp, {
    props: {
      embedded: {
        envelope: env,
        alignment: null,
        transcript: '',
        voicePill: null,
        onexit: vi.fn(),
        onintent: vi.fn<(intent: StageIntent) => void>(),
        ...bridge,
      },
    } as never,
  });
  await vi.advanceTimersByTimeAsync(20);
  flushSync();
  if (!result.container.querySelector('.script-layer')) {
    throw new Error('the script layer never mounted; this test would prove nothing');
  }
  return result;
}

const PART = { id: 'p3', label: 'Pricing', ordinal: 3, totalParts: 5, startTokenIndex: 0, endTokenIndex: 2 };

function label(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.take-scope');
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllTimers();
});

function bridge(env: StageSessionEnvelope, extra: Record<string, unknown>) {
  return {
    embedded: {
      envelope: env,
      alignment: null,
      transcript: '',
      voicePill: null,
      onexit: vi.fn(),
      onintent: vi.fn(),
      ...extra,
    },
  } as never;
}

describe('the take-scope label', () => {
  it('says nothing over an ordinary take of the whole script', async () => {
    const { container } = await mount({ practice: false, part: null });
    expect(label(container)).toBeNull();
  });

  it('says Practising over a practice, without opening the dock', async () => {
    const { container } = await mount({ practice: true });
    expect(label(container)?.querySelector('.take-scope-lead')?.textContent).toBe('Practising');
    expect(label(container)?.querySelector('.take-scope-name')).toBeNull();
  });

  it('names the part a take is recording, and marks its end when it is reached', async () => {
    const env = envelope();
    const { container, rerender } = await mount({ part: PART, partComplete: false }, env);
    expect(label(container)?.querySelector('.take-scope-lead')?.textContent).toBe('Part 3 of 5');
    expect(label(container)?.querySelector('.take-scope-name')?.textContent).toBe('Pricing');
    expect(label(container)?.querySelector('.take-scope-done')).toBeNull();

    // The same envelope: only the latch moves, as it does mid-take.
    await rerender(bridge(env, { part: PART, partComplete: true }));
    flushSync();
    expect(label(container)?.querySelector('.take-scope-done')?.textContent).toBe('end reached');
  });

  it('says both over a practice of a part, name and end included', async () => {
    const { container } = await mount({ practice: true, part: PART, partComplete: true });
    const el = label(container)!;
    expect(el.querySelector('.take-scope-lead')?.textContent).toBe('Practising · Part 3 of 5');
    expect(el.querySelector('.take-scope-name')?.textContent).toBe('Pricing');
    expect(el.querySelector('.take-scope-done')?.textContent).toBe('end reached');
    // Separators are text, not generated content, so the words never run together.
    expect(el.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Practising · Part 3 of 5 · Pricing · end reached',
    );
  });

  it('is read through the glass: inside the safe rectangle of the mirrored talent plane', async () => {
    const { container } = await mount({ practice: true });
    const el = label(container)!;
    expect(el.closest('.stage-safe-plane')).not.toBeNull();
    expect(el.closest('.stage-talent-plane')).not.toBeNull();
    expect(el.closest('.stage-operator-plane')).toBeNull();
  });

  it('keeps to the physical side opposite the dock under a horizontal mirror only', async () => {
    const plain = await mount({ practice: true });
    expect(label(plain.container)?.classList.contains('flip-x')).toBe(false);
    document.body.innerHTML = '';

    const flippedY = await mount({ practice: true }, envelope({ mirrorY: true }));
    expect(label(flippedY.container)?.classList.contains('flip-x')).toBe(false);
    document.body.innerHTML = '';

    const flippedX = await mount({ practice: true }, envelope({ mirrorX: true }));
    expect(flippedX.container.querySelector('.stage-talent-plane')?.getAttribute('data-mirror-x')).toBe(
      'true',
    );
    expect(label(flippedX.container)?.classList.contains('flip-x')).toBe(true);
  });

  it('takes the edge away from the reading band', async () => {
    const usual = await mount({ practice: true }, envelope({ readingBandCenterPercent: 38 }));
    expect(label(usual.container)?.dataset['edge']).toBe('bottom');
    expect(label(usual.container)?.style.bottom).not.toBe('');
    expect(label(usual.container)?.style.top).toBe('');
    document.body.innerHTML = '';

    // A camera below the screen puts the band low on the glass.
    const low = await mount({ practice: true }, envelope({ readingBandCenterPercent: 70 }));
    expect(label(low.container)?.dataset['edge']).toBe('top');
    expect(label(low.container)?.style.top).not.toBe('');
    expect(label(low.container)?.style.bottom).toBe('');
  });

  it('is not a live region: the drawer already announces the part', async () => {
    const { container } = await mount({ practice: true, part: PART });
    expect(label(container)?.getAttribute('role')).toBeNull();
    expect(label(container)?.getAttribute('aria-live')).toBeNull();
  });

  it('goes with everything else on a blank, and comes back after it', async () => {
    const env = envelope();
    const { container, rerender } = await mount({ practice: true, blanked: false }, env);
    expect(label(container)).not.toBeNull();
    await rerender(bridge(env, { practice: true, blanked: true }));
    flushSync();
    expect(label(container)).toBeNull();
    await rerender(bridge(env, { practice: true, blanked: false }));
    flushSync();
    expect(label(container)).not.toBeNull();
  });
});
