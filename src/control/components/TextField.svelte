<!--
  Text input. Focus on the input surface is a QUIET bg/border shift — never an
  accent ring (owner rule); the global outline is suppressed for this control.
-->
<script lang="ts">
  interface Props {
    value: string;
    label?: string;
    type?: 'text' | 'password' | 'search' | 'email';
    placeholder?: string;
    hint?: string;
    error?: string;
    disabled?: boolean;
    autocomplete?: 'off' | 'on';
    oninput?: (value: string) => void;
    onsubmit?: () => void;
  }

  let {
    value = $bindable(),
    label,
    type = 'text',
    placeholder,
    hint,
    error,
    disabled = false,
    autocomplete = 'off',
    oninput,
    onsubmit,
  }: Props = $props();

  const uid = $props.id();

  function handleInput(event: Event): void {
    value = (event.currentTarget as HTMLInputElement).value;
    oninput?.(value);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') onsubmit?.();
  }
</script>

<div class="field">
  {#if label}
    <label class="label" for={uid}>{label}</label>
  {/if}
  <input
    id={uid}
    class="input"
    class:invalid={Boolean(error)}
    {type}
    {placeholder}
    {disabled}
    {autocomplete}
    {value}
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={error ? `${uid}-error` : hint ? `${uid}-hint` : undefined}
    oninput={handleInput}
    onkeydown={handleKeydown}
  />
  {#if error}
    <p class="error" id="{uid}-error">{error}</p>
  {:else if hint}
    <p class="hint" id="{uid}-hint">{hint}</p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .input {
    height: var(--control-h);
    padding: 0 var(--space-3);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-base);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .input::placeholder {
    color: var(--text-faint);
  }
  .input:hover:not(:disabled) {
    border-color: var(--border-strong);
  }
  /* Quiet focus: firmer border + surface shift only — no accent outline. */
  .input:focus,
  .input:focus-visible {
    outline: none;
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }
  .input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .invalid,
  .invalid:focus {
    border-color: var(--danger);
  }

  .hint {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .error {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--danger);
  }
</style>
