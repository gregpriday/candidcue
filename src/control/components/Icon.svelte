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

  import BookOpen from '@lucide/svelte/icons/book-open';
  import Bold from '@lucide/svelte/icons/bold';
  import CaseSensitive from '@lucide/svelte/icons/case-sensitive';
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
  import Heading from '@lucide/svelte/icons/heading';
  import Image from '@lucide/svelte/icons/image';
  import Import from '@lucide/svelte/icons/import';
  import Info from '@lucide/svelte/icons/info';
  import Italic from '@lucide/svelte/icons/italic';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Link from '@lucide/svelte/icons/link';
  import Mic from '@lucide/svelte/icons/mic';
  import Monitor from '@lucide/svelte/icons/monitor';
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import Pause from '@lucide/svelte/icons/pause';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Regex from '@lucide/svelte/icons/regex';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Search from '@lucide/svelte/icons/search';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Square from '@lucide/svelte/icons/square';
  import StickyNote from '@lucide/svelte/icons/sticky-note';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Upload from '@lucide/svelte/icons/upload';
  import User from '@lucide/svelte/icons/user';
  import WholeWord from '@lucide/svelte/icons/whole-word';
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
  'book-open': BookOpen,
    check: Check,
    alert: TriangleAlert,
    info: Info,
    x: X,
    pencil: Pencil,
    // The formatting row's own marks, drawn rather than typeset so they share
    // the set's stroke and scale with the icons beside them.
    heading: Heading,
    bold: Bold,
    italic: Italic,
    link: Link,
    image: Image,
    flag: Flag,
    // A note to the presenter that is never read aloud. Not `info`, which is a
    // lint note in the status bar of the same window.
    cue: StickyNote,
    gauge: Gauge,
    eye: Eye,
    'eye-off': EyeOff,
    keyboard: Keyboard,
    refresh: RefreshCw,
    external: ExternalLink,
    user: User,
    clock: Clock,
    diagram: Workflow,
    // The trailing inspector, shown or hidden — the Editor's Outline toggle.
    'panel-right': PanelRight,
    // The find bar's three search options.
    'match-case': CaseSensitive,
    'whole-word': WholeWord,
    regex: Regex,
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
