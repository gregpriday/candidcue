/**
 * BrandMark is the app icon drawn in the page, so its tile is the icon's
 * literal colour rather than a theme token. Nothing renders the two side by
 * side, so a recolour of one that misses the other would ship unnoticed: this
 * holds the component's tile to the flat fill of the small icon drawing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BrandMark from '../../../src/control/components/BrandMark.svelte';

const ICON_SMALL = fileURLToPath(
  new URL('../../../src-tauri/icons/source/icon-small.svg', import.meta.url),
);

describe('BrandMark', () => {
  it('draws its tile in the app icon colour', () => {
    const { body } = render(BrandMark, { props: {} });
    const markTile = body.match(/<rect width="24" height="24"[^>]*fill="(#[0-9a-f]{6})"/i)?.[1];
    const iconTile = readFileSync(ICON_SMALL, 'utf8').match(/<path d="M30[^"]*" fill="(#[0-9a-f]{6})"/i)?.[1];
    expect(markTile?.toLowerCase()).toBe(iconTile?.toLowerCase() ?? 'icon-small.svg tile not found');
  });
});
