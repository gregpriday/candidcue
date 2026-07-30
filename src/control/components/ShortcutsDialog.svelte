<!--
  Keyboard-shortcut reference (spec §19). Cmd on macOS, Ctrl elsewhere.
-->
<script lang="ts">
  import Dialog from './Dialog.svelte';
  import Button from './Button.svelte';
  import { isMacPlatform, presentationModeShortcutLabel } from '../lib/shortcuts';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  const mod = isMacPlatform() ? '⌘' : 'Ctrl+';

  const rows: Array<[string, string]> = [
    ['New script', `${mod}N`],
    ['Open quick search', `${mod}K`],
    ['Save', `${mod}S`],
    ['Present current script', `${mod}Enter`],
    ['Start / Pause / Resume', 'Space (when not typing)'],
    ['Hard pause', `${mod}Shift+Space`],
    // §115: one verb. This key raises "End the session?" — the help calling the
    // same action "Stop session" is the vocabulary split the issue names.
    ['End session', `${mod}.`],
    ['Back / forward one sentence', 'Alt+← / Alt+→'],
    ['Previous / next chapter', 'Alt+↑ / Alt+↓'],
    ['Increase / decrease stage text', `${mod}= / ${mod}-`],
    ['Toggle horizontal mirror', `${mod}Shift+M`],
    ['Blank stage', 'B (during Live)'],
    ['Add take marker', 'T (during Live)'],
    ['Auto-scroll on / off', 'A (during Live)'],
    ['Auto-scroll slower / faster', '[ / ] (during Live)'],
    // The label comes from `shortcuts.ts` rather than being written out here,
    // because this is the one chord whose shape differs between platforms by more
    // than the modifier `mod` stands in for.
    ['Full display / reading window', presentationModeShortcutLabel()],
    // Twice, and from either window — the stage answers it when the presenter
    // is in front of it, this window when the operator is at the desk.
    ['End the take and close the stage', 'Esc Esc'],
    ['Command help', `${mod}/`],
  ];
</script>

<Dialog {open} title="Keyboard shortcuts" {onclose}>
  <table class="shortcuts">
    <tbody>
      {#each rows as [action, keys] (action)}
        <tr>
          <td class="action">{action}</td>
          <td class="keys">{keys}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#snippet footer()}
    <Button variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Dialog>

<style>
  .shortcuts {
    width: 100%;
    border-collapse: collapse;
  }
  td {
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
  }
  .action {
    color: var(--text-primary);
  }
  .keys {
    text-align: right;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
