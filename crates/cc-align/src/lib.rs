//! # cc-align — CandidCue speech-to-script alignment core
//!
//! A deterministic, allocation-conscious engine that follows a known Markdown
//! script from streaming speech-recognition output. Pure by construction: no
//! I/O, no wall clocks, no randomness — time enters as explicit audio-clock
//! milliseconds and every decision is a function of (compiled script, ordered
//! transcript events, configuration). The same crate runs live in the app and
//! offline in the benchmark harness, which is what makes the benchmark
//! numbers mean something.
//!
//! Pipeline:
//!
//! ```text
//! Markdown ──compile──▶ CompiledScript (atoms, weights, anchor indexes)
//! STT frames ──Ledger──▶ alignment tail (stability-classed atoms)
//! tail × candidate regions ──align──▶ Evidence (fidelity, coverage, …)
//! Evidence ──Engine policy──▶ Snapshot (confirmed / observed / display)
//! ```
//!
//! See `tracker::Engine` for the entry point.

pub mod align;
pub mod config;
pub mod language;
pub mod ledger;
pub mod normalize;
pub mod project;
pub mod script;
pub mod tracker;
pub mod vocab;

pub use config::AlignmentConfig;
pub use language::{
    AlignmentLanguage, CurrencyOrder, LanguageRule, NormalizationProfile, PhoneticPolicy,
    RuleDisposition,
};
pub use project::{decision_name, project_to_tokens, state_name, TokenSnapshot};
pub use script::{
    compile, compile_tokens, compile_tokens_in, CompileOptions, CompiledScript, QueryWord,
    TokenInput, TranscriptWordTime,
};
pub use tracker::{DecisionCode, Engine, SessionEvent, Snapshot, TrackingState};
pub use vocab::{extract_from_markdown, extract_terms, spoken_surfaces, VocabLimits, VocabToken};
