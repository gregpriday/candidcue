<!--
  Compact 32px icon control. `label` is mandatory — it becomes the accessible
  name and tooltip (spec §20).

  `compact` is the 28px tier (`--toolbar-control-h`), the size of a small
  `Button` and of every control in the editor's 36px formatting row. A 32px
  control there filled the row to within 2px of its edges, so its focus ring —
  which paints 4px outside the button — had nowhere to go and was cut off.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './icon-names';

  interface Props {
    icon: IconName;
    label: string;
    disabled?: boolean;
    active?: boolean;
    danger?: boolean;
    size?: number;
    /** The 28px tier, for a row of controls inside a 36px band. */
    compact?: boolean;
    /**
     * The tooltip, when it should say more than the name — a keyboard
     * shortcut, say. The accessible name stays `label` either way.
     */
    title?: string;
    /**
     * Set for a control that opens a popup. A menu button is NOT a toggle
     * button, so `aria-pressed` is dropped in favour of
     * `aria-haspopup`/`aria-expanded` — announcing "pressed" for something
     * that opens a menu is simply the wrong promise.
     */
    haspopup?: 'menu' | 'dialog' | 'listbox' | 'true';
    expanded?: boolean;
    onclick?: (event: MouseEvent) => void;
    /** For a control that acts on the press rather than the release, as a menu trigger does. */
    onmousedown?: (event: MouseEvent) => void;
    onkeydown?: (event: KeyboardEvent) => void;
  }

  let {
    icon,
    label,
    disabled = false,
    active = false,
    danger = false,
    size = 18,
    compact = false,
    title,
    haspopup,
    expanded,
    onclick,
    onmousedown,
    onkeydown,
  }: Props = $props();
</script>

<button
  type="button"
  class="icon-button"
  class:active
  class:danger
  class:compact
  data-focus="control"
  aria-label={label}
  aria-pressed={haspopup === undefined && active ? 'true' : undefined}
  aria-haspopup={haspopup}
  aria-expanded={haspopup === undefined ? undefined : expanded ? 'true' : 'false'}
  title={title ?? label}
  {disabled}
  {onclick}
  {onmousedown}
  {onkeydown}
>
  <Icon name={icon} {size} />
</button>

<style>
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--icon-control-h);
    height: var(--icon-control-h);
    flex: 0 0 auto;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .compact {
    width: var(--toolbar-control-h);
    height: var(--toolbar-control-h);
  }
  .icon-button:hover:not(:disabled) {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  /*
   * A press does not shrink (§23.5, §9.3), and it does not sink either.
   *
   * Icon buttons come in rows of five or six, and a row of shrinking squares is
   * the clearest tell that a desktop toolbar was built out of web components.
   * The inset shadow that replaced the shrink was elevation by another name, so
   * the press is now the ghost button's (`Button.svelte`): the hover ground,
   * held. A darker fill is not available — `--bg-hover-chrome` already sits at
   * 4.56:1 against `--text-faint`, and the design-system token test rejects any
   * ground a step further from the text.
   */
  .icon-button:active:not(:disabled) {
    background: var(--bg-hover-chrome);
  }
  .icon-button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Toggled state: the chosen segment's language, exactly — a flat panel fill,
     the state keyline, the glyph in ink (SegmentedControl's `.selected`). It
     sat beside "Both" with a paler ring and a petrol glyph, two ways of
     saying "on" an inch apart. No shadow: a chosen control is marked, not
     lifted (the flat-button recipe). */
  .active,
  .active:hover:not(:disabled) {
    background: var(--bg-panel);
    border-color: var(--border-state);
    color: var(--text-primary);
  }

  .danger:hover:not(:disabled) {
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
