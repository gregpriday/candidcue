<!--
  §47 follow settings, shared by Settings → Following and the Preflight
  "Voice tracking" section so the same choice is never described two ways.

  These are understandable controls, not a control-system dashboard (§47).
  Every value resolves into a versioned SmoothFollowProfile through
  lib/follow-profiles.ts.
-->
<script lang="ts">
  import SegmentedControl from './SegmentedControl.svelte';
  import Select from './Select.svelte';
  import Toggle from './Toggle.svelte';
  import {
    FIDELITY_MODE_OPTIONS,
    FOLLOW_FEEL_OPTIONS,
    MOTION_PROFILE_FAMILIES,
    type FidelityMode,
    type FollowFeel,
    type FollowingSettings,
  } from '../lib/follow-profiles';

  interface Props {
    following: FollowingSettings;
    /** Preflight shows the session-relevant subset. */
    compact?: boolean;
    onchange: (patch: Partial<FollowingSettings>) => void;
  }
  let { following, compact = false, onchange }: Props = $props();

  const feelNote = $derived(
    FOLLOW_FEEL_OPTIONS.find((option) => option.value === following.feel)?.description ?? '',
  );
  const fidelityNote = $derived(
    FIDELITY_MODE_OPTIONS.find((option) => option.value === following.fidelityMode)?.description ??
      '',
  );
</script>

<div class="fields">
  <div class="field">
    <span class="mini-label" id="follow-feel-label">Follow feel</span>
    <SegmentedControl
      label="Follow feel"
      value={following.feel}
      options={FOLLOW_FEEL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      onchange={(value) => onchange({ feel: value as FollowFeel })}
    />
    <p class="hint">{feelNote}</p>
  </div>

  {#if !compact}
    <div class="field">
      <span class="mini-label">Script fidelity</span>
      <SegmentedControl
        label="Script fidelity"
        value={following.fidelityMode}
        options={FIDELITY_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onchange={(value) => onchange({ fidelityMode: value as FidelityMode })}
      />
      <p class="hint">{fidelityNote} Fidelity changes what gets a tip, not how tolerant tracking is.</p>
    </div>

    <div class="field">
      <Select
        label="Motion profile"
        value={following.motionProfileId}
        options={MOTION_PROFILE_FAMILIES.map((family) => ({
          value: family.id,
          label: family.label,
        }))}
        onchange={(value) => onchange({ motionProfileId: value })}
      />
      <p class="hint">
        {MOTION_PROFILE_FAMILIES.find((family) => family.id === following.motionProfileId)
          ?.description ?? ''}
      </p>
    </div>

    <Toggle
      checked={following.developerDiagnostics}
      label="Developer diagnostics"
      description="Shows the full following timeline in Live. Records stay on this device and contain no script or transcript text."
      onchange={(value) => onchange({ developerDiagnostics: value })}
    />

    <p class="hint">
      Reading-band position lives with the other stage appearance settings — it sets where the
      active line sits, which is what the follower aims for.
    </p>
  {/if}
</div>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .mini-label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .hint {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }
</style>
