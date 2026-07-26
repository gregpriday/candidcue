//! The benchmark scenario matrix.
//!
//! Every scenario is a deterministic function of the compiled script, so the
//! Tier-A suite regenerates identically on every run — no fixture drift, no
//! stored event logs needed. Scenario families map one-to-one onto the
//! product behaviours Greg called out:
//!
//! * `exact`, `pauses`, `rate_*` — ordinary reads;
//! * `intro_then_end` — say something at the start, stop, say something at
//!   the end;
//! * `skip_forward`, `far_skip` — jump ahead;
//! * `retake`, `restart` — re-say something said further above;
//! * `adlib_return` — go off script and come back;
//! * `substitutions`, `corrupt15` — the reader (or the recogniser) doesn't
//!   say what's written;
//! * `viewport_start`, `viewport_retake` — the presenter scrolls, the app
//!   reports what's visible, and the prior must help without overruling the
//!   words;
//! * `refrain_second` — identical repeated passage; locking onto the wrong
//!   copy is the catastrophic failure this family exists to catch.

use cc_align::{compile, CompileOptions, CompiledScript};

use crate::plan::{Corruption, PerformancePlan, PlanOp};

pub struct Scenario {
    pub plan: PerformancePlan,
    pub script: CompiledScript,
    /// Words per minute for synthetic gold timing.
    pub wpm: u32,
}

fn frac(n: usize, pct: u32) -> u32 {
    ((n as u64 * pct as u64) / 100) as u32
}

/// Off-script filler material for ad-libs — deliberately everyday words that
/// overlap with common script vocabulary.
fn adlib_words(n: usize) -> Vec<String> {
    const BANK: &[&str] = &[
        "so", "anyway", "i", "was", "thinking", "about", "this", "morning",
        "when", "i", "made", "coffee", "and", "honestly", "the", "weather",
        "outside", "looked", "pretty", "rough", "today", "you", "know",
    ];
    BANK.iter().cycle().take(n).map(|s| s.to_string()).collect()
}

pub fn build_suite(scripts_dir: &std::path::Path) -> anyhow::Result<Vec<Scenario>> {
    let mut suite = Vec::new();
    let load = |stem: &str| -> anyhow::Result<(String, CompiledScript)> {
        let path = scripts_dir.join(format!("{stem}.md"));
        let source = std::fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
        Ok((stem.to_string(), compile(&source, CompileOptions::default())))
    };

    let main_scripts = ["starter", "product-update", "technical", "longform"];

    for stem in main_scripts {
        let (name, script) = load(stem)?;
        let n = script.len();

        // 1. Exact verbatim read.
        suite.push(scenario(
            &name,
            "exact",
            &script,
            150,
            vec![PlanOp::Read {
                from: 0,
                to: n as u32,
            }],
            Corruption::default(),
        ));

        // 2. Read with real pauses mid-sentence and between sections.
        suite.push(scenario(
            &name,
            "pauses",
            &script,
            150,
            vec![
                PlanOp::Read {
                    from: 0,
                    to: frac(n, 30),
                },
                PlanOp::Pause { ms: 2_500 },
                PlanOp::Read {
                    from: frac(n, 30),
                    to: frac(n, 65),
                },
                PlanOp::Pause { ms: 1_200 },
                PlanOp::Read {
                    from: frac(n, 65),
                    to: n as u32,
                },
            ],
            Corruption::default(),
        ));

        // 3. Say something at the beginning, stop, then say the ending.
        suite.push(scenario(
            &name,
            "intro_then_end",
            &script,
            150,
            vec![
                PlanOp::Read {
                    from: 0,
                    to: frac(n, 15),
                },
                PlanOp::Pause { ms: 3_000 },
                PlanOp::Read {
                    from: frac(n, 85),
                    to: n as u32,
                },
            ],
            Corruption::default(),
        ));

        // 4. Forward skip: a paragraph is dropped mid-read.
        suite.push(scenario(
            &name,
            "skip_forward",
            &script,
            150,
            vec![
                PlanOp::Read {
                    from: 0,
                    to: frac(n, 40),
                },
                PlanOp::Read {
                    from: frac(n, 60),
                    to: frac(n, 80),
                },
            ],
            Corruption::default(),
        ));

        // 5. Backward retake: re-say something said further above.
        suite.push(scenario(
            &name,
            "retake",
            &script,
            150,
            vec![
                PlanOp::Read {
                    from: 0,
                    to: frac(n, 50),
                },
                PlanOp::Pause { ms: 1_500 },
                PlanOp::Read {
                    from: frac(n, 35),
                    to: frac(n, 60),
                },
            ],
            Corruption::default(),
        ));

        // 6. Ad-lib and return.
        suite.push(scenario(
            &name,
            "adlib_return",
            &script,
            150,
            vec![
                PlanOp::Read {
                    from: 0,
                    to: frac(n, 30),
                },
                PlanOp::Say {
                    words: adlib_words(15),
                },
                PlanOp::Read {
                    from: frac(n, 30),
                    to: frac(n, 55),
                },
            ],
            Corruption::default(),
        ));

        // 7. Sentence restart: read a few words, stop, start the sentence
        // again (small local backward move).
        let k = frac(n, 45);
        suite.push(scenario(
            &name,
            "restart",
            &script,
            150,
            vec![
                PlanOp::Read {
                    from: 0,
                    to: k + 4,
                },
                PlanOp::Pause { ms: 600 },
                PlanOp::Read {
                    from: k,
                    to: frac(n, 60),
                },
            ],
            Corruption::default(),
        ));

        // 8. Scripted substitutions: reader paraphrases individual words.
        let mut ops = Vec::new();
        let mut at = 0u32;
        let step = (n as u32 / 8).max(6);
        const REPLACEMENTS: &[&str] = &["different", "basically", "similar", "particular"];
        let mut r = 0usize;
        while at + step < n as u32 {
            ops.push(PlanOp::Read {
                from: at,
                to: at + step - 1,
            });
            ops.push(PlanOp::Substitute {
                from: at + step - 1,
                to: at + step,
                say: vec![REPLACEMENTS[r % REPLACEMENTS.len()].to_string()],
            });
            r += 1;
            at += step;
        }
        ops.push(PlanOp::Read {
            from: at,
            to: n as u32,
        });
        suite.push(scenario(&name, "substitutions", &script, 150, ops, Corruption::default()));

        // 9. Heavy ASR corruption (~15% WER target).
        suite.push(scenario(
            &name,
            "corrupt15",
            &script,
            150,
            vec![PlanOp::Read {
                from: 0,
                to: n as u32,
            }],
            Corruption {
                substitute: 100,
                delete: 30,
                insert: 20,
            },
        ));

        // 10. Viewport start: presenter scrolled to the middle, the app
        // reported what's visible, reading starts there.
        suite.push(scenario(
            &name,
            "viewport_start",
            &script,
            150,
            vec![
                PlanOp::Viewport {
                    first: frac(n, 55),
                    last: frac(n, 75),
                },
                PlanOp::Read {
                    from: frac(n, 60),
                    to: frac(n, 85),
                },
            ],
            Corruption::default(),
        ));

        // 11. Viewport-assisted retake: read ahead, scroll back up, re-read.
        suite.push(scenario(
            &name,
            "viewport_retake",
            &script,
            150,
            vec![
                PlanOp::Read {
                    from: 0,
                    to: frac(n, 35),
                },
                PlanOp::Pause { ms: 2_000 },
                PlanOp::Viewport {
                    first: frac(n, 8),
                    last: frac(n, 22),
                },
                PlanOp::Read {
                    from: frac(n, 10),
                    to: frac(n, 25),
                },
            ],
            Corruption::default(),
        ));

        // 12. Rate extremes.
        suite.push(scenario(
            &name,
            "rate_fast",
            &script,
            220,
            vec![PlanOp::Read {
                from: 0,
                to: frac(n, 60),
            }],
            Corruption::default(),
        ));
        suite.push(scenario(
            &name,
            "rate_slow",
            &script,
            90,
            vec![PlanOp::Read {
                from: 0,
                to: frac(n, 40),
            }],
            Corruption::default(),
        ));
    }

    // Refrain script: start reading at the SECOND copy of the repeated line.
    {
        let (name, script) = load("refrain")?;
        let n = script.len();
        // The second refrain occurrence sits at ~40% in the fixture.
        suite.push(scenario(
            &name,
            "refrain_second",
            &script,
            150,
            vec![PlanOp::Read {
                from: frac(n, 38),
                to: frac(n, 70),
            }],
            Corruption::default(),
        ));
        // And an exact full read: three identical refrains must not cause a
        // single false jump while reading straight through.
        suite.push(scenario(
            &name,
            "exact",
            &script,
            150,
            vec![PlanOp::Read {
                from: 0,
                to: n as u32,
            }],
            Corruption::default(),
        ));
    }

    // Names script: unusually-spelled proper nouns. Two questions: does an
    // ordinary read survive name-heavy text, and is a section of rare names
    // ALONE enough evidence to relocate into cold?
    {
        let (name, script) = load("names")?;
        let n = script.len();
        suite.push(scenario(
            &name,
            "exact",
            &script,
            150,
            vec![PlanOp::Read {
                from: 0,
                to: n as u32,
            }],
            Corruption::default(),
        ));
        // Cold jump straight into the name-dominated section (~45%), with
        // ASR-style mangling — recognisers rarely spell these right, so the
        // anchors must work through fuzzy matches.
        suite.push(scenario(
            &name,
            "names_cold_jump",
            &script,
            150,
            vec![
                PlanOp::Read { from: 0, to: 14 },
                PlanOp::Pause { ms: 3_000 },
                PlanOp::Read {
                    from: frac(n, 45),
                    to: frac(n, 75),
                },
            ],
            Corruption {
                substitute: 60,
                delete: 10,
                insert: 10,
            },
        ));
    }

    // Huge script: far skip (hundreds of atoms) and the scale window.
    {
        let (name, script) = load("huge")?;
        let n = script.len();
        suite.push(scenario(
            &name,
            "far_skip",
            &script,
            160,
            vec![
                PlanOp::Read {
                    from: 0,
                    to: 60,
                },
                PlanOp::Pause { ms: 2_000 },
                PlanOp::Read {
                    from: frac(n, 80),
                    to: frac(n, 80) + 80,
                },
            ],
            Corruption::default(),
        ));
        suite.push(scenario(
            &name,
            "scale_window",
            &script,
            160,
            vec![PlanOp::Read {
                from: frac(n, 50),
                to: frac(n, 50) + 150,
            }],
            Corruption::default(),
        ));
    }

    // Small-script scale reference: the same 150-atom window shape on a
    // ~300-atom script. The runtime ratio huge/small is the scale benchmark.
    {
        let (name, script) = load("product-update")?;
        let n = script.len();
        suite.push(scenario(
            &name,
            "scale_window",
            &script,
            160,
            vec![PlanOp::Read {
                from: frac(n, 30),
                to: (frac(n, 30) + 150).min(n as u32),
            }],
            Corruption::default(),
        ));
    }

    Ok(suite)
}

/// The Tier-B live set: which (script, scenario) pairs get real TTS audio
/// streamed through the real recogniser. Engines rotate per run, giving each
/// engine coverage across scenario families without a full cross product.
pub fn tier_b_selection() -> Vec<(&'static str, &'static str)> {
    vec![
        ("starter", "exact"),
        ("starter", "skip_forward"),
        ("starter", "adlib_return"),
        ("starter", "retake"),
        ("product-update", "exact"),
        ("product-update", "intro_then_end"),
        ("product-update", "viewport_start"),
        ("technical", "exact"),
        ("technical", "pauses"),
        ("refrain", "exact"),
        ("refrain", "refrain_second"),
        ("names", "exact"),
        ("names", "names_cold_jump"),
        ("longform", "intro_then_end"),
    ]
}

fn scenario(
    script_name: &str,
    scenario: &str,
    script: &CompiledScript,
    wpm: u32,
    ops: Vec<PlanOp>,
    corruption: Corruption,
) -> Scenario {
    Scenario {
        plan: PerformancePlan {
            name: format!("{script_name}__{scenario}"),
            script: script_name.to_string(),
            scenario: scenario.to_string(),
            seed: 0xC1DC0E ^ (script_name.len() as u64) ^ ((scenario.len() as u64) << 8),
            ops,
            corruption,
        },
        script: script.clone(),
        wpm,
    }
}
