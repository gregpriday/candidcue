/**
 * §9 active coaching tip.
 *
 * The property under test throughout is that the *stage* owns the display
 * window. Every case here drives the presenter forward in time without ever
 * changing the payload — i.e. it simulates a control side that has stalled,
 * deadlocked, or died — and asserts the tip still leaves the glass. Anything
 * less and a crashed coach process leaves "Ease back slightly" burned into the
 * presenter's teleprompter for the rest of the shoot.
 */
import { describe, expect, it } from 'vitest';
import { ActiveTipPresenter, tipText } from '../../../src/stage/renderer/coach/activeTip';
import { resolveCentre } from '../../../src/stage/renderer/coach/presenter';
import { tip } from './coach-rail-fixture';

describe('§9.3 tip lifecycle', () => {
  it('shows a tip once it is eligible', () => {
    const presenter = new ActiveTipPresenter();
    const view = presenter.update(tip(), 10_000);
    expect(view?.text).toBe('Use a silent pause');
    expect(view?.tipId).toBe('tip-1');
  });

  it('waits for the earliest safe display time (§9.4)', () => {
    const presenter = new ActiveTipPresenter();
    const candidate = tip({ earliestDisplayMs: 12_000 });
    expect(presenter.update(candidate, 11_000)).toBeNull();
    expect(presenter.update(candidate, 12_000)).not.toBeNull();
  });

  it('clears itself at the maximum display duration with no help from control', () => {
    const presenter = new ActiveTipPresenter();
    const stuck = tip({ maximumDisplayMs: 4_500, expiresAudioTimeMs: 1_000_000 });
    expect(presenter.update(stuck, 10_000)).not.toBeNull();
    // Control keeps re-sending the identical tip forever.
    expect(presenter.update(stuck, 14_400)).not.toBeNull();
    expect(presenter.update(stuck, 14_500)).toBeNull();
    expect(presenter.update(stuck, 60_000)).toBeNull();
    expect(presenter.update(stuck, 600_000)).toBeNull();
  });

  it('clears itself at expiry even when the maximum display window is long', () => {
    const presenter = new ActiveTipPresenter();
    const critical = tip({
      severity: 'critical',
      code: 'MIC_CLIPPING',
      textKey: 'coach.tip.MIC_CLIPPING',
      minimumDisplayMs: 2_000,
      maximumDisplayMs: 30_000,
      expiresAudioTimeMs: 13_000,
    });
    expect(presenter.update(critical, 10_000)).not.toBeNull();
    expect(presenter.update(critical, 13_000)).toBeNull();
  });

  it('never yanks a tip away before its minimum display', () => {
    const presenter = new ActiveTipPresenter();
    // Expiry lands 200 ms after the tip first became displayable.
    const brief = tip({ minimumDisplayMs: 2_500, expiresAudioTimeMs: 10_200 });
    expect(presenter.update(brief, 10_000)).not.toBeNull();
    expect(presenter.update(brief, 10_300)).not.toBeNull();
    expect(presenter.update(brief, 12_400)).not.toBeNull();
    expect(presenter.update(brief, 12_500)).toBeNull();
  });

  it('drops a tip that went stale before it was ever shown', () => {
    const presenter = new ActiveTipPresenter();
    const stale = tip({ expiresAudioTimeMs: 16_000 });
    // The rail only sees it well after the sentence it describes has gone.
    expect(presenter.update(stale, 20_000)).toBeNull();
    // And it does not appear later either, minimum display notwithstanding.
    expect(presenter.update(stale, 20_100)).toBeNull();
  });

  it('replaces rather than stacks, and gives the new tip its own window (§9.1)', () => {
    const presenter = new ActiveTipPresenter();
    const first = tip();
    expect(presenter.update(first, 10_000)?.tipId).toBe('tip-1');
    const second = tip({
      tipId: 'tip-2',
      code: 'PACE_EASE_BACK',
      textKey: 'coach.tip.PACE_EASE_BACK',
      earliestDisplayMs: 11_000,
      expiresAudioTimeMs: 20_000,
      createdAudioTimeMs: 11_000,
    });
    const view = presenter.update(second, 11_000);
    expect(view?.tipId).toBe('tip-2');
    expect(view?.text).toBe('Ease back slightly');
    // tip-2's clock started at 11 000, not at tip-1's 10 000.
    expect(presenter.update(second, 15_400)).not.toBeNull();
    expect(presenter.update(second, 15_500)).toBeNull();
  });

  it('is idempotent for a fixed time', () => {
    const presenter = new ActiveTipPresenter();
    const candidate = tip();
    const a = presenter.update(candidate, 10_000);
    const b = presenter.update(candidate, 10_000);
    expect(b).toEqual(a);
    // The second call did not restart the display window either.
    expect(presenter.update(candidate, 14_400)).not.toBeNull();
    expect(presenter.update(candidate, 14_500)).toBeNull();
  });

  it('withholds ordinary coaching in Minimal and Review-only modes (§6.2, §6.5)', () => {
    const ordinary = new ActiveTipPresenter();
    expect(ordinary.update(tip(), 10_000, true)).toBeNull();
    const critical = new ActiveTipPresenter();
    const alert = tip({
      severity: 'critical',
      code: 'MIC_CLIPPING',
      textKey: 'coach.tip.MIC_CLIPPING',
    });
    expect(critical.update(alert, 10_000, true)?.text).toBe('Mic is clipping');
  });
});

describe('§25 tip copy', () => {
  it('renders authored catalog copy, not payload prose', () => {
    // A payload that smuggled model text in a field the rail does not read.
    const smuggled = tip({ interpolations: { evil: 'You sound boring' } });
    const text = tipText(smuggled);
    expect(text).toBe('Use a silent pause');
    expect(text).not.toContain('boring');
  });

  it('interpolates only through the authored key', () => {
    const quoted = tip({
      code: 'REPEATED_FILLER',
      textKey: 'coach.tip.REPEATED_FILLER',
      interpolations: { filler: 'um' },
    });
    expect(tipText(quoted)).toContain('um');
  });

  it('falls back to the primary variant for an unknown key rather than rendering nothing', () => {
    expect(tipText(tip({ textKey: 'coach.tip.from.the.future' }))).toBe('Use a silent pause');
  });

  it('renders nothing for a code that is not in the catalog', () => {
    expect(tipText(tip({ code: 'NOT_A_REAL_CODE' as never }))).toBeNull();
  });
});

describe('§9.1 one message surface', () => {
  const view = { tipId: 't', code: 'USE_SILENT_PAUSE', text: 'Use a silent pause' } as const;

  it('prefers a system-critical tip over the microphone status line', () => {
    const centre = resolveCentre({ ...view, severity: 'critical' }, 'MIC IS CLIPPING');
    expect(centre.kind).toBe('tip');
    expect(centre.text).toBe('Use a silent pause');
    expect(centre.tone).toBe('critical');
  });

  it('prefers a sustained microphone fault over ordinary advice', () => {
    const centre = resolveCentre({ ...view, severity: 'gentle' }, 'MIC IS CLIPPING');
    expect(centre.kind).toBe('alert');
    expect(centre.text).toBe('MIC IS CLIPPING');
  });

  it('falls back to the tip, and then to silence (§2.6)', () => {
    expect(resolveCentre({ ...view, severity: 'gentle' }, null).tone).toBe('gentle');
    expect(resolveCentre({ ...view, severity: 'important' }, null).tone).toBe('important');
    const quiet = resolveCentre(null, null);
    expect(quiet.kind).toBe('none');
    expect(quiet.text).toBe('');
  });
});
