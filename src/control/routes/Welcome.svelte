<!--
  First-launch welcome (spec §9.1, copy from Appendix F.1). Restrained: no
  account creation, no promotional imagery; the user can postpone setup.
-->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import Icon from '../components/Icon.svelte';
  import { createAndOpenScript, importMarkdown } from '../lib/app-actions';
  import { markWelcomed } from '../stores/app-status';
  import { navigate } from '../stores/router';

  const readiness = [
    { icon: 'mic' as const, text: 'Choose and test a microphone.' },
    { icon: 'monitor' as const, text: 'Select the screen used by your teleprompter.' },
  ];

  function skipToLibrary(): void {
    markWelcomed();
    void navigate({ name: 'library', view: 'all' });
  }

  function openPrivacy(): void {
    void navigate({ name: 'settings', section: 'privacy' });
  }
</script>

<div class="welcome">
  <div class="inner">
    <p class="wordmark">CandidCue</p>
    <h1 class="heading">Speak naturally. Keep your place.</h1>
    <p class="body">
      CandidCue is a voice-following teleprompter for your second screen. Write or import a
      Markdown script, choose a microphone, and present while the text follows you.
    </p>

    <div class="actions">
      <Button variant="primary" onclick={() => createAndOpenScript('new')}>
        Create your first script
      </Button>
      <Button onclick={() => importMarkdown()}>Import Markdown</Button>
      <!-- Offered here as well as in the Library's empty state: a first-run
           user starting from a blank three-line stub has nothing to read
           aloud, and reading aloud is the only way to see what this app
           actually does. -->
      <Button variant="ghost" onclick={() => createAndOpenScript('sample')}>
        Open the sample script
      </Button>
    </div>

    <ul class="readiness">
      {#each readiness as item (item.text)}
        <li class="readiness-item">
          <span class="readiness-icon"><Icon name={item.icon} size={16} /></span>
          <span>{item.text}</span>
        </li>
      {/each}
    </ul>

    <div class="footer-links">
      <button type="button" class="link" onclick={openPrivacy}>
        How CandidCue handles your voice
      </button>
      <button type="button" class="link quiet" onclick={skipToLibrary}>Go to the library</button>
    </div>
  </div>
</div>

<style>
  .welcome {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    place-items: center;
    padding: var(--space-10) var(--page-x);
  }

  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    max-width: 560px;
    gap: var(--space-4);
  }

  .wordmark {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--accent-strong);
  }

  .heading {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 40px;
    line-height: 1.18;
    font-weight: 600;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }

  .body {
    margin: 0;
    font-size: var(--text-lg);
    line-height: var(--lh-transcript);
    color: var(--text-secondary);
    max-width: 46ch;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  .readiness {
    list-style: none;
    margin: var(--space-5) 0 0;
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    text-align: left;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    width: 100%;
    max-width: 420px;
  }
  .readiness-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .readiness-icon {
    display: inline-flex;
    color: var(--accent);
    flex: 0 0 auto;
  }

  .footer-links {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    margin-top: var(--space-3);
  }
  .link {
    border: none;
    background: transparent;
    padding: 2px 4px;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--accent-strong);
    border-radius: var(--radius-sm);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  /* Small terracotta text must never drop to --accent (it sits right on the
     AA line); hover darkens to the primary text colour instead, which also
     reads as the right direction for a hover. */
  .link:hover {
    color: var(--text-primary);
    text-decoration-thickness: 2px;
  }
  .link.quiet {
    color: var(--text-muted);
    text-decoration: none;
  }
  .link.quiet:hover {
    color: var(--text-primary);
  }
</style>
