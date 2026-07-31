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
    <!--
      "Script fidelity" used to sit here, and it configured nothing.

      It set `following.fidelityMode`, which reaches the settings document, Rust's
      validator, and stops. `resolveFollowProfile` builds a take's motion from
      `family` and `feel` alone and has never read it. Its three descriptions all
      promised tips on numbers, names and omissions — a coaching feature that was
      removed, so the control was offering to tune the behaviour of something
      that no longer runs.

      The FIELD stays in the settings document and in Rust's closed vocabulary:
      it costs nothing, and dropping it would make every profile written by an
      older build fail validation on load. What is gone is the pretence that
      moving it does something.
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
          label="Motion profile"
          value={motionFamily.label}
          description="The only motion profile in this release. Follow feel adjusts it; section safety and retake evidence are never relaxed."
        />
      {/if}
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
