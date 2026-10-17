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
  import SettingReadout from './SettingReadout.svelte';
  import SettingRow from './SettingRow.svelte';
  import Toggle from './Toggle.svelte';
  import {
    FOLLOW_FEEL_OPTIONS,
    MOTION_PROFILE_FAMILIES,
    motionProfileFamily,
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

  /**
   * One family ships today, so there is nothing to pick between.
   *
   * Gated on the array rather than on a flag, because the array is the fact:
   * the moment a second family is added, this becomes a real Select without
   * anybody having to remember that this line exists.
   */
  const hasMotionChoice = $derived(MOTION_PROFILE_FAMILIES.length > 1);
  const motionFamily = $derived(motionProfileFamily(following.motionProfileId));
</script>

<div class="fields">
  <SettingRow label="Follow feel" description={feelNote}>
    {#snippet control(describedby)}
      <SegmentedControl
        label="Follow feel"
        {describedby}
        value={following.feel}
        options={FOLLOW_FEEL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onchange={(value) => onchange({ feel: value as FollowFeel })}
      />
    {/snippet}
  </SettingRow>

  {#if !compact}
    <!--
      "Script fidelity" used to sit here, and it configured nothing.

      It set `following.fidelityMode`, which reached the settings document, Rust's
      validator, and stopped. `resolveFollowProfile` builds a take's motion from
      `family` and `feel` alone and has never read it. Its three descriptions all
      promised tips on numbers, names and omissions — a coaching feature that was
      removed, so the control was offering to tune the behaviour of something
      that no longer runs.

      The field went after it (#218 here, #219 in Rust). A document written by an
      older build still carries it and loads as before.
    -->
    <div class="field">
      {#if hasMotionChoice}
        <Select
          label="Motion profile"
          value={following.motionProfileId}
          options={MOTION_PROFILE_FAMILIES.map((family) => ({
            value: family.id,
            label: family.label,
          }))}
          onchange={(value) => onchange({ motionProfileId: value })}
        />
        <p class="hint">{motionFamily.description}</p>
      {:else}
        <!-- One family ships, so this states which rather than offering a
             dropdown with a single entry and no alternative to reveal. -->
        <SettingReadout
          layout="row"
          label="Motion profile"
          value={motionFamily.label}
          description="CandidCue's one motion profile. Follow feel tunes it."
        />
      {/if}
    </div>

    <Toggle
      checked={following.developerDiagnostics}
      label="Developer diagnostics"
      description="Shows the detailed following timeline in Take controls → Why did it move? Records stay on this device and contain no script or transcript text."
      onchange={(value) => onchange({ developerDiagnostics: value })}
    />

    <p class="hint">
      Following aims for the reading band. Its position is a Teleprompter setting, unless a
      calibrated rig or automatic sizing owns it.
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
  .hint {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }
</style>
