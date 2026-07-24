/**
 * The icon set is a single coherent Lucide set (spec §11.7). These assertions
 * pin the two things that silently drift: which Lucide glyph each product-level
 * name resolves to, and the one stroke width the whole set is drawn at.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Icon, { ICON_STROKE_WIDTH, type IconName } from '../../../src/control/components/Icon.svelte';

/** Product name → the Lucide glyph it must resolve to. */
const MAPPING: Record<IconName, string> = {
  plus: 'plus',
  search: 'search',
  import: 'import',
  export: 'upload',
  trash: 'trash-2',
  restore: 'rotate-ccw',
  settings: 'settings-2',
  doc: 'file-text',
  'chevron-left': 'chevron-left',
  'chevron-right': 'chevron-right',
  'chevron-down': 'chevron-down',
  'chevron-up': 'chevron-up',
  dots: 'ellipsis',
  play: 'play',
  pause: 'pause',
  stop: 'square',
  mic: 'mic',
  monitor: 'monitor',
  check: 'check',
  alert: 'triangle-alert',
  info: 'info',
  x: 'x',
  pencil: 'pencil',
  link: 'link',
  image: 'image',
  flag: 'flag',
  gauge: 'gauge',
  eye: 'eye',
  'eye-off': 'eye-off',
  keyboard: 'keyboard',
  refresh: 'refresh-cw',
  external: 'external-link',
  user: 'user',
  clock: 'clock',
  diagram: 'workflow',
};

const NAMES = Object.keys(MAPPING) as IconName[];

describe('Icon', () => {
  it('draws the whole set at one stroke width', () => {
    expect(ICON_STROKE_WIDTH).toBe(1.75);
  });

  it('resolves every product name to its Lucide glyph', () => {
    for (const name of NAMES) {
      const { body } = render(Icon, { props: { name } });
      expect(body, name).toContain(`lucide-${MAPPING[name]}"`);
    }
  });

  it('renders inheritable, self-contained, decorative SVG', () => {
    for (const name of NAMES) {
      const { body } = render(Icon, { props: { name, size: 16 } });
      expect(body, name).toContain('stroke="currentColor"');
      expect(body, name).toContain(`stroke-width="${ICON_STROKE_WIDTH}"`);
      expect(body, name).toContain('width="16"');
      expect(body, name).toContain('height="16"');
      expect(body, name).toContain('aria-hidden="true"');
      // Geometry is inlined at build time — nothing may reference a remote asset.
      expect(body, name).not.toMatch(/(href|src|url\()/i);
      expect(body, name).toMatch(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/);
    }
  });

  it('honours the size prop', () => {
    const { body } = render(Icon, { props: { name: 'mic', size: 22 } });
    expect(body).toContain('width="22"');
    expect(body).toContain('height="22"');
  });
});
