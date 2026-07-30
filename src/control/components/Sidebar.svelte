<!--
  Library sidebar (spec §12.1) — clean warm paper with white-pill selection.
  Footer holds Settings, keyboard-shortcut help, and the app version.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { library, setLibraryView } from '../stores/library';
  import { appStatus } from '../stores/app-status';
  import { navigate, route, type LibraryView } from '../stores/router';

  interface Props {
    onnew: () => void;
    onshortcuts: () => void;
  }

  let { onnew, onshortcuts }: Props = $props();

  const navItems: Array<{ view: LibraryView; label: string; icon: 'doc' | 'clock' | 'trash' }> = [
    { view: 'all', label: 'All scripts', icon: 'doc' },
    { view: 'recent', label: 'Recent', icon: 'clock' },
    { view: 'trash', label: 'Trash', icon: 'trash' },
  ];

  const activeView = $derived($route.name === 'library' ? $library.view : null);
  const inSettings = $derived($route.name === 'settings');

  async function goToView(view: LibraryView): Promise<void> {
    const moved = await navigate({ name: 'library', view });
    if (moved) setLibraryView(view);
  }
</script>

<aside class="sidebar">
  <div class="brand-row">
    <span class="brand-tile" aria-hidden="true">
      <Icon name="mic" size={15} />
    </span>
    <span class="brand">CandidCue</span>
  </div>

  <button type="button" class="new-button" data-focus="control" onclick={onnew}>
    <Icon name="plus" size={16} />
    <span>New script</span>
  </button>

  <nav class="nav" aria-label="Library">
    {#each navItems as item (item.view)}
      <button
        type="button"
        class="nav-item"
        class:active={activeView === item.view}
        aria-current={activeView === item.view ? 'page' : undefined}
        onclick={() => goToView(item.view)}
      >
        <Icon name={item.icon} size={16} />
        <span>{item.label}</span>
      </button>
    {/each}
  </nav>

  <div class="footer">
    <button
      type="button"
      class="nav-item"
      class:active={inSettings}
      aria-current={inSettings ? 'page' : undefined}
      onclick={() => navigate({ name: 'settings', section: 'general' })}
    >
      <Icon name="settings" size={16} />
      <span>Settings</span>
    </button>
    <button type="button" class="nav-item" onclick={onshortcuts}>
      <Icon name="keyboard" size={16} />
      <span>Keyboard shortcuts</span>
    </button>
    {#if $appStatus.version}
      <p class="version">CandidCue {$appStatus.version}</p>
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    width: var(--sidebar-w);
    flex: 0 0 var(--sidebar-w);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    height: 100%;
    padding: var(--space-5) var(--space-4) var(--space-4);
    background: var(--bg-chrome);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }

  .brand-row {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
  }
  .brand-tile {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    flex: 0 0 auto;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-contrast);
  }
  .brand {
    font-size: var(--text-lg);
    font-weight: 700;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }

  /* A quiet white-pill shortcut with a clay label — never a peachy wash. */
  .new-button {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: var(--space-2);
    height: var(--control-h);
    padding: 0 var(--space-3);
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--accent-strong);
    font-size: var(--text-sm);
    font-weight: 600;
    box-shadow: var(--shadow-card);
    transition:
      box-shadow var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .new-button:hover {
    box-shadow: var(--shadow-hover);
    border-color: var(--border);
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid transparent;
    background: transparent;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 600;
    text-align: left;
    width: 100%;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .nav-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  /* Selected destination: a crisp white pill raised off the warm rail. */
  .nav-item.active,
  .nav-item.active:hover {
    background: var(--bg-panel);
    border-color: var(--border);
    box-shadow: var(--shadow-card);
    color: var(--text-primary);
  }
  .nav-item.active :global(svg) {
    color: var(--accent);
  }

  .footer {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .version {
    margin: var(--space-2) 0 0;
    padding: 0 var(--space-3);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }
</style>
