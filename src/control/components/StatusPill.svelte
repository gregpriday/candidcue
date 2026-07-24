<!--
  Status capsule. The leading dot is a FILL painted the true tone color;
  small accent text uses --accent-strong for AA contrast in the light theme.
  Tone is never the only signal — the label always names the state (§20).
-->
<script lang="ts">
  export type PillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'live';

  interface Props {
    tone?: PillTone;
    label: string;
    dot?: boolean;
  }

  let { tone = 'neutral', label, dot = true }: Props = $props();
</script>

<span class="pill {tone}">
  {#if dot}<span class="dot" aria-hidden="true"></span>{/if}
  <span class="label">{label}</span>
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 10px;
    border-radius: var(--radius-pill);
    border: 1px solid transparent;
    font-size: var(--text-xs);
    line-height: 1;
    font-weight: 600;
    white-space: nowrap;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex: 0 0 auto;
  }

  .neutral {
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border-color: var(--border);
  }
  .neutral .dot {
    background: var(--text-muted);
  }

  .accent {
    color: var(--accent-strong);
    background: var(--accent-soft);
  }
  .accent .dot {
    background: var(--accent);
  }

  .success {
    color: var(--success);
    background: var(--success-soft);
  }
  .warning {
    color: var(--warning);
    background: var(--warning-soft);
  }
  .danger {
    color: var(--danger);
    background: var(--danger-soft);
  }
  .live {
    color: var(--live);
    background: var(--live-soft);
  }
</style>
