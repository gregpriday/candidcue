/**
 * A brief mark beside the source line a preview click landed on.
 *
 * The caret on its own is a one-pixel line that blinks, and after Preview gives
 * way to Edit the whole pane has just changed under the reader — the caret is
 * the last thing their eye finds. This draws the house's active-marker bar (an
 * inset bar, never a one-sided border) in the line's own left inset, holds it
 * long enough to be seen, and fades it out.
 *
 * A DECORATION, never a selection: selecting the landed text would leave the
 * next keystroke poised to replace it, which is the trade `goToFinding` refuses
 * for the same reason.
 *
 * Appended to the editor on first use (`StateEffect.appendConfig`, the way
 * CodeMirror's own search panel adds itself) rather than declared in
 * `MarkdownEditor`, because only the preview's click asks for it.
 */
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** How long the mark is fully shown before it starts to fade. */
const HOLD_MS = 1100;
/**
 * `--dur-slower`, the house's longest step: the `transition` below uses the
 * token, and this is only how long to wait before dropping the decoration.
 */
const FADE_MS = 240;

type LandingPhase = { line: number; fading: boolean } | null;

const setLanding = StateEffect.define<LandingPhase>();

const shownLine = Decoration.line({ class: 'cm-landing' });
const fadingLine = Decoration.line({ class: 'cm-landing cm-landing-out' });

const landingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setLanding)) continue;
      const phase = effect.value;
      if (phase === null || phase.line > tr.state.doc.lines) {
        next = Decoration.none;
      } else {
        const from = tr.state.doc.line(phase.line).from;
        next = Decoration.set([(phase.fading ? fadingLine : shownLine).range(from)]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const landingTheme = EditorView.theme({
  '.cm-line.cm-landing': { position: 'relative' },
  /* In the line's own left inset (`.cm-line` is padded by --page-x), so the
     text does not move. */
  '.cm-line.cm-landing::before': {
    content: '""',
    position: 'absolute',
    left: 'calc(var(--page-x) - 12px)',
    top: '0.2em',
    bottom: '0.2em',
    width: '3px',
    borderRadius: 'var(--radius-pill)',
    backgroundColor: 'var(--accent)',
    opacity: '1',
    transition: 'opacity var(--dur-slower) var(--ease-out)',
  },
  '.cm-line.cm-landing-out::before': { opacity: '0' },
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-line.cm-landing::before': { transition: 'none' },
  },
});

const timers = new WeakMap<EditorView, ReturnType<typeof setTimeout>[]>();

function clearTimers(view: EditorView): void {
  for (const timer of timers.get(view) ?? []) clearTimeout(timer);
  timers.delete(view);
}

/** Mark the source line holding `pos`, then let the mark go. */
export function markLanding(view: EditorView, pos: number): void {
  // On its own transaction: a field added by a transaction is created for the
  // state it produces, not handed that transaction's other effects.
  if (view.state.field(landingField, false) === undefined) {
    view.dispatch({ effects: StateEffect.appendConfig.of([landingField, landingTheme]) });
  }
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length)).number;
  clearTimers(view);
  view.dispatch({ effects: setLanding.of({ line, fading: false }) });
  // A view the route has since torn down is left alone.
  const later = (phase: LandingPhase) => () => {
    if (view.dom.isConnected) view.dispatch({ effects: setLanding.of(phase) });
  };
  timers.set(view, [
    setTimeout(later({ line, fading: true }), HOLD_MS),
    setTimeout(() => {
      later(null)();
      timers.delete(view);
    }, HOLD_MS + FADE_MS),
  ]);
}
