/**
 * CoachRail — mounted, because the whole point of this task is that a presenter
 * SEES the rail. The component and its ~1013 lane tests were green while nothing
 * rendered it; these tests fail if the rail stops rendering a snapshot's data.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it, beforeAll } from 'vitest';
import CoachRail from '../../src/stage/renderer/coach/CoachRail.svelte';
import {
  initialPaceState,
  initialVarietyState,
  initialFillerState,
  initialMicrophoneState,
} from '../../src/shared/coaching/coach/coach-state';
import type { CoachRailState } from '../../src/shared/contracts/coaching';

// Svelte 5's `bind:clientWidth` installs a ResizeObserver; jsdom has none.
beforeAll(() => {
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

function railState(overrides: Partial<CoachRailState> = {}): CoachRailState {
  return {
    schemaVersion: 1,
    stageRevision: 1,
    sessionId: '00000000-0000-0000-0000-000000000001',
    takePassId: 'take-1',
    mode: 'coach',
    modules: {
      paceNumber: true,
      paceStatus: true,
      paceSparkline: false,
      targetDurationStatus: false,
      varietyScore: true,
      varietyLabel: true,
      fillerCount: true,
      fillerRibbon: true,
      gutterMarks: false,
      liveTips: true,
    },
    audioTimeMs: 1000,
    visible: true,
    mirrored: false,
    reducedMotion: false,
    pace: { ...initialPaceState(130, 170), wpm: 152, confidence: 0.9, state: 'on_target' },
    variety: { ...initialVarietyState(0.4, 0.7), level: 55, confidence: 0.8, state: 'balanced' },
    fillers: { ...initialFillerState(), confirmedCount: 2 },
    microphone: { ...initialMicrophoneState(), status: 'ok' },
    activeTip: null,
    ribbonEvents: [],
    gutterMarks: [],
    ...overrides,
  };
}

describe('CoachRail (§6–§11) mount', () => {
  it('renders the band and the pace number from the snapshot', () => {
    const { container } = render(CoachRail, {
      props: { snapshot: railState(), viewportHeightPx: 900, columnWidthPercent: 68 },
    });
    const rail = container.querySelector('.coach-rail');
    expect(rail, 'the reserved band must render').not.toBeNull();
    const pace = container.querySelector('[data-field="pace-number"]');
    expect(pace?.textContent?.trim(), 'the pace number must come from the snapshot').toBe('152');
  });

  it('reserves the band even before the first snapshot (no reflow)', () => {
    const { container } = render(CoachRail, {
      props: { snapshot: null, viewportHeightPx: 900 },
    });
    const rail = container.querySelector('.coach-rail');
    expect(rail, 'the band exists before any snapshot').not.toBeNull();
    // Height is reserved (non-zero) with no snapshot at all.
    const heightPx = Number.parseFloat((rail as HTMLElement).style.height);
    expect(heightPx).toBeGreaterThan(0);
  });

  it('hides contents when visible is false but keeps the band reserved (§7.1)', () => {
    const { container } = render(CoachRail, {
      props: { snapshot: railState({ visible: false }), viewportHeightPx: 900 },
    });
    const rail = container.querySelector('.coach-rail') as HTMLElement;
    expect(rail, 'the band stays reserved when hidden').not.toBeNull();
    const contents = container.querySelector('.contents');
    // The band geometry survives; only the contents fade.
    expect(contents?.classList.contains('hidden')).toBe(true);
    expect(Number.parseFloat(rail.style.height)).toBeGreaterThan(0);
  });
});
