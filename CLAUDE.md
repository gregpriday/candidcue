# CandidCue — project conventions

## Design

These are hard design rules for this app. They override generic component-library
defaults and any spec text that contradicts them.

### Focus indication (READ THIS before touching any focus styling)

**Never wrap an input, editor, panel, card, list row, or any large surface in an
accent focus ring or an accent focus border.** This has gone wrong repeatedly:
agents add `:focus-within { border-color: var(--accent) }` or
`:has(:focus-visible) { outline: 2px solid ... }` to a *surface*, and the result
is a heavy terracotta box around the whole element that looks wrong.

- The global keyboard ring `:where(button, a, input, textarea, select, [tabindex]):focus-visible`
  in `tokens.css` is for **small interactive controls only** (buttons, links,
  plain form fields). Do not extend it — via `:has(:focus-visible)` or
  `:focus-within` — onto composite surfaces (editors, panels, rows, cards).
- Indicate focus on a large surface with a **quiet, low-contrast shift**: a subtle
  background lift (e.g. `--bg-panel`) or a one-step border firm to
  `--border-strong`. Never the accent color, never an `outline` ring around the
  whole surface.
- A text editor's own caret is sufficient focus indication for the editing body.

### Selection

- Sidebar / rail selection (nav, recent projects, source list) = a **crisp white
  pill** lifted off the warm rail (`--bg-panel` + `--border` + `--shadow-card`).
  Never a faint terracotta/peach wash — it reads as barely-there.

### Other standing design rules

Brand accent is warm **terracotta/clay** (never purple). Never a one-sided border
on a rounded box (use an inset `::before` bar for leading rules). No
border-inside-border (editors embedded in a bordered pane go full-bleed). Small
terracotta **text** uses `--accent-strong` for AA. Flat surfaces — no gradients,
glass, glow, or perpetual motion. Quieter after refinement, not more decorated.

## Tooling

- Authoritative typecheck is the direct binary: `node_modules/.bin/tsc --noEmit`
  (a shell proxy can mask `tsc` errors).
- Tests: `NODE_OPTIONS=--experimental-sqlite vitest run`.
