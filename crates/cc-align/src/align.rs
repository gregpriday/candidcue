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
    /// The word is not here, but it is nearby — see [`Evidence::displaced_matches`].
    Displaced,
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
    /// Phonetic-key matches on rare long words (names). Evidence for local
    /// fidelity only — they carry no discontinuity authority.
    pub phonetic_matches: u32,
    /// Content words spoken here that belong a few atoms away — a phrase read
    /// back in the wrong order, a self-correction, a mild paraphrase that
    /// reuses the sentence's own vocabulary.
    ///
    /// Evidence that the reader is still in this neighbourhood, and nothing
    /// whatever about WHICH word they are on.
    ///
    /// UNSOUND AS IT STANDS, WHICH IS WHY THE RELATION SHIPS DISABLED. The
    /// displaced BRANCH does not write `end_position` — but its diagonal still
    /// consumes a script slot, so a later exact match sets `end_position`
    /// BEYOND a word the reader has not spoken. Measured on a live partial
    /// against `keeping voice alpha and steady`: off, the mark parks at
    /// `voice`; on, it reaches `and`, having faded the unspoken `alpha`.
    /// Fixing this needs a positional frontier that refuses to cross an
    /// unresolved displaced cell without a trustworthy re-anchor.
    pub displaced_matches: u32,
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
    /// Query index of the last atom in the last SOLID run: two adjacent
    /// matches, at least one of them exact. A single stray stopword match deep
    /// in the tail must not make the material after it look "explained" —
    /// self-similar text produces those constantly.
    ///
    /// The pair may include a displaced match, which is how a phrase read back
    /// in the wrong order stays accounted for; it may not consist of two, which
    /// is how off-script speech that happens to reuse the paragraph's own words
    /// stays unaccounted for.
    pub last_solid_match_query_index: Option<usize>,
}

/// Scratch buffers reused across alignments so the hot path allocates nothing.
pub struct AlignScratch {
    m: Vec<i64>,
    i: Vec<i64>,
    d: Vec<i64>,
    /// One bit per DP cell: did the displaced relation apply here?
    ///
    /// The forward pass computes this as a sliding window count — O(1) per
    /// cell — and the backtrace needs the same answer several hundred cells
    /// later, by which time the window is long gone. Recomputing it there with
    /// a scan would be a second implementation of the predicate and an
    /// opportunity for the two to disagree, so the one answer is recorded.
    /// A 40 × 640 worst case is 3.2 KB.
    displaced: Vec<u64>,
}

const HUGE: i64 = i64::MAX / 4;

impl AlignScratch {
    pub fn new() -> Self {
        Self {
            m: Vec::new(),
            i: Vec::new(),
            d: Vec::new(),
            displaced: Vec::new(),
        }
    }

    fn ensure(&mut self, rows: usize, cols: usize) {
        let need = rows * cols;
        if self.m.len() < need {
            self.m.resize(need, 0);
            self.i.resize(need, 0);
            self.d.resize(need, 0);
        }
        let words = need.div_ceil(64);
        if self.displaced.len() < words {
            self.displaced.resize(words, 0);
        }
        // Cleared rather than merely sized: this buffer is read by index, and a
        // stale bit from a wider previous alignment would read as a displaced
        // match in a cell that never computed one.
        self.displaced[..words].fill(0);
    }

    #[inline]
    fn set_displaced(&mut self, cell: usize) {
        self.displaced[cell / 64] |= 1u64 << (cell % 64);
    }

    #[inline]
    fn is_displaced(&self, cell: usize) -> bool {
        self.displaced[cell / 64] & (1u64 << (cell % 64)) != 0
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
    if a.is_ascii() && b.is_ascii() {
        let (la, lb) = (a.len(), b.len());
        let min_len = la.min(lb);
        if min_len < 5 {
            return false;
        }
        let max_d = if la.max(lb) >= 9 { 2 } else { 1 };
        if la.abs_diff(lb) > max_d {
            return false;
        }
        return levenshtein_bounded_ascii(a.as_bytes(), b.as_bytes(), max_d);
    }
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

/// Allocation-free fast path for the overwhelmingly common canonical-ASCII
/// case. Script/query atoms are short in practice; unusually long tokens fall
/// back to the Unicode implementation rather than growing the DP hot path.
fn levenshtein_bounded_ascii(a: &[u8], b: &[u8], bound: usize) -> bool {
    const MAX_TOKEN: usize = 64;
    if a.len() > MAX_TOKEN || b.len() > MAX_TOKEN {
        let a = std::str::from_utf8(a).expect("ASCII");
        let b = std::str::from_utf8(b).expect("ASCII");
        return levenshtein_bounded(a, b, bound);
    }
    let mut prev = [0u8; MAX_TOKEN + 1];
    let mut cur = [0u8; MAX_TOKEN + 1];
    for (j, cell) in prev.iter_mut().enumerate().take(b.len() + 1) {
        *cell = j as u8;
    }
    for (i, ca) in a.iter().enumerate() {
        cur[0] = (i + 1) as u8;
        let mut row_min = cur[0];
        for (j, cb) in b.iter().enumerate() {
            let substitution = prev[j] + u8::from(ca != cb);
            cur[j + 1] = substitution.min(prev[j + 1] + 1).min(cur[j] + 1);
            row_min = row_min.min(cur[j + 1]);
        }
        if row_min as usize > bound {
            return false;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()] as usize <= bound
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

    // Only content words can be displaced. "the" occurs within a few atoms of
    // very nearly everything, so letting a stopword claim the relation would
    // discount half the substitutions in the script and tell us nothing.
    // Hoisted out of the inner loop: this is a per-word fact, and the string
    // comparison behind it has no business running once per DP cell.
    let window = config.displaced_window_atoms as usize;

    for i in 1..rows {
        let q = &query[i - 1];
        let stab = q.stability.multiplier_milli() as i64;
        let q_displaceable =
            window > 0 && !q.filler && !crate::normalize::is_stopword(&q.surface);
        /*
         * Every position this word occupies in the script, ascending.
         *
         * This relation costs ~11% of total engine time (90 → 101 µs/event on
         * Tier A) and that is inherent, not a defect of this formulation: the
         * predicate has to be answered for essentially every DP cell, because
         * all but the diagonal fall through to it. A sliding count over
         * `script.atoms` was written first and measured identically, so the fat
         * `ScriptAtom` array was not the cost and neither is the postings walk.
         * Evaluating it lazily inside the `else if` saves nothing for the same
         * reason. Postings are kept because the cursor below is easier to prove
         * correct than a hand-maintained enter/leave count, not because they are
         * faster.
         *
         * 101 µs against a partial cadence of ~1 s is not a budget problem, and
         * `perf.scale_ratio_5k` — the property the architecture actually cares
         * about — stays flat.
         */
        let postings: &[u32] = if q_displaceable {
            script
                .token_postings
                .get(&q.id)
                .map(|v| v.as_slice())
                .unwrap_or(&[])
        } else {
            &[]
        };
        // Cursor into `postings`. `j` only increases across the row, so the
        // window's left edge only increases, so this only moves forward — the
        // whole scan is amortised O(1) per cell.
        let mut post_lo = 0usize;
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
            let center = region_start as usize + j - 1;
            let s = &script.atoms[center];
            let weight = s.weight as i64;

            // Drop postings that have fallen off the left of the window.
            // Phrased as `p + window < center` rather than `p < center - window`
            // because `center` is below `window` for the first columns of a
            // region that starts at the top of the script, and the subtraction
            // would wrap.
            while post_lo < postings.len()
                && (postings[post_lo] as usize) + window < center
            {
                post_lo += 1;
            }
            // Does this word sit somewhere else inside the window? Bounded by
            // the window width, and one comparison in the overwhelmingly common
            // case of a word that occurs once.
            //
            // Occurrences outside the aligned region do not count: the region is
            // what this alignment is explaining, and a word beyond its edge is
            // evidence for a candidate nobody asked about.
            let mut displaced_here = false;
            let mut k = post_lo;
            while k < postings.len() {
                let p = postings[k] as usize;
                if p > center + window {
                    break;
                }
                if p != center && p >= region_start as usize && p < region_end as usize {
                    displaced_here = true;
                    break;
                }
                k += 1;
            }

            // --- M: diagonal (exact / fuzzy / phonetic / displaced / sub) ---
            //
            // The column itself is excluded above, so a hit is by construction
            // somewhere OTHER than the slot being scored.
            let rel_cost = if q.id == s.id {
                0
            } else if fuzzy_match(&q.surface, &s.surface) {
                (config.cost_fuzzy as i64 * weight) / 1000
            } else if phonetic_ok(q, s) {
                (config.cost_phonetic as i64 * weight) / 1000
            } else if displaced_here {
                scratch.set_displaced(idx(i, j));
                /*
                 * Scaled by query STABILITY as well as script weight — the only
                 * relation in the ladder that is, and it has to be.
                 *
                 * This relation's real competitor is not substitution, it is
                 * INSERTION: an unexplained tail can always be dropped instead
                 * of related to anything, and insertion cost is stability-scaled
                 * (`cost_insert_open` × stab). The trailing atoms of a live
                 * partial are `TrailingProvisional`, ×0.35, so dropping the two
                 * words of a fresh scramble costs 443 — against 1200 for two
                 * unscaled displaced matches. Without this the relation loses
                 * every time, and it loses in exactly the window it exists for:
                 * the reader mid-phrase, the mark stalled behind them, the
                 * transcript still provisional. It would only start working once
                 * the utterance finalised, which is after the stall.
                 *
                 * Scaling both sides the same way makes the comparison mean
                 * something at every stability class instead of only at Final.
                 */
                (config.cost_displaced as i64 * weight * stab) / 1_000_000
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
    // Backtrace-order adjacency tracking for solid runs: the query index of the
    // atom visited immediately before this one (so, the NEXT one in time) and
    // whether it matched exactly. Displaced matches are carried here so they can
    // JOIN a solid run without being able to form one — see the exact branch.
    let mut prev_match: Option<(usize, bool)> = None;

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
                if q.id == s.id && q.filler {
                    // A filler matching a scripted filler consumes both
                    // sides but carries NO positional evidence (spec: filler
                    // insertion is cheap but never supplies position). It
                    // must not extend runs, coverage, or matched weight.
                    prev_match = None;
                    run = 0;
                } else if q.id == s.id {
                    ev.exact_matches += 1;
                    run += 1;
                    ev.longest_run = ev.longest_run.max(run);
                    // Backtrace runs end→start: the first adjacent solid
                    // pair seen is the LAST solid run of the path.
                    if ev.last_solid_match_query_index.is_none()
                        && matches!(prev_match, Some((idx, _)) if idx == i)
                    {
                        ev.last_solid_match_query_index = Some(i);
                    }
                    prev_match = Some((i - 1, true));
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
                    prev_match = None;
                    ev.matched_weight += weight * stab_mult * 0.5;
                    if q.stability.is_stable() {
                        ev.matched_stable_weight += weight * stab_mult * 0.5;
                    }
                    if ev.last_match_query_index.is_none() {
                        ev.last_match_query_index = Some(i - 1);
                        ev.last_match_audio_ms = q.audio_ms;
                        ev.end_position = region_start + j as u32;
                    }
                } else if phonetic_ok(q, s) {
                    ev.phonetic_matches += 1;
                    run = 0;
                    prev_match = None;
                    ev.matched_weight += weight * stab_mult * 0.4;
                    if ev.last_match_query_index.is_none() {
                        ev.last_match_query_index = Some(i - 1);
                        ev.last_match_audio_ms = q.audio_ms;
                        ev.end_position = region_start + j as u32;
                    }
                } else if scratch.is_displaced(idx(i, j)) {
                    ev.displaced_matches += 1;
                    // Breaks the exact run — `longest_run` means verbatim, and
                    // this is the opposite of verbatim.
                    run = 0;
                    /*
                     * A displaced match may JOIN a solid run and may never form
                     * one: the pair must contain an exact match. Two scrambled
                     * words with nothing verbatim beside them are the profile of
                     * genuinely off-script speech that happens to reuse the
                     * paragraph's vocabulary, and `last_solid_match_query_index`
                     * is what licenses the tracker to stop looking for a jump.
                     * That authority stays anchored to words actually read.
                     */
                    if ev.last_solid_match_query_index.is_none()
                        && matches!(prev_match, Some((idx, true)) if idx == i)
                    {
                        ev.last_solid_match_query_index = Some(i);
                    }
                    prev_match = Some((i - 1, false));
                    ev.matched_weight += weight * stab_mult * 0.4;
                    if q.stability.is_stable() {
                        ev.matched_stable_weight += weight * stab_mult * 0.4;
                    }
                    /*
                     * Deliberately NOT setting `last_match_query_index`,
                     * `last_match_audio_ms` or `end_position`.
                     *
                     * This is the safety property of the whole relation. We know
                     * the reader is in this neighbourhood; we do not know which
                     * word they are on, and a word said out of order is evidence
                     * for the former and none at all for the latter. Advancing
                     * the position here would fade text they have not reached —
                     * the one error this engine may never make.
                     */
                } else {
                    ev.substitutions += 1;
                    run = 0;
                    prev_match = None;
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
                prev_match = None;
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
                prev_match = None;
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
        // Coverage asks how much of what was HEARD this region accounts for,
        // which is a different question from where the reader is — so a
        // displaced word counts here even though it may not move the position.
        f64::from(
            ev.exact_matches + ev.fuzzy_matches + ev.phonetic_matches + ev.displaced_matches,
        ) / f64::from(non_filler)
    };
    Some(ev)
}

/// Last-resort phonetic relation: the script atom is a rare anchor-grade word
/// and the two sound alike.
///
/// The length and anchor tests that used to live here are now facts about the
/// keys: both are empty unless the word qualified when it was encoded.
fn phonetic_ok(q: &QueryAtom, s: &crate::script::ScriptAtom) -> bool {
    q.phonetic.matches(&s.phonetic)
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
                    phonetic: crate::normalize::phonetic_key(&surface),
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
        run_with(script_text, spoken, AlignmentConfig::default())
    }

    /// The displaced relation ships DISABLED (`displaced_window_atoms: 0`), so
    /// every test of its mechanics has to turn it on explicitly. Doing that
    /// here rather than reading the default is deliberate: these tests describe
    /// what the relation DOES, and must not silently become vacuous if the
    /// default changes again in either direction.
    const TEST_WINDOW: u32 = 2;

    fn run_displaced(script_text: &str, spoken: &str) -> (Evidence, CompiledScript) {
        let mut config = AlignmentConfig::default();
        config.displaced_window_atoms = TEST_WINDOW;
        run_with(script_text, spoken, config)
    }

    fn run_with(
        script_text: &str,
        spoken: &str,
        config: AlignmentConfig,
    ) -> (Evidence, CompiledScript) {
        let mut script = compile(script_text, CompileOptions::default());
        let query = query_from(spoken, &mut script);
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
        // complicated → complex is beyond edit distance; it lands as a
        // substitution or (same consonant skeleton) a phonetic relation —
        // either way position must hold and fidelity stays high because
        // everything else matches exactly.
        assert!(ev.fidelity > 0.6, "fidelity {}", ev.fidelity);
        assert_eq!(ev.end_position, 9);
        assert!(ev.substitutions + ev.fuzzy_matches + ev.phonetic_matches == 1);
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

    /// The case this relation was built for: the reader reorders a phrase live.
    /// Note the swap is over a DISTANCE OF TWO — an adjacent-transposition rule
    /// (the textbook Damerau extension) would not catch it.
    #[test]
    fn transposed_phrase_is_displaced_not_substituted() {
        let (ev, _) = run_displaced(
            "the presenter is keeping my voice clear and steady throughout the whole take",
            "the presenter is keeping my voice steady and clear",
        );
        assert_eq!(ev.displaced_matches, 2, "steady and clear both moved");
        assert_eq!(ev.substitutions, 0, "neither is an unexplained word");
        // The scramble is accounted for: the tracker's unexplained-tail slice
        // starts after it, so a reorder does not read as the reader vanishing.
        assert_eq!(ev.last_solid_match_query_index, Some(8));
    }

    /// The safety property. A displaced match says the reader is in this
    /// neighbourhood; it must never claim to know which word they are on,
    /// because fading a word they have not reached is unrecoverable.
    #[test]
    fn displaced_match_never_advances_the_position() {
        let script = "alpha bravo charlie keeping my voice clear and steady omega";
        let (ev, _) = run_displaced(script, "keeping my voice steady and clear");
        // "keeping my voice" is atoms 3..6, "clear and steady" is 6..9.
        // The last EXACT match is "and" at atom 7, so the position stops there
        // — not at 9, which is where the path actually ends.
        assert_eq!(ev.end_position, 8);
    }

    /// The relation must not fire on genuine off-script speech. An ad-lib is
    /// made of words the paragraph does not contain, and every one of them has
    /// to stay a substitution or an insertion — otherwise going off script
    /// would look like reading it, which is the failure `recovery.adlib_*`
    /// exists to catch.
    #[test]
    fn genuine_adlib_produces_no_displaced_matches() {
        let (ev, _) = run(
            "we should build the system for testing scripts today",
            "we should build sorry let me start that sentence again",
        );
        assert_eq!(ev.displaced_matches, 0);
    }

    /// Stopwords occur within a few atoms of nearly everything; letting them
    /// claim the relation would discount half the substitutions in any script.
    #[test]
    fn stopwords_are_never_displaced() {
        let (ev, _) = run(
            "we should build the system for testing and shipping scripts",
            "we should build for system the testing xylophone shipping scripts",
        );
        assert_eq!(
            ev.displaced_matches, 0,
            "'the' and 'for' moved, but they are stopwords"
        );
    }

    /// Far enough away is a substitution again — the relation claims locality
    /// and has to mean it.
    #[test]
    fn a_word_outside_the_window_is_not_displaced() {
        let mut config = AlignmentConfig::default();
        config.displaced_window_atoms = 2;
        let mut script = compile(
            "engineering alpha bravo charlie delta echo foxtrot marketing",
            CompileOptions::default(),
        );
        let query = query_from("marketing alpha bravo", &mut script);
        let mut scratch = AlignScratch::new();
        let len = script.len() as u32;
        let ev = align(&script, &query, 0, len, &config, &mut scratch).unwrap();
        assert_eq!(
            ev.displaced_matches, 0,
            "'marketing' is 7 atoms from where it was said, well past the window"
        );
    }

    /// Zeroing the window restores the previous engine exactly — the escape
    /// hatch the config comment promises — and running the same input both ways
    /// is the clearest statement of what the relation actually buys.
    ///
    /// Without it the scramble parses as two INSERTIONS: the reader appears to
    /// have stopped reading after "voice" and said two off-script words. The
    /// position parks there and the accounted-for tail ends at "voice", which
    /// is the stall this whole change is about.
    #[test]
    fn zero_window_disables_the_relation() {
        let script_text = "keeping my voice clear and steady throughout";
        let spoken = "keeping my voice steady and clear";

        let evaluate = |window: u32| {
            let mut config = AlignmentConfig::default();
            config.displaced_window_atoms = window;
            let mut script = compile(script_text, CompileOptions::default());
            let query = query_from(spoken, &mut script);
            let mut scratch = AlignScratch::new();
            let len = script.len() as u32;
            align(&script, &query, 0, len, &config, &mut scratch).unwrap()
        };

        let off = evaluate(0);
        assert_eq!(off.displaced_matches, 0);
        assert_eq!(off.insertions, 2, "the scramble reads as off-script speech");
        assert_eq!(off.last_solid_match_query_index, Some(2), "explained to 'voice'");

        // Explicit 2: the shipped default is 0 (relation disabled).
        let on = evaluate(2);
        assert_eq!(on.displaced_matches, 2);
        assert_eq!(on.insertions, 0);
        assert_eq!(
            on.last_solid_match_query_index,
            Some(5),
            "the whole scramble is accounted for"
        );
        assert!(on.fidelity > off.fidelity, "{} vs {}", on.fidelity, off.fidelity);
    }

    /// The scratch bitset is reused across alignments of different shapes; a
    /// stale bit would read as a displaced match in a cell that never computed
    /// one. Runs a wide alignment, then a narrow one, in the same scratch.
    #[test]
    fn scratch_reuse_does_not_leak_displaced_bits() {
        let mut scratch = AlignScratch::new();
        let mut config = AlignmentConfig::default();
        config.displaced_window_atoms = TEST_WINDOW;

        let mut wide = compile(
            "keeping my voice clear and steady throughout the whole of this particular take today",
            CompileOptions::default(),
        );
        let wide_query = query_from("keeping my voice steady and clear throughout", &mut wide);
        let len = wide.len() as u32;
        let first = align(&wide, &wide_query, 0, len, &config, &mut scratch).unwrap();
        assert!(first.displaced_matches > 0, "primes the buffer with set bits");

        let mut narrow = compile("alpha bravo charlie delta", CompileOptions::default());
        let narrow_query = query_from("alpha bravo charlie delta", &mut narrow);
        let len = narrow.len() as u32;
        let second = align(&narrow, &narrow_query, 0, len, &config, &mut scratch).unwrap();
        assert_eq!(second.displaced_matches, 0, "verbatim read, no displacement");
        assert_eq!(second.fidelity, 1.0);
    }

    #[test]
    fn empty_query_returns_none() {
        let script = compile("hello world", CompileOptions::default());
        let config = AlignmentConfig::default();
        let mut scratch = AlignScratch::new();
        assert!(align(&script, &[], 0, 2, &config, &mut scratch).is_none());
    }
}
