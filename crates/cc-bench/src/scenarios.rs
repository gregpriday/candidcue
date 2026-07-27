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
//!   copy is the catastrophic failure this family exists to catch;
//! * `asr_forms*` — the script and the recogniser spell the same sound
//!   differently (`twenty-seven` / `27`, `three thirty` / `3:30`,
//!   `RustLight` / `Rust Light`). Nothing is misheard; only the spelling
//!   disagrees. See `verbalize.rs`.

use cc_align::{compile, CompileOptions, CompiledScript};

use crate::tts::TtsEngine;

use crate::plan::{Corruption, PerformancePlan, PlanOp};
use crate::verbalize::{asr_ops, Verbalizer};

pub struct Scenario {
    pub plan: PerformancePlan,
    pub script: CompiledScript,
    /// Words per minute for synthetic gold timing.
    pub wpm: u32,
}

fn frac(n: usize, pct: u32) -> u32 {
    ((n as u64 * pct as u64) / 100) as u32
}

/// Atom indexes where a new paragraph starts (0 excluded).
///
/// Paragraph ends are where readers actually stop — to breathe, to check the
/// camera, to decide whether the next bit still lands — so they are also where
/// a display that predicts forward does its most visible damage, leaking into
/// a paragraph that has not been spoken at all.
fn paragraph_starts(script: &CompiledScript) -> Vec<u32> {
    (1..script.len())
        .filter(|&i| script.atoms[i].para != script.atoms[i - 1].para)
        .map(|i| i as u32)
        .collect()
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

        // 2b. Long mid-read pauses: 1s / 2s / 3s. Presenters pause — to
        // breathe, to think, for emphasis — and the display must NOT run
        // ahead while they do (the pause_overshoot benchmark).
        suite.push(scenario(
            &name,
            "long_pauses",
            &script,
            150,
            vec![
                PlanOp::Read { from: 0, to: frac(n, 20) },
                PlanOp::Pause { ms: 1_000 },
                PlanOp::Read { from: frac(n, 20), to: frac(n, 35) },
                PlanOp::Pause { ms: 2_000 },
                PlanOp::Read { from: frac(n, 35), to: frac(n, 50) },
                PlanOp::Pause { ms: 3_000 },
                PlanOp::Read { from: frac(n, 50), to: frac(n, 65) },
            ],
            Corruption::default(),
        ));

        // 2c. Pauses AT paragraph boundaries: read a paragraph, stop at its
        // full stop, then carry on. This is the shape of an ordinary take,
        // and the one where a forward-predicting display crosses into text
        // the reader has not begun.
        let starts = paragraph_starts(&script);
        if starts.len() >= 4 {
            let pick = |pct: usize| starts[starts.len() * pct / 100];
            let (b0, b1, b2) = (pick(25), pick(50), pick(70));
            suite.push(scenario(
                &name,
                "para_pauses",
                &script,
                150,
                vec![
                    PlanOp::Read { from: 0, to: b0 },
                    PlanOp::Pause { ms: 2_000 },
                    PlanOp::Read { from: b0, to: b1 },
                    PlanOp::Pause { ms: 3_000 },
                    PlanOp::Read { from: b1, to: b2 },
                    PlanOp::Pause { ms: 1_500 },
                    PlanOp::Read { from: b2, to: n as u32 },
                ],
                Corruption::default(),
            ));
        }

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

        // 8b. Word repetitions: every ~12th word said twice ("the— the").
        // Robust-alignment research names repetition handling as the single
        // largest recall win; this family guards it.
        let mut ops = Vec::new();
        let mut at = 0u32;
        let step = 12u32;
        while at + step < n as u32 {
            ops.push(PlanOp::Read {
                from: at,
                to: at + step,
            });
            let w = script.atoms[(at + step - 1) as usize].surface.clone();
            ops.push(PlanOp::Say { words: vec![w] });
            at += step;
        }
        ops.push(PlanOp::Read {
            from: at,
            to: n as u32,
        });
        suite.push(scenario(&name, "word_repeats", &script, 150, ops, Corruption::default()));

        // 8c. Phrase repetitions: every ~40 atoms the presenter re-says the
        // last 4-word phrase ("we should— we should build").
        let mut ops = Vec::new();
        let mut at = 0u32;
        let step = 40u32;
        while at + step < n as u32 {
            ops.push(PlanOp::Read {
                from: at,
                to: at + step,
            });
            ops.push(PlanOp::Read {
                from: at + step - 4,
                to: at + step,
            });
            at += step;
        }
        ops.push(PlanOp::Read {
            from: at,
            to: n as u32,
        });
        suite.push(scenario(&name, "phrase_repeats", &script, 150, ops, Corruption::default()));

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

    // Spoken-form scripts: the two sides of the page disagree about how to
    // SPELL what was said, without disagreeing about what was said.
    //
    // `exact` is the control — the performance says the script's own canonical
    // words back, so any error is tracking, not spelling. The `asr_*` families
    // run the same reading through the verbalizer, so the transcript carries
    // `$2.4 million` where the script wrote `2.4 million dollars`, `3:30` where
    // it wrote `three thirty`, `Rust Light` where it wrote `RustLight`. The
    // delta between `exact` and `asr_forms` on the same script is the whole
    // benchmark: it is the cost of the spelling disagreement alone.
    for stem in ["figures", "brands"] {
        let (name, script) = load(stem)?;
        let n = script.len();
        let source = std::fs::read_to_string(scripts_dir.join(format!("{stem}.md")))?;
        let verbalizer = Verbalizer::from_source(&source);

        suite.push(scenario(
            &name,
            "exact",
            &script,
            150,
            vec![PlanOp::Read { from: 0, to: n as u32 }],
            Corruption::default(),
        ));

        // A plain read with pauses — the second control, and the shape that
        // gets real audio in Tier B.
        suite.push(scenario(
            &name,
            "pauses",
            &script,
            150,
            vec![
                PlanOp::Read { from: 0, to: frac(n, 30) },
                PlanOp::Pause { ms: 2_500 },
                PlanOp::Read { from: frac(n, 30), to: frac(n, 65) },
                PlanOp::Pause { ms: 1_200 },
                PlanOp::Read { from: frac(n, 65), to: n as u32 },
            ],
            Corruption::default(),
        ));

        suite.push(scenario(
            &name,
            "asr_forms",
            &script,
            150,
            asr_ops(&script, &verbalizer, 0, n as u32),
            Corruption::default(),
        ));

        // The same disagreement across the pauses a real take has. A figure is
        // often the last thing said before a breath, which is exactly when a
        // display that failed to match it sits still and waits.
        let starts = paragraph_starts(&script);
        if starts.len() >= 4 {
            let pick = |pct: usize| starts[starts.len() * pct / 100];
            let (b0, b1) = (pick(30), pick(60));
            let mut ops = asr_ops(&script, &verbalizer, 0, b0);
            ops.push(PlanOp::Pause { ms: 2_000 });
            ops.extend(asr_ops(&script, &verbalizer, b0, b1));
            ops.push(PlanOp::Pause { ms: 3_000 });
            ops.extend(asr_ops(&script, &verbalizer, b1, n as u32));
            suite.push(scenario(&name, "asr_forms_pauses", &script, 150, ops, Corruption::default()));
        }

        // Jump into the middle: fourteen atoms, a pause, then a passage whose
        // only landmarks are figures or names the recogniser respelled. Named
        // `skip`, not `cold` — it reads and locks first, so it measures warm
        // forward relocation, which is a different thing from a cold start.
        let mut ops = asr_ops(&script, &verbalizer, 0, 14);
        ops.push(PlanOp::Pause { ms: 3_000 });
        ops.extend(asr_ops(&script, &verbalizer, frac(n, 45), frac(n, 75)));
        suite.push(scenario(&name, "asr_forms_skip", &script, 150, ops, Corruption::default()));

        // Spelling disagreement AND ordinary recogniser noise on top. A name
        // the provider splits in two is also a name it half-mishears.
        suite.push(scenario(
            &name,
            "asr_forms_corrupt",
            &script,
            150,
            asr_ops(&script, &verbalizer, 0, n as u32),
            Corruption {
                substitute: 100,
                delete: 30,
                insert: 20,
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

/// One entry in the Tier-B live set: a scenario, the TTS engine that speaks it,
/// and the voice index that names the speaker and keys the clip cache.
pub struct LiveRun {
    pub script: &'static str,
    pub scenario: &'static str,
    pub engine: TtsEngine,
    pub voice_index: usize,
}

/// The Tier-B live set: which scenarios get real TTS audio streamed through the
/// real recogniser. Three engines double as the spec's held-out-voice
/// requirement.
///
/// Engine and voice are PINNED here rather than derived from list position.
/// They used to be `index % 3`, which meant a run's identity depended on how
/// many entries sat above it: inserting `starter/long_pauses` in the middle
/// silently re-voiced every entry below, so `refrain/exact` — captured and
/// frozen as gemini — was suddenly gemini no longer. The next synthesis run
/// would have re-rendered and re-captured five already-frozen fixtures under
/// new names, at full TTS and streaming cost, for no new evidence. The mapping
/// below is the one `bench/runs` was actually captured with.
pub fn tier_b_selection() -> Vec<LiveRun> {
    use TtsEngine::{Gemini, Qwen, Xai};
    let run = |script, scenario, engine, voice_index| LiveRun {
        script,
        scenario,
        engine,
        voice_index,
    };
    vec![
        run("starter", "exact", Gemini, 0),
        run("starter", "skip_forward", Qwen, 1),
        run("starter", "adlib_return", Xai, 2),
        run("starter", "retake", Gemini, 3),
        run("product-update", "exact", Qwen, 4),
        run("product-update", "intro_then_end", Xai, 5),
        run("product-update", "viewport_start", Gemini, 6),
        run("technical", "exact", Qwen, 7),
        run("technical", "pauses", Xai, 8),
        run("refrain", "exact", Gemini, 9),
        run("refrain", "refrain_second", Qwen, 10),
        run("names", "exact", Xai, 11),
        run("names", "names_cold_jump", Gemini, 12),
        run("longform", "intro_then_end", Qwen, 13),
        // Added later and never captured; pinned to the identity the old
        // rotation had already given it, so the audio rendered under it stays
        // valid rather than being re-billed for a new voice number.
        run("starter", "long_pauses", Gemini, 9),
        // The spoken-form scripts, one per engine.
        //
        // Plain reads, deliberately. The whole point of putting these two in
        // front of the real recogniser is to find out how IT spells what it
        // hears; feeding it a synthesised guess at its own output would only
        // measure the guess.
        run("figures", "exact", Qwen, 15),
        run("brands", "exact", Xai, 16),
        run("figures", "pauses", Gemini, 17),
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
