<!--
  The Coaching Rail (§6–§10): a permanently reserved band at the bottom of the
  safe stage viewport.

  ---------------------------------------------------------------------------
  The one rule to not break
  ---------------------------------------------------------------------------
  The band's height is reserved whether or not the rail is visible. Hiding it
  fades the contents; it never gives the space back. Reclaiming it would move
  the reading line under the presenter mid-take, which is precisely the failure
  §7.1 exists to prevent — so there is no `{#if visible}` around the band, and
  `coachRailReservedHeightPx()` takes no visibility argument to pass one.

  The mount site holds the other half of the same rule: it must subtract
  `coachRailScriptInsetPx(viewportHeightPx)` from the script layer's bottom
  *before the take begins*, and keep it subtracted for the whole take.

  ---------------------------------------------------------------------------
  Advisory only (§2.1)
  ---------------------------------------------------------------------------
  This component takes one `CoachRailState` and emits nothing. It has no
  callback prop, no store write, no import from the motion engine or the line
  map. There is no path from the rail into the script's motion, which is what
  makes §5.2 ("the stage keeps scrolling smoothly even if every coaching
  process dies") structural rather than aspirational.

  Mirror (§7.5): the rail carries no transform of its own. It is mounted inside
  the stage's existing mirror plane and inherits the same boundary as the
  script, so text, event order, and directional marks flip together.
-->
<script lang="ts">
  import type { CoachRailState } from '../../../shared/contracts/coaching';
  import { CoachRailPresenter } from './presenter';
  import { coachRailReservedHeightPx, RAIL_RIBBON_HEIGHT_PX } from './railGeometry';
  import EventRibbon from './EventRibbon.svelte';

  let {
    snapshot = null,
    viewportHeightPx = 0,
    textScale = 1,
    columnWidthPercent = null,
  }: {
    /** The latest snapshot, or `null` before the first one arrives. */
    snapshot?: CoachRailState | null;
    /** Safe stage viewport height, for §7.1. */
    viewportHeightPx?: number;
    /** §7.6 rail text scale, 0.8–1.5. Not part of `CoachRailState`. */
    textScale?: number;
    /**
     * §7.1: horizontal padding equal to or slightly wider than the script
     * column's. Pass the stage settings' `columnWidthPercent` and the rail's
     * zones line up with the text above them; leave it `null` for a sensible
     * viewport-relative default.
     */
    columnWidthPercent?: number | null;
  } = $props();

  /** §7.4/§9.3 tick: the rail ages its own tip and pause ladder. */
  const RAIL_TICK_MS = 100;
  const FADE_MS = 160;

  const presenter = new CoachRailPresenter();
  let widthPx = $state(0);
  let tickMs = $state(0);
  let epochMonotonicMs = $state(0);

  const now = (): number => (typeof performance === 'undefined' ? 0 : performance.now());

  const view = $derived.by(() => {
    // `tickMs` is read so the view recomputes on the local clock as well as on
    // arrival: a tip must expire, and a pause must escalate, with no help at
    // all from control (§9.3, §14.5).
    void tickMs;
    if (!snapshot) return null;
    return presenter.update({
      state: snapshot,
      monotonicMs: now(),
      widthPx,
      viewportHeightPx,
      textScale,
    });
  });

  $effect(() => {
    // Record when this frame of marks was laid out, so the ribbon can slide
    // from exactly there.
    void view;
    epochMonotonicMs = now();
  });

  $effect(() => {
    if (!snapshot || snapshot.mode === 'off') return;
    const timer = window.setInterval(() => {
      tickMs = now();
    }, RAIL_TICK_MS);
    return () => clearInterval(timer);
  });

  // The band exists before the first snapshot does, otherwise the script would
  // reflow the moment coaching starts.
  const reservedHeightPx = $derived(view?.reservedHeightPx ?? coachRailReservedHeightPx(viewportHeightPx));
  const present = $derived(view === null || view.present);
</script>

{#if present}
  <div
    class="coach-rail"
    bind:clientWidth={widthPx}
    style:height="{reservedHeightPx}px"
    style:padding-inline={columnWidthPercent === null ? undefined : '0'}
    style:--rail-scale={view?.textScale ?? 1}
    style:--rail-fade-ms="{view?.reducedMotion ? 0 : FADE_MS}ms"
    data-tier={view?.layout.tier ?? 'full'}
    data-visible={view ? String(view.visible) : 'false'}
    data-mirrored={view ? String(view.mirrored) : 'false'}
    data-reduced-motion={view ? String(view.reducedMotion) : 'false'}
    aria-hidden="true"
  >
    <!-- §7.1: contents fade, geometry does not. -->
    <div
      class="contents"
      class:hidden={view !== null && !view.visible}
      style:width={columnWidthPercent === null ? undefined : `${columnWidthPercent}%`}
      style:max-width={columnWidthPercent === null ? undefined : 'none'}
    >
      <div class="row" data-compact={view ? String(view.layout.compactTelemetry) : 'false'}>
        {#if view && view.layout.compactTelemetry}
          <!-- §7.3 step 4: one compact telemetry row, the tip beside it. -->
          {#if view.pace || view.variety || view.fillers}
            <div class="zone zone-compact" data-zone="telemetry">
              {#if view.pace}
                <span class="value" class:dim={view.pace.dim} data-field="pace-number">
                  {view.pace.number}
                </span>
                <span class="line-status" data-tone={view.pace.tone} data-field="pace-state">
                  {view.pace.label}
                </span>
              {/if}
              {#if view.variety}
                <span class="sep">·</span>
                <span class="line-status" data-field="variety-state">{view.variety.label}</span>
              {/if}
              {#if view.fillers}
                <span class="sep">·</span>
                <span class="line-status" data-field="filler-count">{view.fillers}</span>
              {/if}
            </div>
          {/if}
        {:else if view?.pace}
          <div class="zone zone-pace" data-zone="pace">
            <div class="line-value">
              <span class="caption">PACE</span>
              <span class="value" class:dim={view.pace.dim} data-field="pace-number">
                {view.pace.number}
              </span>
              {#if view.sparkline}
                <svg class="sparkline" viewBox="0 0 100 24" preserveAspectRatio="none">
                  <polyline
                    points={view.sparkline.map((p) => `${p.x * 100},${p.y * 24}`).join(' ')}
                  />
                </svg>
              {/if}
            </div>
            <div class="line-status" data-tone={view.pace.tone} data-field="pace-state">
              {view.pace.label}
            </div>
          </div>
        {/if}

        <div class="zone zone-tip" data-zone="tip">
          {#if view && view.centre.kind !== 'none'}
            {#key view.centre.tipId ?? view.centre.text}
              <div class="tip" data-tone={view.centre.tone} data-centre={view.centre.kind}>
                {view.centre.text}
              </div>
            {/key}
          {/if}
        </div>

        {#if view && !view.layout.compactTelemetry && (view.variety || view.fillers)}
          <div class="zone zone-variety" data-zone="variety">
            {#if view.variety && view.layout.showVarietyNumber}
              <div class="line-value">
                <span class="caption">VARIETY</span>
                <span class="value" data-field="variety-number">{view.variety.number}</span>
              </div>
            {/if}
            <div class="line-status">
              {#if view.variety}<span data-field="variety-state">{view.variety.label}</span>{/if}
              {#if view.variety && view.fillers}<span class="sep">·</span>{/if}
              {#if view.fillers}<span data-field="filler-count">{view.fillers}</span>{/if}
            </div>
          </div>
        {/if}
      </div>

      <div class="ribbon-slot" style:height="{RAIL_RIBBON_HEIGHT_PX}px">
        {#if view?.ribbon.show}
          <EventRibbon
            marks={view.ribbon.marks}
            windowMs={view.ribbon.windowMs}
            {epochMonotonicMs}
            heightPx={RAIL_RIBBON_HEIGHT_PX}
            reducedMotion={view.reducedMotion}
          />
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .coach-rail {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    /* Horizontal padding at least as wide as the script column's (§7.1);
       passing `columnWidthPercent` narrows the contents to the column instead. */
    padding: 0 clamp(24px, 6vw, 72px);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    /* The rail is a readout, never a control surface. */
    pointer-events: none;
    /* §7.4: smaller than the script, and it never moves vertically. */
    font-size: calc(13px * var(--rail-scale, 1));
    line-height: 1.25;
    letter-spacing: var(--ls-caps, 0.06em);
    font-variant-numeric: tabular-nums;
  }

  .contents {
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    opacity: 1;
    /* §7.4: opacity only, 120–220 ms. Reduced motion sets the variable to 0ms. */
    transition: opacity var(--rail-fade-ms, 160ms) var(--ease-out, ease-out);
  }
  .contents.hidden {
    opacity: 0;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);
    align-items: center;
    gap: 16px;
  }

  .zone {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .zone-variety {
    align-items: flex-end;
    text-align: right;
  }
  .zone-tip {
    align-items: center;
    text-align: center;
  }

  .line-value {
    display: flex;
    align-items: baseline;
    gap: 6px;
    white-space: nowrap;
  }

  .caption,
  .line-status {
    /* §7.4: stable telemetry sits at low contrast. */
    color: rgba(245, 243, 239, 0.42);
    font-size: 0.82em;
  }

  .value {
    color: rgba(245, 243, 239, 0.72);
    font-size: 1.25em;
    font-weight: 600;
    /* §7.4: no rolling digits, no counter animation. */
    transition: opacity var(--rail-fade-ms, 160ms) var(--ease-out, ease-out);
  }
  /* §14.5: the held number during a pause drops in contrast rather than
     disappearing or falling toward zero. */
  .value.dim {
    color: rgba(245, 243, 239, 0.34);
  }

  /* Status colour never carries meaning on its own — the label already says
     FAST or SLOW in words (§7.6). */
  .line-status[data-tone='attention'] {
    color: var(--accent-strong, #ec9d7a);
  }

  .sep {
    padding: 0 0.35em;
    color: rgba(245, 243, 239, 0.28);
  }

  .tip {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0.01em;
    /* §9.2: one line at normal rail scale. */
    font-size: 1.08em;
    animation: rail-fade-in var(--rail-fade-ms, 160ms) var(--ease-out, ease-out);
  }
  /* §7.4 contrast bands: moderate for an actionable tip, high only for a
     system-critical alert. */
  .tip[data-tone='gentle'] {
    color: rgba(245, 243, 239, 0.78);
  }
  .tip[data-tone='important'] {
    color: rgba(245, 243, 239, 0.9);
  }
  .tip[data-tone='critical'] {
    color: #f7ede0;
    font-weight: 600;
  }

  @keyframes rail-fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .sparkline {
    width: 56px;
    height: 12px;
    overflow: visible;
    fill: none;
    stroke: rgba(245, 243, 239, 0.35);
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }

  .ribbon-slot {
    width: 100%;
  }

  /* §7.3 step 4: left and right telemetry collapse into one row, and the tip
     keeps the space it needs. Step 6 leaves the tip alone in the row. */
  .row[data-compact='true'] {
    grid-template-columns: minmax(0, auto) minmax(0, 1fr);
    gap: 12px;
  }
  .zone-compact {
    flex-direction: row;
    align-items: baseline;
    gap: 6px;
    white-space: nowrap;
  }
  .coach-rail[data-tier='tip_only'] .row {
    grid-template-columns: minmax(0, 1fr);
  }
</style>
