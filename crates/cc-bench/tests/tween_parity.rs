//! Tier C is a PORT, and a port can drift.
//!
//! `cc_bench::stage` re-implements the shipping TypeScript follower and dim ramp
//! in Rust so the suite can score rendered opacity and placement rather than the
//! engine's estimated position. That is the only way to see defects created in
//! the renderer — the half-token of overshoot from `Math.round`, and the frontier
//! chatter — and it is also a second copy of numbers that live somewhere else.
//!
//! A Tier-C result is a statement about the model. It is a statement about the
//! PRODUCT only to the extent the two agree, so the constants both sides carry
//! are asserted against the real file here rather than trusted. The repo already
//! does this for the stage event protocol (a Rust test `include_str!`s the
//! TypeScript contract); this is the same idea for the renderer's numbers.
//!
//! The Svelte file is the AUTHORITY and the Rust constant follows it. The test
//! cannot enforce which side a person edits, but every failure message says which
//! way to fix it.
//!
//! Values are parsed out of the stylesheet rather than duplicated as literals: a
//! literal here would be a third copy, and the point is to have one authority.

/// `InlineNodes.svelte` is the authority for every per-word rendering number.
const INLINE_NODES: &str = include_str!("../../../src/stage/renderer/InlineNodes.svelte");

/// The fallback in the first `var(--name, <number><suffix>)` of `source`.
///
/// Parsed to the closing paren rather than by a fixed suffix so `240ms` and
/// `0.78` both work, and so a `max(var(--a, 1), var(--b, 2))` cannot be read as
/// one value. Returns None rather than a default: a silently-defaulted parse
/// would make this whole file pass by accident.
///
/// Callers pass a SCOPED slice wherever a property appears more than once —
/// `--stage-past-opacity` occurs four times, and a first-occurrence search would
/// silently follow it to whichever rule happened to be edited first.
fn css_var_fallback(source: &str, name: &str) -> Option<f64> {
    let needle = format!("var({name},");
    let start = source.find(&needle)? + needle.len();
    let rest = &source[start..];
    let end = rest.find(')')?;
    rest[..end].trim().trim_end_matches("ms").trim().parse().ok()
}

/// The body of the first CSS rule whose selector matches, `{` exclusive.
fn rule_body<'a>(source: &'a str, selector: &str) -> Option<&'a str> {
    let at = source.find(selector)?;
    let open = source[at..].find('{')? + at + 1;
    let close = source[open..].find('}')? + open;
    Some(&source[open..close])
}

/// The number in a `const NAME = <value>;` declaration in the TypeScript.
fn ts_const(source: &str, name: &str) -> Option<f64> {
    let needle = format!("{name} = ");
    let start = source.find(&needle)? + needle.len();
    let rest = &source[start..];
    let end = rest.find(';')?;
    rest[..end].trim().parse().ok()
}

#[test]
fn the_dim_tween_matches_the_renderer() {
    let shipped = css_var_fallback(INLINE_NODES, "--stage-fx-ms")
        .expect("InlineNodes.svelte no longer declares a --stage-fx-ms fallback");
    assert_eq!(
        cc_bench::stage::DIM_TWEEN_MS, shipped,
        "Tier C models a {}ms word tween and the renderer ships {shipped}ms. Every \
         ink.* row is measured through this number, so a mismatch does not fail \
         loudly — it quietly reports latency the product does not have. Fix \
         cc_bench::stage::DIM_TWEEN_MS to match the stylesheet.",
        cc_bench::stage::DIM_TWEEN_MS,
    );
}

#[test]
fn the_retreat_debounce_matches_the_renderer() {
    let shipped = ts_const(INLINE_NODES, "DIM_RETREAT_DEBOUNCE_MS")
        .expect("InlineNodes.svelte no longer declares DIM_RETREAT_DEBOUNCE_MS");
    assert_eq!(
        cc_bench::stage::DIM_RETREAT_DEBOUNCE_MS, shipped,
        "Tier C debounces frontier retreat at {}ms and the renderer ships {shipped}ms. \
         `ink.corrections_per_1k` is exactly the row this number moves. Fix \
         cc_bench::stage::DIM_RETREAT_DEBOUNCE_MS to match the component.",
        cc_bench::stage::DIM_RETREAT_DEBOUNCE_MS,
    );
}

#[test]
fn the_dim_ramp_steps_match_the_renderer() {
    /*
     * Each rung is `opacity: max(var(--stage-past-opacity, 0.42), var(--stage-dim-N, X))`,
     * so the rule body holds TWO numbers and the step is the second.
     *
     * Parsed by custom-property name rather than by searching the body for the
     * expected digits, which is what this test did first and was wrong: a
     * substring check would accept a Rust step of 0.4 because the body contains
     * `0.42`. Reading the named fallback cannot be satisfied by a neighbouring
     * number.
     *
     * Rung 0 is the lit state and has no rule of its own; the deepest rung falls
     * through to `.past`, which is asserted separately below.
     */
    for (rung, expected) in cc_bench::stage::DIM_STEPS.iter().enumerate().skip(1) {
        let selector = format!(".w[data-dim='{rung}']");
        let body = rule_body(INLINE_NODES, &selector)
            .unwrap_or_else(|| panic!("no {selector} rule in InlineNodes.svelte"));
        // Scoped to the rule, so swapping which selector carries which custom
        // property is a failure rather than a rename the test cannot see.
        let property = format!("--stage-dim-{rung}");
        let shipped = css_var_fallback(body, &property).unwrap_or_else(|| {
            panic!("{selector} no longer sets {property}; it says:{body}")
        });
        assert_eq!(
            *expected, shipped,
            "Tier C models data-dim='{rung}' at {expected} and the stylesheet ships \
             {shipped}. Fix cc_bench::stage::DIM_STEPS to match.",
        );
    }

    /*
     * ...and the ramp is the same WIDTH on both sides.
     *
     * Driving the loop from Rust's array only proves the rungs Rust already
     * knows about. A fifth rung added to the stylesheet, or a `DIM_RAMP_WORDS`
     * raised without a matching step, would leave Tier C modelling a narrower
     * ramp than the product draws and every ink.* row quietly wrong.
     */
    let ramp_words = ts_const(INLINE_NODES, "DIM_RAMP_WORDS")
        .expect("InlineNodes.svelte no longer declares DIM_RAMP_WORDS");
    assert_eq!(
        cc_bench::stage::DIM_STEPS.len() as f64,
        ramp_words,
        "the stylesheet ramps over {ramp_words} words and Tier C carries {} steps",
        cc_bench::stage::DIM_STEPS.len(),
    );
    assert!(
        rule_body(INLINE_NODES, &format!(".w[data-dim='{}']", cc_bench::stage::DIM_STEPS.len()))
            .is_none(),
        "the stylesheet grew a data-dim='{}' rung that Tier C does not model; the \
         deepest rung is supposed to fall through to `.past`",
        cc_bench::stage::DIM_STEPS.len(),
    );
    // The lit state is not a shade the stylesheet can set, so it is asserted
    // rather than parsed — an unused sentinel that drifted would still mislead.
    assert_eq!(
        cc_bench::stage::DIM_STEPS[0], 1.0,
        "DIM_STEPS[0] is the un-dimmed state and must stay 1.0",
    );
}

#[test]
fn the_far_past_opacity_matches_the_renderer() {
    // The floor every rung is clamped to, and the shade the deepest rung falls
    // through to. Tier C weighs unread ink by how dark it went, so this number
    // is a factor in the safety gate rather than decoration.
    // Scoped to `.w.past`: the property also appears as the clamp floor inside
    // each ramp rung, so an unscoped search would assert against whichever of
    // the four occurrences came first in the file.
    let body = rule_body(INLINE_NODES, ".w.past {").expect("no .w.past rule in InlineNodes.svelte");
    let shipped = css_var_fallback(body, "--stage-past-opacity")
        .expect(".w.past no longer sets --stage-past-opacity");
    assert_eq!(
        cc_bench::stage::PAST_OPACITY, shipped,
        "Tier C models the far past at {} and the stylesheet ships {shipped}. Fix \
         cc_bench::stage::PAST_OPACITY to match.",
        cc_bench::stage::PAST_OPACITY,
    );
}
