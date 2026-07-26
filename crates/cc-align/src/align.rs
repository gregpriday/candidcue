//! The observation model: weighted, banded, query-global / reference-local
//! semi-global alignment (Gotoh-style affine gaps, integer milli-costs).
//!
//! The full transcript tail must be explained; it may attach to any bounded
//! span inside a candidate script region. Transcript insertions model fillers,
//! ad-libs and recogniser junk; script deletions model locally skipped words.
//! A far skip or retake is represented by *choosing another candidate region*,
//! never by paying hundreds of deletion costs — that asymmetry is what keeps a
//! short exact fragment from "winning" against a contradictory tail.
//!
//! Costs are non-negative errors. For the chosen path we report
//! `fidelity = 1 − E/Z` where `Z` is the cost of explaining the same query and
//! consumed script span with no matches at all. A verbatim read therefore has
//! `E = 0` and fidelity exactly `1.0` regardless of token weights — the
//! mandatory invariant from the spec (§10.4), enforced by a property test.

use crate::config::AlignmentConfig;
use crate::ledger::QueryAtom;
use crate::script::CompiledScript;

/// What one aligned query atom did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    Exact,
    Fuzzy,
    Substitution,
    Insertion,
}

/// Everything the ranker and the confidence model need to know about one
/// candidate alignment, kept as separate features rather than one opaque
/// score (spec §10.5).
#[derive(Debug, Clone, Default)]
pub struct Evidence {
    /// 1 − E/Z in [0,1].
    pub fidelity: f64,
    /// Matched query atoms / non-filler query atoms.
    pub coverage: f64,
    /// Σ script-weight × stability multiplier over exact+fuzzy matches (milli).
    pub matched_weight: f64,
    /// Same, but stable/final query atoms only.
    pub matched_stable_weight: f64,
    /// Longest run of consecutive exact matches.
    pub longest_run: u32,
    pub exact_matches: u32,
    pub fuzzy_matches: u32,
    pub substitutions: u32,
    pub insertions: u32,
    pub deletions: u32,
    /// Exact-matched *content* (non-stopword) query atoms.
    pub content_matches: u32,
    /// Content matches among stable/final query atoms.
    pub stable_content_matches: u32,
    /// Script boundary position AFTER the last aligned atom (atoms, integer).
    pub end_position: u32,
    /// Boundary after the last exact match backed by STABLE/FINAL evidence —
    /// the furthest point the confirmed position may advance to from a
    /// partial (spec §7.4).
    pub stable_end_position: u32,
    /// First script atom consumed by the path.
    pub start_position: u32,
    /// Audio time of the last *matched* query atom (for lag compensation).
    pub last_match_audio_ms: f64,
    /// Query index (0-based) of the last matched atom.
    pub last_match_query_index: Option<usize>,
    /// Query index of the last atom in the last SOLID run (≥2 consecutive
    /// exact matches). A single stray stopword match deep in the tail must
    /// not make the material after it look "explained" — self-similar text
    /// produces those constantly.
    pub last_solid_match_query_index: Option<usize>,
}

/// Scratch buffers reused across alignments so the hot path allocates nothing.
pub struct AlignScratch {
    m: Vec<i64>,
    i: Vec<i64>,
    d: Vec<i64>,
}

const HUGE: i64 = i64::MAX / 4;

impl AlignScratch {
    pub fn new() -> Self {
        Self {
            m: Vec::new(),
            i: Vec::new(),
            d: Vec::new(),
        }
    }

    fn ensure(&mut self, rows: usize, cols: usize) {
        let need = rows * cols;
        if self.m.len() < need {
            self.m.resize(need, 0);
            self.i.resize(need, 0);
            self.d.resize(need, 0);
        }
    }
}

impl Default for AlignScratch {
    fn default() -> Self {
        Self::new()
    }
}

/// Is `b` within a small edit distance of `a`? Bounded Levenshtein used for
/// the fuzzy relation: distance ≤1 for length 5–8, ≤2 for 9+ (spec §10.6).
pub fn fuzzy_match(a: &str, b: &str) -> bool {
    let (la, lb) = (a.chars().count(), b.chars().count());
    let min_len = la.min(lb);
    if min_len < 5 {
        return false;
    }
    let max_d = if la.max(lb) >= 9 { 2 } else { 1 };
    if la.abs_diff(lb) > max_d {
        return false;
    }
    levenshtein_bounded(a, b, max_d)
}

fn levenshtein_bounded(a: &str, b: &str, bound: usize) -> bool {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        let mut row_min = cur[0];
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
            row_min = row_min.min(cur[j + 1]);
        }
        if row_min > bound {
            return false;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()] <= bound
}

/// Align `query` against `script[region_start..region_end]`.
///
/// Returns `None` for an empty query or empty region — "no evidence" is a
/// first-class outcome, never a zero-confidence guess.
#[allow(clippy::too_many_arguments)]
pub fn align(
    script: &CompiledScript,
    query: &[QueryAtom],
    region_start: u32,
    region_end: u32,
    config: &AlignmentConfig,
    scratch: &mut AlignScratch,
) -> Option<Evidence> {
    let n = query.len();
    let region_start = region_start.min(script.len() as u32);
    let region_end = region_end.min(script.len() as u32);
    if n == 0 || region_start >= region_end {
        return None;
    }
    let w = (region_end - region_start) as usize; // reference columns
    let rows = n + 1;
    let cols = w + 1;
    scratch.ensure(rows, cols);
    let idx = |i: usize, j: usize| i * cols + j;

    // Row 0: free start anywhere in the region (reference-local), but a
    // *consumed-then-abandoned* prefix is not free — deletions only start
    // counting once the path has begun matching, which falls out of the free
    // start: the path simply starts later.
    for j in 0..cols {
        scratch.m[idx(0, j)] = 0;
        scratch.i[idx(0, j)] = HUGE;
        scratch.d[idx(0, j)] = HUGE;
    }

    for i in 1..rows {
        let q = &query[i - 1];
        let stab = q.stability.multiplier_milli() as i64;
        // Insertion cost: fillers are cheap; provisional atoms are cheaper to
        // ignore than stable ones (they may be about to be retracted).
        let (ins_open, ins_extend) = if q.filler {
            (config.cost_insert_filler as i64, config.cost_insert_filler as i64)
        } else {
            (
                (config.cost_insert_open as i64 * stab) / 1000,
                (config.cost_insert_extend as i64 * stab) / 1000,
            )
        };

        // Column 0: the query prefix so far must all be insertions.
        scratch.m[idx(i, 0)] = HUGE;
        scratch.d[idx(i, 0)] = HUGE;
        let above_i = scratch.i[idx(i - 1, 0)];
        let above_m = scratch.m[idx(i - 1, 0)];
        scratch.i[idx(i, 0)] = (above_i.saturating_add(ins_extend))
            .min(above_m.saturating_add(ins_open));

        for j in 1..cols {
            let s = &script.atoms[region_start as usize + j - 1];
            let weight = s.weight as i64;

            // --- M: diagonal (exact / fuzzy / substitution) ---
            let rel_cost = if q.id == s.id {
                0
            } else if fuzzy_match(&q.surface, &s.surface) {
                (config.cost_fuzzy as i64 * weight) / 1000
            } else {
                (config.cost_substitution as i64 * weight) / 1000
            };
            let diag_best = scratch.m[idx(i - 1, j - 1)]
                .min(scratch.i[idx(i - 1, j - 1)])
                .min(scratch.d[idx(i - 1, j - 1)]);
            scratch.m[idx(i, j)] = diag_best.saturating_add(rel_cost);

            // --- I: transcript insertion (query consumed, script stays) ---
            let from_m = scratch.m[idx(i - 1, j)].saturating_add(ins_open);
            let from_i = scratch.i[idx(i - 1, j)].saturating_add(ins_extend);
            scratch.i[idx(i, j)] = from_m.min(from_i);

            // --- D: script deletion (script consumed, query stays) ---
            let del_open = weight;
            let del_extend = (weight * config.del_extend_factor_milli as i64) / 1000;
            let dm = scratch.m[idx(i, j - 1)].saturating_add(del_open);
            let dd = scratch.d[idx(i, j - 1)].saturating_add(del_extend);
            scratch.d[idx(i, j)] = dm.min(dd);
        }
    }

    // Free end: best cell in the last row over M and I (ending on a deletion
    // would mean "the presenter is past words never spoken" — disallowed).
    let mut best_j = 0usize;
    let mut best_cost = HUGE;
    let mut best_state = 0u8; // 0 = M, 1 = I
    for j in 0..cols {
        let m = scratch.m[idx(n, j)];
        let i_ = scratch.i[idx(n, j)];
        if m < best_cost {
            best_cost = m;
            best_j = j;
            best_state = 0;
        }
        if i_ < best_cost {
            best_cost = i_;
            best_j = j;
            best_state = 1;
        }
    }
    if best_cost >= HUGE {
        return None;
    }

    // Backtrace, accumulating evidence features.
    let mut ev = Evidence {
        end_position: region_start + best_j as u32,
        ..Default::default()
    };
    let mut i = n;
    let mut j = best_j;
    let mut state = best_state; // 0=M, 1=I, 2=D
    let mut run = 0u32;
    let mut consumed_script_weight: i64 = 0;
    let mut insert_denominator: i64 = 0;
    let mut first_consumed_j = best_j;
    // Backtrace-order adjacency tracking for solid runs.
    let mut prev_exact_qi: Option<usize> = None;

    while i > 0 || (state == 2 && j > 0) {
        match state {
            0 => {
                // Diagonal.
                let q = &query[i - 1];
                let s = &script.atoms[region_start as usize + j - 1];
                let stab_mult = q.stability.multiplier_milli() as f64 / 1000.0;
                let weight = s.weight as f64;
                first_consumed_j = j - 1;
                consumed_script_weight += s.weight as i64;
                insert_denominator += insert_cost_for_denominator(q, config);
                if q.id == s.id {
                    ev.exact_matches += 1;
                    run += 1;
                    ev.longest_run = ev.longest_run.max(run);
                    // Backtrace runs end→start: the first adjacent exact
                    // pair seen is the LAST solid run of the path.
                    if ev.last_solid_match_query_index.is_none()
                        && prev_exact_qi == Some(i)
                    {
                        ev.last_solid_match_query_index = Some(i);
                    }
                    prev_exact_qi = Some(i - 1);
                    ev.matched_weight += weight * stab_mult;
                    if q.stability.is_stable() {
                        ev.matched_stable_weight += weight * stab_mult;
                        // Backtrace runs end→start, so the first stable exact
                        // match seen here is the furthest one.
                        if ev.stable_end_position == 0 {
                            ev.stable_end_position = region_start + j as u32;
                        }
                    }
                    if !crate::normalize::is_stopword(&q.surface) && !q.filler {
                        ev.content_matches += 1;
                        if q.stability.is_stable() {
                            ev.stable_content_matches += 1;
                        }
                    }
                    if ev.last_match_query_index.is_none() {
                        ev.last_match_query_index = Some(i - 1);
                        ev.last_match_audio_ms = q.audio_ms;
                        ev.end_position = region_start + j as u32;
                    }
                } else if fuzzy_match(&q.surface, &s.surface) {
                    ev.fuzzy_matches += 1;
                    run = 0;
                    prev_exact_qi = None;
                    ev.matched_weight += weight * stab_mult * 0.5;
                    if q.stability.is_stable() {
                        ev.matched_stable_weight += weight * stab_mult * 0.5;
                    }
                    if ev.last_match_query_index.is_none() {
                        ev.last_match_query_index = Some(i - 1);
                        ev.last_match_audio_ms = q.audio_ms;
                        ev.end_position = region_start + j as u32;
                    }
                } else {
                    ev.substitutions += 1;
                    run = 0;
                    prev_exact_qi = None;
                }
                // Where did the diagonal come from?
                let prev_m = scratch.m[idx(i - 1, j - 1)];
                let prev_i = scratch.i[idx(i - 1, j - 1)];
                let prev_d = scratch.d[idx(i - 1, j - 1)];
                state = if prev_m <= prev_i && prev_m <= prev_d {
                    0
                } else if prev_i <= prev_d {
                    1
                } else {
                    2
                };
                i -= 1;
                j -= 1;
            }
            1 => {
                // Insertion: query atom explained as off-script.
                let q = &query[i - 1];
                ev.insertions += 1;
                run = 0;
                prev_exact_qi = None;
                insert_denominator += insert_cost_for_denominator(q, config);
                // Recompute the same open/extend costs the forward pass used
                // for this row — comparing raw predecessor values would pick
                // the wrong branch whenever open ≠ extend.
                let stab = q.stability.multiplier_milli() as i64;
                let (ins_open, ins_extend) = if q.filler {
                    (
                        config.cost_insert_filler as i64,
                        config.cost_insert_filler as i64,
                    )
                } else {
                    (
                        (config.cost_insert_open as i64 * stab) / 1000,
                        (config.cost_insert_extend as i64 * stab) / 1000,
                    )
                };
                let from_m = scratch.m[idx(i - 1, j)].saturating_add(ins_open);
                let from_i = scratch.i[idx(i - 1, j)].saturating_add(ins_extend);
                state = if from_m <= from_i { 0 } else { 1 };
                i -= 1;
            }
            _ => {
                // Deletion: script atom skipped.
                let s = &script.atoms[region_start as usize + j - 1];
                ev.deletions += 1;
                run = 0;
                prev_exact_qi = None;
                first_consumed_j = j - 1;
                consumed_script_weight += s.weight as i64;
                let weight = s.weight as i64;
                let del_open = weight;
                let del_extend = (weight * config.del_extend_factor_milli as i64) / 1000;
                let from_m = scratch.m[idx(i, j - 1)].saturating_add(del_open);
                let from_d = scratch.d[idx(i, j - 1)].saturating_add(del_extend);
                state = if from_m <= from_d { 0 } else { 2 };
                j -= 1;
            }
        }
    }

    ev.start_position = region_start + first_consumed_j as u32;

    // Fidelity: E over "explain everything with no matches".
    let z = insert_denominator + consumed_script_weight;
    ev.fidelity = if z <= 0 {
        0.0
    } else {
        (1.0 - best_cost as f64 / z as f64).clamp(0.0, 1.0)
    };

    let non_filler: u32 = query.iter().filter(|q| !q.filler).count() as u32;
    ev.coverage = if non_filler == 0 {
        0.0
    } else {
        f64::from(ev.exact_matches + ev.fuzzy_matches) / f64::from(non_filler)
    };
    Some(ev)
}

/// The cost this query atom would contribute to the "no matches" explanation:
/// what the DP would pay to insert it (open cost; the denominator does not
/// model affine runs, which only makes Z larger — i.e. fidelity conservative).
fn insert_cost_for_denominator(q: &QueryAtom, config: &AlignmentConfig) -> i64 {
    if q.filler {
        config.cost_insert_filler as i64
    } else {
        (config.cost_insert_open as i64 * q.stability.multiplier_milli() as i64) / 1000
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AlignmentConfig;
    use crate::ledger::StabilityClass;
    use crate::script::{compile, CompileOptions};

    fn query_from(text: &str, script: &mut CompiledScript) -> Vec<QueryAtom> {
        crate::normalize::canonical_atoms(text)
            .into_iter()
            .enumerate()
            .map(|(i, surface)| {
                let id = script.interner.intern(&surface);
                let filler = crate::normalize::is_filler(&surface);
                QueryAtom {
                    id,
                    surface,
                    stability: StabilityClass::Final,
                    filler,
                    audio_ms: i as f64 * 300.0,
                    item_index: 0,
                }
            })
            .collect()
    }

    fn run(script_text: &str, spoken: &str) -> (Evidence, CompiledScript) {
        let mut script = compile(script_text, CompileOptions::default());
        let query = query_from(spoken, &mut script);
        let config = AlignmentConfig::default();
        let mut scratch = AlignScratch::new();
        let len = script.len() as u32;
        let ev = align(&script, &query, 0, len, &config, &mut scratch).unwrap();
        (ev, script)
    }

    #[test]
    fn verbatim_read_has_fidelity_one() {
        let text = "The quick brown fox jumps over the lazy dog near the riverbank today.";
        let (ev, _) = run(text, "the quick brown fox jumps over the lazy dog near the riverbank today");
        assert_eq!(ev.fidelity, 1.0, "verbatim must be exactly 1.0");
        assert_eq!(ev.substitutions, 0);
        assert_eq!(ev.coverage, 1.0);
    }

    #[test]
    fn verbatim_fragment_in_the_middle_scores_one_and_positions_correctly() {
        let (ev, _) = run(
            "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
            "delta echo foxtrot",
        );
        assert_eq!(ev.fidelity, 1.0);
        assert_eq!(ev.start_position, 3);
        assert_eq!(ev.end_position, 6);
    }

    #[test]
    fn single_substitution_keeps_lock_and_position() {
        let (ev, _) = run(
            "we should build a complicated system for testing scripts",
            "we should build a complex system for testing scripts",
        );
        // complicated → complex is not within edit distance; it's a plain sub
        // OR a fuzzy match — either way position must hold and fidelity stays
        // high because everything else matches exactly.
        assert!(ev.fidelity > 0.6, "fidelity {}", ev.fidelity);
        assert_eq!(ev.end_position, 9);
        assert!(ev.substitutions + ev.fuzzy_matches == 1);
    }

    #[test]
    fn fillers_are_cheap_insertions() {
        let (ev, _) = run(
            "we should build a complicated system",
            "we should um uh build a complicated system",
        );
        assert_eq!(ev.insertions, 2);
        assert!(ev.fidelity > 0.9, "fillers must barely dent fidelity: {}", ev.fidelity);
        assert_eq!(ev.end_position, 6);
    }

    #[test]
    fn local_deletion_is_tolerated() {
        let (ev, _) = run(
            "the presenter reads the script aloud while the display follows every word",
            "the presenter reads the script while the display follows every word",
        );
        assert_eq!(ev.deletions, 1);
        assert!(ev.fidelity > 0.75);
        assert_eq!(ev.end_position, 12);
    }

    #[test]
    fn fuzzy_matches_near_misses() {
        assert!(fuzzy_match("teleprompter", "teleprompters"));
        assert!(fuzzy_match("presenter", "presentor"));
        assert!(!fuzzy_match("cat", "car")); // too short
        assert!(!fuzzy_match("system", "systematic"));
    }

    #[test]
    fn empty_query_returns_none() {
        let script = compile("hello world", CompileOptions::default());
        let config = AlignmentConfig::default();
        let mut scratch = AlignScratch::new();
        assert!(align(&script, &[], 0, 2, &config, &mut scratch).is_none());
    }
}
