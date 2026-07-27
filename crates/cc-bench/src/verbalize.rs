//! How a recogniser writes down what it just heard.
//!
//! Every other Tier-A family says the script back to the engine in the script's
//! own words, so the two sides agree by construction and the benchmark can only
//! measure *tracking*. That is the wrong shape for the failure Greg hit: he
//! says "twenty-seven" and the provider writes `27`; he says "one hundred and
//! forty-three" and it writes `143`; he says "half past three" and it writes
//! `3:30`. Nothing was misheard. The two sides simply chose different spellings
//! for the same sound, and if normalisation does not bring them back together
//! the display stops on a word the reader has already passed.
//!
//! This module is a MODEL of that behaviour: a deterministic rewriter that
//! takes a run of compiled script atoms and returns the alternative rendering a
//! recogniser plausibly emits for it. It is not ground truth — Tier B is, and
//! `figures` and `brands` are in the live selection precisely so the real
//! provider gets a vote. What this buys is a version of the failure that runs
//! in milliseconds, in CI, with no network and no bill.
//!
//! The renderings are chosen to be *fair*: each one is something a real
//! recogniser does emit, and several of them already normalise correctly today
//! (spelled cardinals, `nineteen ninety eight`, `three point two`). Those are
//! the controls. The ones that do not are the benchmark.
//!
//! Two things this model does NOT claim, and a reader of the numbers should
//! hold on to both:
//!
//! * **The frequency mix is chosen, not measured.** Every eligible run is
//!   re-spelled, once, consistently. A real provider re-spells some and not
//!   others, and changes its mind between partials of the same utterance —
//!   `one hundred twenty` then `120` then the words again, all inside one item
//!   (see `bench/runs/figures__exact__qwen/events.jsonl`). Revision churn is
//!   the largest unmodelled behaviour here and it is probably harder than any
//!   stable rendering, because the ledger tracks stability by canonical id.
//! * **The shapes are the ones someone thought of.** Missing: 24-hour and
//!   `3:05` times, `07/28/2026`, ranges, scores, fractions, phone and account
//!   numbers, leading zeros, currency codes, `2.4M`, `°C`, `km/h`, initialisms
//!   written with spaces, and a name the provider both splits AND respells.
//!   Absence from this list is absence of evidence.

use std::collections::HashMap;

use cc_align::script::CompiledScript;

/// One alternative rendering: `span` script atoms are spoken as `words`.
#[derive(Debug, Clone)]
pub struct Rendering {
    pub span: u32,
    pub words: Vec<String>,
}

/// Unit abbreviations a script writes compactly and a recogniser spells out.
/// Deliberately short — a wrong expansion invents a mismatch that never
/// happened, which would flatter the engine rather than test it.
const UNITS: &[(&str, &str)] = &[
    ("khz", "kilohertz"),
    ("hz", "hertz"),
    ("ghz", "gigahertz"),
    ("ms", "milliseconds"),
    ("kb", "kilobytes"),
    ("mb", "megabytes"),
    ("gb", "gigabytes"),
    ("tb", "terabytes"),
    ("km", "kilometres"),
    ("kg", "kilograms"),
];

const SCALES: &[&str] = &["thousand", "million", "billion"];
const CURRENCIES: &[(&str, &str)] = &[("dollars", "$"), ("pounds", "£"), ("euros", "€")];
const SMALL_ORDINALS: &[&str] = &[
    "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
];

pub struct Verbalizer {
    /// Canonical compound surface → the words a recogniser splits it into.
    compounds: HashMap<String, Vec<String>>,
}

impl Verbalizer {
    /// Learn the compound names from the fixture's own Markdown.
    ///
    /// A brand written `RustLight` is one atom to the compiler and two words to
    /// the recogniser, and the split point is visible in the source: it is the
    /// capital in the middle. Deriving it from the fixture keeps the model
    /// honest — there is no hand-written list to quietly tune.
    pub fn from_source(source: &str) -> Self {
        let mut compounds: HashMap<String, Vec<String>> = HashMap::new();
        for raw in source.split_whitespace() {
            let word: String = raw.chars().filter(|c| c.is_alphanumeric()).collect();
            let parts = split_camel(&word);
            if parts.len() >= 2 {
                compounds.insert(word.to_lowercase(), parts);
            }
        }
        Self { compounds }
    }

    pub fn none() -> Self {
        Self {
            compounds: HashMap::new(),
        }
    }

    /// The recogniser's version of the atoms starting at `at`, if it differs
    /// from what the script wrote.
    pub fn render(&self, script: &CompiledScript, at: usize) -> Option<Rendering> {
        let surface = |i: usize| -> Option<&str> {
            script.atoms.get(i).map(|a| a.surface.as_str())
        };
        let head = surface(at)?;
        let next = surface(at + 1);

        // A brand the recogniser hears as two words.
        if let Some(parts) = self.compounds.get(head) {
            return Some(Rendering {
                span: 1,
                words: parts.clone(),
            });
        }

        // `2.4 million dollars` → `$2.4 million`: the currency moves to the
        // front of the amount and the scale word follows it.
        //
        // Alternated with the spoken order, which is what the live captures
        // actually contained. The symbol form is a shape providers do produce,
        // but this model has no measured frequency for it and must not imply
        // one by using it every time.
        if let (Some(scale), Some(unit)) = (next, surface(at + 2)) {
            if is_number(head) && SCALES.contains(&scale) {
                if let Some((_, symbol)) = CURRENCIES.iter().find(|(name, _)| *name == unit) {
                    let words = if at % 2 == 0 {
                        vec![format!("{symbol}{head}"), scale.to_string()]
                    } else {
                        let mut spoken = spell_decimal(head)?;
                        spoken.push(scale.to_string());
                        spoken.push(unit.to_string());
                        spoken
                    };
                    return Some(Rendering { span: 3, words });
                }
            }
        }

        if let Some(next) = next {
            // `24 khz` ↔ `24 kilohertz`. Matched in BOTH directions on
            // purpose: the compiled atom for a unit is whatever the engine's
            // normaliser currently produces, so a rule keyed on one spelling
            // stops firing the moment the engine changes which spelling that
            // is — and then the two sides of a before/after are not running
            // the same benchmark input.
            if is_integer(head) {
                if let Some((abbrev, spelled)) = UNITS
                    .iter()
                    .find(|(abbrev, spelled)| *abbrev == next || *spelled == next)
                {
                    let other = if next == *abbrev { spelled } else { abbrev };
                    return Some(Rendering {
                        span: 2,
                        words: vec![head.to_string(), (*other).to_string()],
                    });
                }
            }
            // `40 percent` ↔ `40%`. Alternated: the live provider writes both,
            // and a model that only ever produced the symbol would be claiming
            // a frequency nobody measured.
            if is_integer(head) && next == "percent" {
                let words = if at % 2 == 0 {
                    vec![format!("{head}%")]
                } else {
                    let mut spelled = spell(head.parse().ok()?);
                    spelled.push("percent".into());
                    spelled
                };
                return Some(Rendering { span: 2, words });
            }
            // `three thirty` → `3:30`.
            if let (Ok(hour), Ok(minute)) = (head.parse::<u32>(), next.parse::<u32>()) {
                if (1..=12).contains(&hour)
                    && head.len() <= 2
                    && next.len() == 2
                    && minute <= 59
                    && is_integer(head)
                    && is_integer(next)
                {
                    return Some(Rendering {
                        span: 2,
                        words: vec![format!("{hour}:{next}")],
                    });
                }
            }
            // `twenty eighth` → `28`. The script's own canonical form for a
            // compound ordinal is the two atoms `20 eighth`, so a provider that
            // writes the bare cardinal lands nowhere near it.
            if let Ok(tens) = head.parse::<u32>() {
                if is_integer(head) && (20..=90).contains(&tens) && tens % 10 == 0 {
                    if let Some(unit) = SMALL_ORDINALS.iter().position(|w| *w == next) {
                        return Some(Rendering {
                            span: 2,
                            words: vec![(tens + unit as u32 + 1).to_string()],
                        });
                    }
                }
            }
        }

        // `1.2` → `one point two`.
        if let Some(words) = spell_decimal(head) {
            return Some(Rendering { span: 1, words });
        }

        // Bare integers: spell them the way they are said.
        if is_integer(head) {
            let n: u64 = head.parse().ok()?;
            let words = spell_as_spoken(n, at);
            if !words.is_empty() {
                return Some(Rendering { span: 1, words });
            }
        }

        None
    }
}

/// `1.2` → `one point two`. None when the atom is not a decimal.
fn spell_decimal(atom: &str) -> Option<Vec<String>> {
    let (whole, frac) = atom.split_once('.')?;
    if whole.is_empty()
        || frac.is_empty()
        || !whole.chars().all(|c| c.is_ascii_digit())
        || !frac.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let mut words = spell(whole.parse().ok()?);
    words.push("point".into());
    for digit in frac.chars() {
        words.push(DIGITS[digit as usize - '0' as usize].into());
    }
    Some(words)
}

fn is_integer(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

fn is_number(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_digit() || c == '.')
        && s.chars().any(|c| c.is_ascii_digit())
}

/// `RustLight` → `["rust", "light"]`. Runs of capitals stay together so
/// `AT` and `RTX` are not shredded into letters.
fn split_camel(word: &str) -> Vec<String> {
    if word.len() < 4 || !word.chars().all(|c| c.is_ascii_alphabetic()) {
        return Vec::new();
    }
    let chars: Vec<char> = word.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    for (i, c) in chars.iter().enumerate() {
        let boundary = i > 0
            && c.is_ascii_uppercase()
            && chars[i - 1].is_ascii_lowercase();
        if boundary && current.len() >= 2 {
            parts.push(std::mem::take(&mut current));
        }
        current.push(c.to_ascii_lowercase());
    }
    if !current.is_empty() {
        parts.push(current);
    }
    // A single trailing letter ("MacOS" → "mac"+"os" is fine, "Xy" is not).
    if parts.len() < 2 || parts.iter().any(|p| p.len() < 2) {
        return Vec::new();
    }
    parts
}

const DIGITS: &[&str] = &[
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
];
const TEENS: &[&str] = &[
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen",
];
const TENS: &[&str] = &[
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

/// Plain English for a number, the way it is read aloud.
pub fn spell(n: u64) -> Vec<String> {
    let mut out = Vec::new();
    spell_into(n, &mut out);
    out
}

fn spell_into(n: u64, out: &mut Vec<String>) {
    match n {
        0..=9 => out.push(DIGITS[n as usize].into()),
        10..=19 => out.push(TEENS[(n - 10) as usize].into()),
        20..=99 => {
            out.push(TENS[(n / 10) as usize].into());
            if n % 10 != 0 {
                out.push(DIGITS[(n % 10) as usize].into());
            }
        }
        100..=999 => {
            spell_into(n / 100, out);
            out.push("hundred".into());
            if n % 100 != 0 {
                out.push("and".into());
                spell_into(n % 100, out);
            }
        }
        _ => {
            let (scale, name) = if n >= 1_000_000_000 {
                (1_000_000_000, "billion")
            } else if n >= 1_000_000 {
                (1_000_000, "million")
            } else {
                (1_000, "thousand")
            };
            spell_into(n / scale, out);
            out.push(name.into());
            if n % scale != 0 {
                spell_into(n % scale, out);
            }
        }
    }
}

/// The same number as an independent implementation says it.
///
/// `num2words` is not here for coverage — the hand-written `spell` below
/// already covers these — but for provenance. Half the model's spoken forms
/// now come from a crate that has never seen this engine, which is the only
/// honest answer to the obvious objection: that the person who wrote the model
/// then fixed the engine to pass it. It also disagrees usefully. It says a year
/// as "twenty nineteen" where the hand-written branch says "two thousand and
/// nineteen", and both are things people say, so alternating covers two real
/// shapes where either alone covers one.
fn spell_independently(n: u64, year: bool) -> Option<Vec<String>> {
    let value = i64::try_from(n).ok()?;
    let builder = num2words::Num2Words::new(value);
    let words = if year { builder.year() } else { builder }.to_words().ok()?;
    Some(
        words
            .replace('-', " ")
            .split_whitespace()
            .map(|w| w.to_string())
            .collect(),
    )
}

/// The spoken form for a bare integer, choosing among the ways people actually
/// say it. Deterministic in `at` so the suite stays byte-for-byte reproducible.
fn spell_as_spoken(n: u64, at: usize) -> Vec<String> {
    // Years get read as years, and the two awkward shapes are the ones worth
    // testing: `two thousand and nineteen` and `nineteen oh five`.
    if (1000..=2999).contains(&n) {
        if at % 2 == 1 {
            if let Some(words) = spell_independently(n, true) {
                return words;
            }
        }
        let (century, tail) = (n / 100, n % 100);
        if century == 20 {
            let mut words = vec!["two".into(), "thousand".into()];
            if tail != 0 {
                words.push("and".into());
                words.extend(spell(tail));
            }
            return words;
        }
        if tail == 0 {
            return spell(n);
        }
        let mut words = spell(century);
        if tail < 10 {
            words.push("oh".into());
        }
        words.extend(spell(tail));
        return words;
    }
    // `143` is said both ways; alternating by position exercises both without
    // making the suite depend on a coin flip. Only the 100s — "a" can stand in
    // for "one hundred", never for "two hundred".
    if (101..=199).contains(&n) && at % 2 == 0 {
        let mut words = vec!["a".into()];
        words.extend(spell(n).into_iter().skip(1));
        return words;
    }
    if at % 2 == 1 {
        if let Some(words) = spell_independently(n, false) {
            return words;
        }
    }
    spell(n)
}

/// Build the substitution ops for a whole script: every run the verbalizer has
/// an opinion about becomes a `Substitute`, everything else stays a `Read`.
pub fn asr_ops(
    script: &CompiledScript,
    verbalizer: &Verbalizer,
    from: u32,
    to: u32,
) -> Vec<crate::plan::PlanOp> {
    use crate::plan::PlanOp;
    let mut ops = Vec::new();
    let mut read_from = from;
    let mut at = from;
    while at < to {
        match verbalizer.render(script, at as usize) {
            Some(rendering) if at + rendering.span <= to => {
                if at > read_from {
                    ops.push(PlanOp::Read {
                        from: read_from,
                        to: at,
                    });
                }
                ops.push(PlanOp::Substitute {
                    from: at,
                    to: at + rendering.span,
                    say: rendering.words,
                    respelled: true,
                });
                at += rendering.span;
                read_from = at;
            }
            _ => at += 1,
        }
    }
    if to > read_from {
        ops.push(PlanOp::Read {
            from: read_from,
            to,
        });
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_align::{compile, CompileOptions};

    fn atoms(text: &str) -> CompiledScript {
        compile(text, CompileOptions::default())
    }

    #[test]
    fn spells_cardinals_the_way_they_are_said() {
        assert_eq!(spell(27), vec!["twenty", "seven"]);
        assert_eq!(spell(143), vec!["one", "hundred", "and", "forty", "three"]);
        assert_eq!(spell(27_000), vec!["twenty", "seven", "thousand"]);
        assert_eq!(
            spell(19_400),
            vec!["nineteen", "thousand", "four", "hundred"]
        );
    }

    #[test]
    fn years_take_their_spoken_shapes() {
        assert_eq!(spell_as_spoken(1998, 0), vec!["nineteen", "ninety", "eight"]);
        assert_eq!(spell_as_spoken(1905, 0), vec!["nineteen", "oh", "five"]);
        assert_eq!(
            spell_as_spoken(2019, 0),
            vec!["two", "thousand", "and", "nineteen"]
        );
    }

    #[test]
    fn compound_brands_come_from_the_fixture_itself() {
        let v = Verbalizer::from_source("We ship with RustLight Games and SoundCloud.");
        let script = atoms("We ship with RustLight Games.");
        let at = script
            .atoms
            .iter()
            .position(|a| a.surface == "rustlight")
            .expect("rustlight atom");
        let rendering = v.render(&script, at).expect("a split rendering");
        assert_eq!(rendering.span, 1);
        assert_eq!(rendering.words, vec!["rust", "light"]);
    }

    #[test]
    fn acronyms_are_left_alone() {
        // `AT` and `RTX` have no lower-to-upper boundary; shredding them would
        // invent a failure the provider never produces.
        assert!(split_camel("ATT").is_empty());
        assert!(split_camel("RTX").is_empty());
    }

    #[test]
    fn a_time_becomes_a_clock_face() {
        let script = atoms("The all-hands is at three thirty in the afternoon.");
        let at = script
            .atoms
            .iter()
            .position(|a| a.surface == "3")
            .expect("hour atom");
        let rendering = Verbalizer::none().render(&script, at).expect("a time");
        assert_eq!(rendering.span, 2);
        assert_eq!(rendering.words, vec!["3:30"]);
    }

    #[test]
    fn the_currency_moves_to_the_front_of_the_amount() {
        let script = atoms("Revenue came in at 2.4 million dollars this year.");
        let at = script
            .atoms
            .iter()
            .position(|a| a.surface == "2.4")
            .expect("amount atom");
        let rendering = Verbalizer::none().render(&script, at).expect("an amount");
        assert_eq!(rendering.span, 3);
        assert_eq!(rendering.words, vec!["$2.4", "million"]);
    }

    /// The ops must tile the range exactly — a gap would silently drop script
    /// atoms from the performance and quietly flatter every metric.
    #[test]
    fn ops_tile_the_whole_range() {
        use crate::plan::PlanOp;
        let script = atoms(
            "We closed with twenty-seven thousand accounts at three thirty on the twenty-eighth of July.",
        );
        let n = script.len() as u32;
        let ops = asr_ops(&script, &Verbalizer::none(), 0, n);
        let mut at = 0u32;
        for op in &ops {
            let (from, to) = match op {
                PlanOp::Read { from, to } => (*from, *to),
                PlanOp::Substitute { from, to, .. } => (*from, *to),
                _ => panic!("unexpected op"),
            };
            assert_eq!(from, at, "ops must be contiguous");
            at = to;
        }
        assert_eq!(at, n, "ops must cover the whole range");
    }
}
