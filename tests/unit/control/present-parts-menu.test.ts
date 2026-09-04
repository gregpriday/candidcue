/**
 * The launch menu's part rows (§parts).
 *
 * These pin the two properties the rows are actually for: that choosing one
 * hands the caller the part (and not just a token, which is all the marker rows
 * it replaced ever carried), and that a truncated list SAYS it is truncated.
 * The second is the defect the marker rows had — an eight-row cap that silently
 * dropped everything past it.
 */
import { describe, expect, it } from 'vitest';
import { startMenuItems, type StartMenuInput } from '../../../src/control/lib/present-menu';
import type { ScriptPart } from '../../../src/shared/contracts';

function part(ordinal: number, label: string, start: number, end: number): ScriptPart {
  return {
    id: `p${ordinal}`,
    label,
    ordinal,
    startTokenIndex: start,
    endTokenIndex: end,
    origin: 'marker',
  };
}

function input(overrides: Partial<StartMenuInput> = {}): StartMenuInput {
  return {
    hereTokenIndex: null,
    hereLabel: null,
    herePart: null,
    lastEndingTokenIndex: null,
    lastEndingLabel: null,
    parts: [],
    ...overrides,
  };
}

describe('startMenuItems part rows', () => {
  it('offers nothing but the beginning for a script with no parts', () => {
    const items = startMenuItems(input(), () => {});
    expect(items.map((i) => i.label)).toEqual(['From beginning']);
  });

  it('offers one row per part, numbered and named', () => {
    const items = startMenuItems(
      input({ parts: [part(1, 'Opening', 0, 9), part(2, 'Pricing', 10, 19)] }),
      () => {},
    );
    expect(items.map((i) => i.label)).toEqual([
      'From beginning',
      'Part 1 · Opening',
      'Part 2 · Pricing',
    ]);
  });

  it('says where each part is done without promising a stop', () => {
    // The bound is advisory: nothing halts at the boundary and reading on is
    // allowed. Copy that said "ends where Pricing begins" described a feature
    // this deliberately does not have.
    const items = startMenuItems(
      input({ parts: [part(1, 'Opening', 0, 9), part(2, 'Pricing', 10, 19)] }),
      () => {},
    );
    expect(items[1]?.description).toBe(
      'Part 1 of 2. Done where “Pricing” begins; carries on if you do.',
    );
    expect(items[2]?.description).toBe('Part 2 of 2. Done at the end of the script.');
  });

  it('hands the chosen part to the caller, not only its start token', () => {
    const chosen: Array<[number, ScriptPart | undefined]> = [];
    const parts = [part(1, 'Opening', 0, 9), part(2, 'Pricing', 10, 19)];
    const items = startMenuItems(input({ parts }), (token, p) => chosen.push([token, p]));
    items.find((i) => i.label === 'Part 2 · Pricing')?.onselect();
    expect(chosen).toEqual([[10, parts[1]]]);
  });

  it('starts an unbounded take from the beginning row', () => {
    const chosen: Array<[number, ScriptPart | undefined]> = [];
    const items = startMenuItems(
      input({ parts: [part(1, 'Opening', 0, 9), part(2, 'Pricing', 10, 19)] }),
      (token, p) => chosen.push([token, p]),
    );
    items[0]?.onselect();
    expect(chosen).toEqual([[0, undefined]]);
  });

  it('says so when there are more parts than rows, instead of dropping them quietly', () => {
    const parts = Array.from({ length: 15 }, (_, i) =>
      part(i + 1, `Part ${i + 1}`, i * 10, i * 10 + 9),
    );
    const items = startMenuItems(input({ parts }), () => {});
    const overflow = items[items.length - 1]!;
    expect(overflow.label).toBe('3 more parts below');
    expect(overflow.disabled).toBe(true);
    // Twelve rows plus the beginning plus the overflow notice.
    expect(items).toHaveLength(14);
  });

  it('uses the singular for a single hidden part', () => {
    const parts = Array.from({ length: 13 }, (_, i) =>
      part(i + 1, `Part ${i + 1}`, i * 10, i * 10 + 9),
    );
    const items = startMenuItems(input({ parts }), () => {});
    expect(items[items.length - 1]?.label).toBe('1 more part below');
  });

  it('adds no overflow notice when every part fits', () => {
    const parts = Array.from({ length: 12 }, (_, i) =>
      part(i + 1, `Part ${i + 1}`, i * 10, i * 10 + 9),
    );
    const items = startMenuItems(input({ parts }), () => {});
    expect(items.some((i) => i.disabled === true)).toBe(false);
  });

  it('records the part the caret sits in when "From here" is chosen', () => {
    // The overflow notice tells anybody with more than twelve parts to reach
    // the rest this way, so this row has to actually bound the take.
    const chosen: Array<[number, ScriptPart | undefined]> = [];
    const parts = [part(1, 'Opening', 0, 9), part(2, 'Pricing', 10, 19)];
    const items = startMenuItems(
      input({ hereTokenIndex: 14, hereLabel: 'From here', herePart: parts[1]!, parts }),
      (token, p) => chosen.push([token, p]),
    );
    const here = items.find((i) => i.label === 'From here')!;
    expect(here.description).toContain('Records part 2');
    here.onselect();
    expect(chosen).toEqual([[14, parts[1]]]);
  });

  it('leaves "From here" unbounded on an undivided script', () => {
    const chosen: Array<[number, ScriptPart | undefined]> = [];
    const items = startMenuItems(
      input({ hereTokenIndex: 14, hereLabel: 'From here', herePart: null }),
      (token, p) => chosen.push([token, p]),
    );
    items.find((i) => i.label === 'From here')?.onselect();
    expect(chosen).toEqual([[14, undefined]]);
  });

  it('keeps the here and last-ending rows above the parts', () => {
    const items = startMenuItems(
      input({
        hereTokenIndex: 5,
        hereLabel: 'From “Opening”',
        lastEndingTokenIndex: 12,
        lastEndingLabel: 'somewhere',
        parts: [part(1, 'Opening', 0, 9), part(2, 'Pricing', 10, 19)],
      }),
      () => {},
    );
    expect(items.map((i) => i.label)).toEqual([
      'From beginning',
      'From here',
      'From last ending',
      'Part 1 · Opening',
      'Part 2 · Pricing',
    ]);
  });
});
