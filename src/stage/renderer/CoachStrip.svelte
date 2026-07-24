<!--
  SUPERSEDED — this component renders nothing, on purpose.

  The floating centred pill from the primary specification (companion Part VIII,
  A.5) has been replaced by the Coaching Rail in
  `src/stage/renderer/coach/CoachRail.svelte`, per §7.1 of the Coaching Rail and
  Live Delivery Intelligence specification: coaching now lives in a permanently
  reserved band at the bottom of the safe viewport, not in an absolutely
  positioned overlay floating over the script at `bottom: 6vh`.

  It is gutted rather than deleted because the mount site (`StageApp.svelte`)
  and the legacy `{ kind: 'coach' }` stage directive that feeds it are outside
  this change. Leaving the old surface *able to render* is the real hazard: the
  moment anything emits that directive there would be two tip surfaces on the
  presenter's glass at once, which §9.1 forbids and which nothing in either
  component could detect. Nothing currently emits it (the field has been `null`
  for the whole life of the stage reducer), so removing the markup costs no
  behaviour today and closes that door.

  To finish the removal, at the mount site:
    1. delete the `<CoachStrip …>` element and its import from `StageApp.svelte`;
    2. delete this file;
    3. drop `coachTip` from `stageState.ts` and the `coach` variant from
       `StageDirective` in `shared/contracts/stage.ts`.

  The behaviour worth keeping from the original is preserved in the rail: a tip
  clears itself after its display window so a stalled control side can never
  leave text on the presenter's glass. See `coach/activeTip.ts`.
-->
<script lang="ts">
  import type { StageCoachTip } from '../../shared/contracts';

  // Declared so the existing mount site keeps compiling; both are ignored.
  let {}: {
    tip?: StageCoachTip | null;
    reducedMotion?: boolean;
  } = $props();
</script>
