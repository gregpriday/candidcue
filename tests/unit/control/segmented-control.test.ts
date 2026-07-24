/**
 * SegmentedControl keyboard contract (spec §20).
 *
 * The component declared role="radiogroup"/role="radio"/aria-checked but had
 * no roving tabindex and no keydown handler: every segment was a tab stop and
 * the arrow keys did nothing, which is a broken ARIA promise rather than a
 * missing one. These tests cover the behaviour (which index the arrows land
 * on, which segment is the single tab stop) and then assert the rendered
 * markup actually carries it.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import SegmentedControl from '../../../src/control/components/SegmentedControl.svelte';
import {
  nextSegmentIndex,
  segmentTabIndex,
  selectedIndex,
} from '../../../src/control/components/segmented';

const MODES = [{ value: 'voice' }, { value: 'manual' }, { value: 'fixed' }];

describe('arrow-key selection', () => {
  it('moves forward on ArrowRight and ArrowDown', () => {
    expect(nextSegmentIndex(MODES, 0, 'ArrowRight')).toBe(1);
    expect(nextSegmentIndex(MODES, 0, 'ArrowDown')).toBe(1);
  });

  it('moves backward on ArrowLeft and ArrowUp', () => {
    expect(nextSegmentIndex(MODES, 2, 'ArrowLeft')).toBe(1);
    expect(nextSegmentIndex(MODES, 2, 'ArrowUp')).toBe(1);
  });

  it('wraps at both ends', () => {
    expect(nextSegmentIndex(MODES, 2, 'ArrowRight')).toBe(0);
    expect(nextSegmentIndex(MODES, 0, 'ArrowLeft')).toBe(2);
  });

  it('jumps with Home and End', () => {
    expect(nextSegmentIndex(MODES, 1, 'Home')).toBe(0);
    expect(nextSegmentIndex(MODES, 1, 'End')).toBe(2);
  });

  it('ignores keys that are not part of the pattern', () => {
    expect(nextSegmentIndex(MODES, 0, 'Enter')).toBeNull();
    expect(nextSegmentIndex(MODES, 0, 'a')).toBeNull();
    expect(nextSegmentIndex(MODES, 0, 'Tab')).toBeNull();
  });

  it('skips disabled options instead of landing on them', () => {
    const options = [{ value: 'a' }, { value: 'b', disabled: true }, { value: 'c' }];
    expect(nextSegmentIndex(options, 0, 'ArrowRight')).toBe(2);
    expect(nextSegmentIndex(options, 2, 'ArrowLeft')).toBe(0);
    expect(nextSegmentIndex(options, 0, 'End')).toBe(2);
  });

  it('starts sensibly when nothing is selected yet', () => {
    expect(nextSegmentIndex(MODES, -1, 'ArrowRight')).toBe(0);
    expect(nextSegmentIndex(MODES, -1, 'ArrowLeft')).toBe(2);
  });

  it('does nothing when every option is disabled', () => {
    const options = [{ value: 'a', disabled: true }, { value: 'b', disabled: true }];
    expect(nextSegmentIndex(options, 0, 'ArrowRight')).toBeNull();
    expect(nextSegmentIndex(options, 0, 'Home')).toBeNull();
  });
});

describe('roving tabindex', () => {
  it('makes only the checked segment a tab stop', () => {
    expect(segmentTabIndex(MODES, 'manual', 0)).toBe(-1);
    expect(segmentTabIndex(MODES, 'manual', 1)).toBe(0);
    expect(segmentTabIndex(MODES, 'manual', 2)).toBe(-1);
  });

  it('keeps the group reachable when nothing is checked', () => {
    expect(segmentTabIndex(MODES, '', 0)).toBe(0);
    expect(segmentTabIndex(MODES, '', 1)).toBe(-1);
  });

  it('moves the tab stop off a disabled selection', () => {
    const options = [{ value: 'a', disabled: true }, { value: 'b' }];
    expect(segmentTabIndex(options, 'a', 0)).toBe(-1);
    expect(segmentTabIndex(options, 'a', 1)).toBe(0);
  });

  it('selectedIndex reports -1 for an unknown value', () => {
    expect(selectedIndex(MODES, 'nope')).toBe(-1);
  });
});

describe('rendered markup', () => {
  const html = render(SegmentedControl, {
    props: {
      label: 'Tracking mode',
      value: 'manual',
      options: [
        { value: 'voice', label: 'Voice follow' },
        { value: 'manual', label: 'Manual' },
        { value: 'fixed', label: 'Fixed speed' },
      ],
    },
  }).body;

  it('exposes exactly one tab stop for the whole group', () => {
    expect([...html.matchAll(/tabindex="0"/g)]).toHaveLength(1);
    expect([...html.matchAll(/tabindex="-1"/g)]).toHaveLength(2);
  });

  it('puts the tab stop on the checked radio', () => {
    const tags = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(tags).toHaveLength(3);
    const checked = tags.filter((t) => t.includes('aria-checked="true"'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('tabindex="0"');
    for (const tag of tags.filter((t) => !t.includes('aria-checked="true"'))) {
      expect(tag).toContain('tabindex="-1"');
    }
  });

  it('keeps the radiogroup contract intact', () => {
    expect(html).toContain('role="radiogroup"');
    expect([...html.matchAll(/role="radio"/g)]).toHaveLength(3);
  });
});
