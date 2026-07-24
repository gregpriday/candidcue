<!--
  Control window shell — placeholder. Routes, library, editor, settings and
  live controls replace this (spec §43.1, §45). Keeps the workspace theme and
  the sidebar + content layout other agents will build into.
-->
<script lang="ts">
  // Placeholder shell — no state yet.
</script>

<div class="shell" data-theme="workspace">
  <aside class="sidebar">
    <div class="wordmark">CandidCue</div>
  </aside>
  <main class="content">
    <p class="placeholder">Control window scaffold — library, editor, and live controls land here.</p>
  </main>
</div>

<style>
  .shell {
    display: flex;
    height: 100%;
    background: var(--bg-app);
    color: var(--text-primary);
  }

  .sidebar {
    width: var(--sidebar-w);
    flex: none;
    background: var(--bg-chrome);
    border-right: 1px solid var(--border-seam);
    padding: var(--space-6) var(--space-4);
  }

  .wordmark {
    font-size: var(--text-lg);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }

  .content {
    flex: 1;
    display: grid;
    place-items: center;
    padding: var(--page-y) var(--page-x);
  }

  .placeholder {
    color: var(--text-muted);
    font-size: var(--text-sm);
    max-width: var(--prose-measure-narrow);
    text-align: center;
  }
</style>
