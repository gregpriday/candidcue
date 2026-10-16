/**
 * The speaking rate every length estimate in the app is made at (spec §21.8:
 * "Default delivery speed is 130 words per minute").
 *
 * One number, because there used to be two. The editor estimated at 150 while
 * the compiler, the Library and the spec all said 130, so a 1,000-word script
 * read "≈ 7 min" in the editor and "≈ 8 min" on its own Library row (#246).
 *
 * It lives here rather than in the compiler so the control window can name it
 * without importing the Markdown pipeline to get one integer. A script's own
 * `settings.wordsPerMinuteEstimate` overrides it; Rust's default for that
 * field (`src-tauri/src/scripts/mod.rs`) is the same number, and
 * `speaking-rate.test.ts` reads the Rust source to keep the two together.
 *
 * Not the teleprompter's fixed speed or the auto-scroll fallback: those are
 * how fast the glass moves, this is how long a script takes to say.
 */
export const DEFAULT_WORDS_PER_MINUTE = 130;
