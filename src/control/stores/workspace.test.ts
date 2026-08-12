/**
 * Workspace layout parsing.
 *
 * `localStorage` is the one input to this application that no schema check
 * protects: it is user-writable, it survives a downgrade, and it is read before
 * anything is painted. A stored width of 40000 is a workspace with no workspace
 * in it, and a stored `NaN` is a layout that never lays out — so the parser
 * treats what it finds as a suggestion, and these tests are the proof.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE,
  DOCUMENT_SCALE_STEPS,
  PANE_LIMITS,
  clamp,
  nearestScaleStep,
  parseWorkspace,
} from './workspace';

describe('parseWorkspace', () => {
  it('returns the defaults for nothing stored', () => {
    expect(parseWorkspace(null)).toEqual(DEFAULT_WORKSPACE);
  });

  it('returns the defaults for text that is not JSON', () => {
    expect(parseWorkspace('{oh no')).toEqual(DEFAULT_WORKSPACE);
  });

  it('returns the defaults for JSON that is not an object', () => {
    expect(parseWorkspace('"a string"')).toEqual(DEFAULT_WORKSPACE);
    expect(parseWorkspace('null')).toEqual(DEFAULT_WORKSPACE);
    expect(parseWorkspace('42')).toEqual(DEFAULT_WORKSPACE);
  });

  it('keeps values that are within range', () => {
    const parsed = parseWorkspace(
      JSON.stringify({ sidebarWidth: 300, outlineWidth: 320, sidebarVisible: false }),
    );
    expect(parsed.sidebarWidth).toBe(300);
    expect(parsed.outlineWidth).toBe(320);
    expect(parsed.sidebarVisible).toBe(false);
  });

  it('clamps a width past its pane maximum', () => {
    const parsed = parseWorkspace(JSON.stringify({ sidebarWidth: 40000 }));
    expect(parsed.sidebarWidth).toBe(PANE_LIMITS.sidebar.max);
  });

  it('clamps a width below its pane minimum', () => {
    const parsed = parseWorkspace(JSON.stringify({ sidebarWidth: -12 }));
    expect(parsed.sidebarWidth).toBe(PANE_LIMITS.sidebar.min);
  });

  it('falls back for a width that is not finite', () => {
    // `JSON.stringify(NaN)` is `null`, which is the shape this actually arrives
    // in — a store written by a build where a division went wrong.
    const parsed = parseWorkspace('{"sidebarWidth": null, "outlineWidth": "wide"}');
    expect(parsed.sidebarWidth).toBe(DEFAULT_WORKSPACE.sidebarWidth);
    expect(parsed.outlineWidth).toBe(DEFAULT_WORKSPACE.outlineWidth);
  });

  it('rejects an editor layout it does not recognise', () => {
    expect(parseWorkspace('{"editorLayout": "three-up"}').editorLayout).toBe(
      DEFAULT_WORKSPACE.editorLayout,
    );
    expect(parseWorkspace('{"editorLayout": "split"}').editorLayout).toBe('split');
  });

  it('snaps a document scale onto a real step', () => {
    // A value between two steps came from somewhere else; snapping means the
    // next Larger/Smaller press lands on a step rather than appearing to do
    // nothing.
    expect(parseWorkspace('{"documentScale": 1.07}').documentScale).toBe(1.1);
    expect(parseWorkspace('{"documentScale": 99}').documentScale).toBe(
      DOCUMENT_SCALE_STEPS[DOCUMENT_SCALE_STEPS.length - 1],
    );
  });

  it('refuses an absurd settings section', () => {
    expect(parseWorkspace('{"settingsSection": ""}').settingsSection).toBe('general');
    expect(parseWorkspace(`{"settingsSection": "${'x'.repeat(200)}"}`).settingsSection).toBe(
      'general',
    );
    expect(parseWorkspace('{"settingsSection": "speech"}').settingsSection).toBe('speech');
  });

  it('ignores a boolean stored as something else', () => {
    expect(parseWorkspace('{"sidebarVisible": "yes"}').sidebarVisible).toBe(true);
    expect(parseWorkspace('{"sidebarVisible": 0}').sidebarVisible).toBe(true);
  });

  it('produces a state every field of the default has', () => {
    // A partial store must not produce a partial state: a missing key here is a
    // pane with an `undefined` width, which lays out as zero.
    const parsed = parseWorkspace('{"sidebarWidth": 240}');
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_WORKSPACE).sort());
  });
});

describe('clamp', () => {
  it('substitutes the fallback for a non-finite value', () => {
    expect(clamp(Number.NaN, 0, 10, 5)).toBe(5);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10, 5)).toBe(5);
  });

  it('bounds a finite value', () => {
    expect(clamp(-1, 0, 10, 5)).toBe(0);
    expect(clamp(11, 0, 10, 5)).toBe(10);
    expect(clamp(7, 0, 10, 5)).toBe(7);
  });
});

describe('nearestScaleStep', () => {
  it('returns a value from the step table', () => {
    for (const value of [0.1, 0.9, 1, 1.05, 1.3, 4]) {
      expect(DOCUMENT_SCALE_STEPS).toContain(nearestScaleStep(value));
    }
  });

  it('leaves a value that is already a step alone', () => {
    for (const step of DOCUMENT_SCALE_STEPS) {
      expect(nearestScaleStep(step)).toBe(step);
    }
  });
});
