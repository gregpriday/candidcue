/**
 * FollowSettingsFields — no control that configures nothing.
 *
 * Two defects lived in this component (#124), and both were the same mistake in
 * different shapes: a widget that looks like a decision but is not one.
 *
 * "Script fidelity" set `following.fidelityMode`, which reaches the settings
 * document and Rust's validator and stops — `resolveFollowProfile` builds a
 * take's motion from `family` and `feel` alone. Its copy promised tips on
 * numbers, names and omissions, from a coaching feature that was removed. So it
 * offered to tune something that does not run.
 *
 * "Motion profile" was a dropdown over a one-item array.
 *
 * The compatibility half is asserted too: the FIELD must keep round-tripping,
 * because documents written by older builds carry it and Rust validates it
 * against a closed vocabulary. Removing the control must not remove the value.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import FollowSettingsFields from '../../src/control/components/FollowSettingsFields.svelte';
import {
  MOTION_PROFILE_FAMILIES,
  defaultFollowingSettings,
  type FollowingSettings,
} from '../../src/control/lib/follow-profiles';

function mount(overrides: Partial<FollowingSettings> = {}) {
  const following: FollowingSettings = { ...defaultFollowingSettings(), ...overrides };
  const patches: Array<Record<string, unknown>> = [];
  const view = render(FollowSettingsFields, {
    props: {
      following,
      onchange: (patch: Record<string, unknown>) => patches.push(patch),
    },
  });
  return { view, patches, following };
}

describe('the dead Script fidelity control', () => {
  it('is gone from the panel', () => {
    const { view } = mount();
    expect(view.container.textContent).not.toContain('Script fidelity');
  });

  it('takes its removed-feature copy with it', () => {
    // The three option descriptions all promised tips, and the hint said
    // "Fidelity changes what gets a tip". Nothing gives tips any more.
    const { view } = mount();
    expect(view.container.textContent).not.toContain('tip');
  });

  it('leaves the stored value alone — nothing here writes fidelityMode', () => {
    const { patches } = mount();
    expect(patches.every((p) => !('fidelityMode' in p))).toBe(true);
  });

  it('still accepts a settings object carrying the compatibility field', () => {
    // A document from an older build arrives with this set. Rendering must not
    // care, because the field is still valid — it is merely unread.
    const { following } = mount({ fidelityMode: 'exact' });
    expect(following.fidelityMode).toBe('exact');
  });
});

describe('Motion profile with one family', () => {
  it('states the profile instead of offering a dropdown of one', () => {
    const { view } = mount();
    expect(MOTION_PROFILE_FAMILIES.length).toBe(1);
    expect(view.container.querySelector('select')).toBeNull();
  });

  it('names the family that is actually in force', () => {
    const { view } = mount();
    expect(view.container.textContent).toContain(MOTION_PROFILE_FAMILIES[0]!.label);
    expect(view.container.textContent).toContain('The only motion profile in this release');
  });
});

describe('the controls that are still real', () => {
  it('keeps Follow feel interactive', () => {
    // The point of the change is removing what does nothing, not thinning the
    // panel — feel genuinely reaches resolveFollowProfile.
    const { view } = mount();
    expect(view.container.textContent).toContain('Follow feel');
  });

  it('keeps Developer diagnostics interactive', () => {
    const { view } = mount();
    expect(view.container.textContent).toContain('Developer diagnostics');
  });

  it('shows neither in the compact Preflight subset', () => {
    const following = defaultFollowingSettings();
    const view = render(FollowSettingsFields, {
      props: { following, compact: true, onchange: () => {} },
    });
    expect(view.container.textContent).not.toContain('Motion profile');
    expect(view.container.textContent).toContain('Follow feel');
  });
});
