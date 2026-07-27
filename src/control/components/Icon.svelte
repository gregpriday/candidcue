<!--
  One coherent bundled outline icon set (spec §11.7), drawn from Lucide.
  Icons supplement labels; IconButton supplies accessible names where an icon
  stands alone.

  Every glyph is imported individually from `@lucide/svelte/icons/*` so Rollup
  tree-shakes the rest of the ~1600-icon set out of the bundle. Nothing is
  fetched at runtime — the path data is inlined by Vite at build time, which is
  what Tauri's CSP requires.
-->
<script lang="ts" module>
  import type { LucideIcon } from '@lucide/svelte';
  import { ICON_STROKE_WIDTH, type IconName } from './icon-names';

  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import Clock from '@lucide/svelte/icons/clock';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import FileText from '@lucide/svelte/icons/file-text';
  import Flag from '@lucide/svelte/icons/flag';
  import Gauge from '@lucide/svelte/icons/gauge';
  import Image from '@lucide/svelte/icons/image';
  import Import from '@lucide/svelte/icons/import';
  import Info from '@lucide/svelte/icons/info';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Link from '@lucide/svelte/icons/link';
  import Mic from '@lucide/svelte/icons/mic';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Pause from '@lucide/svelte/icons/pause';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Search from '@lucide/svelte/icons/search';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Square from '@lucide/svelte/icons/square';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Upload from '@lucide/svelte/icons/upload';
  import User from '@lucide/svelte/icons/user';
  import Workflow from '@lucide/svelte/icons/workflow';
  import X from '@lucide/svelte/icons/x';

  /**
   * Product name → Lucide glyph. Names stay product-shaped ('doc', 'restore',
   * 'diagram') so call sites read as intent, not as vendor trivia.
   */
  const GLYPHS: Record<IconName, LucideIcon> = {
    plus: Plus,
    search: Search,
    import: Import,
    // Lucide ships no `export` glyph; `upload` is its out-of-the-app counterpart.
    export: Upload,
    trash: Trash2,
    restore: RotateCcw,
    settings: Settings2,
    doc: FileText,
    'chevron-left': ChevronLeft,
    'chevron-right': ChevronRight,
    'chevron-down': ChevronDown,
    'chevron-up': ChevronUp,
    dots: Ellipsis,
    play: Play,
    pause: Pause,
    stop: Square,
    mic: Mic,
    monitor: Monitor,
    check: Check,
    alert: TriangleAlert,
    info: Info,
    x: X,
    pencil: Pencil,
    link: Link,
    image: Image,
    flag: Flag,
    gauge: Gauge,
    eye: Eye,
    'eye-off': EyeOff,
    keyboard: Keyboard,
    refresh: RefreshCw,
    external: ExternalLink,
    user: User,
    clock: Clock,
    diagram: Workflow,
  };

</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: number;
  }
  let { name, size = 18 }: Props = $props();

  const Glyph = $derived(GLYPHS[name]);
</script>

<Glyph {size} strokeWidth={ICON_STROKE_WIDTH} />

<style>
  /*
    Svelte does not scope a `class` handed to a child component, so the layout
    rules live on Lucide's own root class. Icon.svelte is the only thing in the
    app that renders one, so the global reach is exactly this component's.
  */
  :global(.lucide-icon) {
    flex: 0 0 auto;
    display: block;
  }
</style>
