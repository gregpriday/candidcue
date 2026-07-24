<!--
  One coherent bundled outline icon set (spec §11.7). Icons supplement labels;
  IconButton supplies accessible names where an icon stands alone.
-->
<script lang="ts" module>
  export type IconName =
    | 'plus'
    | 'search'
    | 'import'
    | 'export'
    | 'trash'
    | 'restore'
    | 'settings'
    | 'doc'
    | 'chevron-left'
    | 'chevron-right'
    | 'chevron-down'
    | 'chevron-up'
    | 'dots'
    | 'play'
    | 'pause'
    | 'stop'
    | 'mic'
    | 'monitor'
    | 'check'
    | 'alert'
    | 'info'
    | 'x'
    | 'pencil'
    | 'link'
    | 'image'
    | 'flag'
    | 'eye'
    | 'eye-off'
    | 'keyboard'
    | 'refresh'
    | 'external'
    | 'user'
    | 'clock'
    | 'diagram';

  /** Static stroke markup per icon — internal constants only, safe for @html. */
  const PATHS: Record<IconName, string> = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20.3 20.3 16.6 16.6"/>',
    import: '<path d="M12 4v10m0 0 4.2-4.2M12 14 7.8 9.8M5 19h14"/>',
    export: '<path d="M12 14V4m0 0L7.8 8.2M12 4l4.2 4.2M5 19h14"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13.5h9l1-13.5M10 11v6M14 11v6"/>',
    restore: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 3.5V9H9"/>',
    settings:
      '<path d="M4 7.5h8M17 7.5h3M4 16.5h3M12 16.5h8"/><circle cx="14.5" cy="7.5" r="2.2"/><circle cx="9.5" cy="16.5" r="2.2"/>',
    doc: '<path d="M7 3.5h6.5L18 8v12.5H7zM13.5 3.5V8H18M10 12.5h5M10 16h5"/>',
    'chevron-left': '<path d="M14.5 6 8.5 12l6 6"/>',
    'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
    'chevron-down': '<path d="M6 9.5l6 6 6-6"/>',
    'chevron-up': '<path d="M6 14.5l6-6 6 6"/>',
    dots: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    pause:
      '<rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M9 20.5h6M12 16.5v4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 3.5 21.5 20h-19zM12 10v4.5M12 17.4v.1"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    pencil: '<path d="M4.5 19.5l.9-3.6L16.6 4.7a1.8 1.8 0 0 1 2.6 0l.1.1a1.8 1.8 0 0 1 0 2.6L8.1 18.6z"/>',
    link: '<path d="M9.5 14.5l5-5M8 16.5l-1.2 1.2a3.5 3.5 0 0 1-5-5L4 10.5M16 7.5l1.2-1.2a3.5 3.5 0 0 1 5 5L20 13.5" transform="translate(0.5 0)"/>',
    image:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5 10 12l4 4 3-3 2.5 2.5"/>',
    flag: '<path d="M6 21V4M6 4.5h11.5L14.5 8.5l3 4H6"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off':
      '<path d="M4 4l16 16M9.9 5.9A9.5 9.5 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-3.2 3.9M6 7.5A16.9 16.9 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 3.5-.7"/>',
    keyboard:
      '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><path d="M6 10h.1M10 10h.1M14 10h.1M18 10h.1M7 14h10"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 3.5V9h-5.5"/>',
    external: '<path d="M10 5H5v14h14v-5M14 4.5h5.5V10M19 5l-8 8"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.5l3.5 2"/>',
    diagram:
      '<rect x="3.5" y="3.5" width="6" height="5" rx="1"/><rect x="14.5" y="15.5" width="6" height="5" rx="1"/><path d="M6.5 8.5V15a2 2 0 0 0 2 2h6"/>',
  };

  export function iconMarkup(name: IconName): string {
    return PATHS[name];
  }
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: number;
  }
  let { name, size = 18 }: Props = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags — static internal constants -->
  {@html iconMarkup(name)}
</svg>

<style>
  .icon {
    flex: 0 0 auto;
    display: block;
  }
</style>
