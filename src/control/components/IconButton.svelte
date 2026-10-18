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
   * A press reads as PUSHED IN; it does not shrink (§23.5, §9.3).
   *
   * The same correction `Button.svelte` made, and it matters more here: icon
   * buttons come in rows of five or six, and a row of shrinking squares is the
   * single clearest tell that a desktop toolbar was built out of web
   * components.
   *
   * An inset shadow rather than a darker fill, and that is the contrast check
   * deciding rather than taste: `--bg-hover-chrome` already sits at 4.57:1
   * against `--text-faint`, so any surface a step further from the text fails
   * AA — the design-system token test rejected two candidates before this. A
   * shadow inside the same surface changes the shape of the control without
   * changing the ground its glyph is read against.
   */
  .icon-button:active:not(:disabled) {
    background: var(--bg-hover-chrome);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
  }
  .icon-button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Toggled state — a seated white pill, same selection language as the rail. */
  .active,
  .active:hover:not(:disabled) {
    background: var(--bg-panel);
    border-color: var(--border);
    box-shadow: var(--shadow-card);
    color: var(--accent-strong);
  }

  .danger:hover:not(:disabled) {
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
