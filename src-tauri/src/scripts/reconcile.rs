//! Startup reconciliation (spec §47.6): repair drift between the managed
//! filesystem and the database after unclean exits, preserving evidence in a
//! recovery report instead of deleting uncertain data.

use std::fs;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use sqlx::SqlitePool;

use crate::backup::salvage::{self, SalvagedScript};
use crate::errors::AppError;
use crate::util::{atomic_write, now_iso};

use super::repo;
use super::words::{spoken_text, SpokenTextOptions};
use super::{DataPaths, ScriptId};

const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub ran_at: String,
    pub integrity_ok: bool,
    pub temp_files_removed: u32,
    pub orphan_files_recovered: Vec<String>,
    /// Of those, how many got back the name the database had for them before
    /// a rebuild, rather than one taken from their own text (#252).
    pub titles_restored: u32,
    /// Saved versions and images of the recovered scripts indexed again from
    /// the files they were always in.
    pub revisions_recovered: u32,
    pub assets_recovered: u32,
    pub missing_files_restored: Vec<String>,
    pub missing_files_unrecoverable: Vec<String>,
    /// Rows whose canonical file did not match the recorded hash — the
    /// "file rename succeeded, database commit did not" crash state.
    pub hash_mismatches_repaired: Vec<String>,
    pub trash_purged: u32,
    pub notes: Vec<String>,
}

impl RecoveryReport {
    pub fn has_findings(&self) -> bool {
        !self.integrity_ok
            || self.temp_files_removed > 0
            || !self.orphan_files_recovered.is_empty()
            || !self.missing_files_restored.is_empty()
            || !self.missing_files_unrecoverable.is_empty()
            || !self.hash_mismatches_repaired.is_empty()
    }
}

pub async fn run_startup_reconciliation(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &super::ScriptLocks,
) -> Result<RecoveryReport, AppError> {
    let mut report = RecoveryReport {
        ran_at: now_iso(),
        integrity_ok: true,
        ..Default::default()
    };

    // 1. Quick database integrity check.
    let check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(pool)
        .await
        .unwrap_or_else(|_| "failed".into());
    report.integrity_ok = check == "ok";
    if !report.integrity_ok {
        // Fail closed (spec §47.6, §48.5): a database that failed its
        // integrity check must not be written to. Every step below mutates
        // something — deleting temp files, inserting recovered rows, purging
        // trash — so none of them may run. The evidence is preserved in the
        // report and the caller surfaces it to the user.
        report.notes.push(format!("quick_check: {check}"));
        report.notes.push(
            "database integrity check failed; reconciliation made no changes".to_string(),
        );
        tracing::error!(check = %check, "database integrity check failed; refusing to reconcile");
        let _ = write_report(paths, &report);
        return Ok(report);
    }

    // 2. Remove abandoned temporary files older than a safe threshold.
    report.temp_files_removed = remove_stale_temp_files(paths)?;

    // 3. Canonical files on disk missing from the database → recover.
    //
    // A rebuild leaves behind what the old database still knew about each
    // script — its name, its Trash, its settings — because none of that is in
    // any file (#252). Applied here, by id, to the folders that rebuild left
    // without rows; a folder it did not describe is named from its own text.
    //
    // An index that exists and cannot be read stops adoption for this launch:
    // adopting without it would make the fallback names permanent, and the
    // folders are still there to adopt once it can be read.
    let (salvaged, adopt) =
        match salvage::load_pending_index(paths.root(), &paths.cache_dir()).await {
            Ok(index) => (index, true),
            Err(err) => {
                report.notes.push(format!(
                    "the script names a rebuild saved could not be read, so no folder was adopted this launch: {err}"
                ));
                (None, false)
            }
        };
    // Folders that are not adopted this launch, whose salvaged names must wait.
    let mut waiting = std::collections::HashSet::new();
    let known: std::collections::HashSet<String> = repo::all_script_ids_and_paths(pool)
        .await?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let scripts_dir = paths.scripts_dir();
    if adopt && scripts_dir.exists() {
        for entry in fs::read_dir(&scripts_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if known.contains(&dir_name) {
                continue;
            }
            // A directory whose name is not a canonical UUID is not ours; it
            // must never be adopted as a script id and turned back into a
            // path (C1).
            let Ok(script_id) = ScriptId::parse(&dir_name) else {
                report
                    .notes
                    .push(format!("ignored non-UUID directory in scripts root: {dir_name}"));
                continue;
            };
            let canonical = entry.path().join("script.md");
            if !canonical.exists() {
                waiting.insert(dir_name);
                continue;
            }
            match fs::read_to_string(&canonical) {
                Ok(source) => {
                    let previous = salvaged.as_ref().and_then(|index| index.get(&dir_name));
                    let (script, title_restored) = adoption_for(&script_id, &source, previous);
                    match repo::adopt_script_folder(pool, paths, &script_id, &source, &script).await {
                        Ok(adoption) => {
                            if title_restored {
                                report.titles_restored += 1;
                            }
                            report.revisions_recovered += adoption.revisions;
                            report.assets_recovered += adoption.assets;
                            report.notes.extend(
                                adoption.skipped.into_iter().map(|note| format!("{dir_name}: {note}")),
                            );
                            report.orphan_files_recovered.push(dir_name);
                        }
                        Err(err) => {
                            report.notes.push(format!("adopt orphan {dir_name}: {err}"));
                            waiting.insert(dir_name);
                        }
                    }
                }
                Err(err) => {
                    report
                        .notes
                        .push(format!("unreadable orphan {dir_name}: {err}"));
                    waiting.insert(dir_name);
                }
            }
        }
    }

    // The rebuild's index has done its job for every folder that now has a
    // row. What it says about a folder still waiting is kept for the retry
    // next launch; the rest goes, so it is never applied to anything later and
    // a script renamed or restored from the Trash is not overruled by it.
    if salvaged.is_some() {
        salvage::retain_pending_index(paths.root(), &waiting);
    }

    // 4. Every row is checked against its canonical file: missing files are
    // restored from the latest revision, and — the case that used to be
    // silently treated as healthy — rows whose recorded hash disagrees with
    // the file on disk are repaired. That mismatch is exactly the crash state
    // where the atomic rename landed but the database commit did not, so it
    // must be detected by content, not by mere existence (H3). The file is
    // the authority for source content (spec §48.1), so the database is
    // brought up to the file; disk content is never replaced here.
    //
    // A row that survives that is then brought up to the current spoken-word
    // extraction, so a library indexed by an older one shows today's previews,
    // counts and durations without every script being re-saved (#249).
    let mut stats_refreshed = 0u32;
    for (id, _) in repo::all_script_ids_and_paths(pool).await? {
        let Ok(script_id) = ScriptId::parse(&id) else {
            report
                .notes
                .push(format!("script row {id} has a non-UUID id; skipped"));
            continue;
        };
        let canonical = paths.canonical_file(&script_id);
        if !canonical.exists() {
            match repo::restore_canonical_from_latest_revision(pool, paths, &script_id).await {
                Ok(true) => report.missing_files_restored.push(id.clone()),
                Ok(false) => {
                    report.missing_files_unrecoverable.push(id);
                    continue;
                }
                Err(err) => {
                    report.notes.push(format!("restore {id}: {err}"));
                    continue;
                }
            }
        } else {
            match repo::repair_row_from_canonical_file(pool, paths, &script_id, locks).await {
                Ok(true) => {
                    report.hash_mismatches_repaired.push(id);
                    continue;
                }
                Ok(false) => {}
                Err(err) => {
                    report.notes.push(format!("repair {id}: {err}"));
                    continue;
                }
            }
        }
        match repo::refresh_stale_spoken_stats(pool, paths, &script_id, locks).await {
            Ok(true) => stats_refreshed += 1,
            Ok(false) => {}
            Err(err) => report.notes.push(format!("refresh library stats {id}: {err}")),
        }
    }
    if stats_refreshed > 0 {
        tracing::info!(stats_refreshed, "re-derived library word counts and previews");
    }

    // 5. Clear expired compiled caches (best effort).
    let compiled = paths.cache_dir().join("compiled");
    if compiled.exists() {
        let _ = remove_older_than(&compiled, Duration::from_secs(30 * 24 * 3600));
    }

    // 6. Purge trash older than 30 days (spec §21.5) — but not on the launch
    // that just recovered scripts. A rebuild brings the Trash back with the
    // dates things were trashed, and some of those may be past 30 days; the
    // first look at a recovered library should not be preceded by permanently
    // deleting part of it. The next ordinary launch purges as usual.
    report.trash_purged = if !report.orphan_files_recovered.is_empty() {
        report
            .notes
            .push("trash purge deferred to the next launch: scripts were recovered".to_string());
        0
    } else {
        match repo::purge_expired_trash(pool, paths, locks).await {
            Ok(purged) => purged,
            Err(err) => {
                tracing::warn!(error = %err, "expired trash could not be listed for purging");
                report.notes.push(format!("purge trash: {err}"));
                0
            }
        }
    };

    // Preserve evidence: write the report to the diagnostics directory.
    write_report(paths, &report)?;

    Ok(report)
}

/// How a folder with no row comes back: as the old database had it where a
/// rebuild could still read that, and otherwise as a draft named after its own
/// first line. Every value from the old database is checked before it is
/// trusted, and one that fails falls back on its own without costing the
/// script the others. The flag says whether the name is the one it had.
fn adoption_for(
    script_id: &ScriptId,
    source: &str,
    previous: Option<&SalvagedScript>,
) -> (repo::AdoptedScript, bool) {
    let now = now_iso();
    let saved_title = previous
        .and_then(|p| p.title.as_deref())
        .map(collapse_whitespace)
        .filter(|title| !title.is_empty());
    let title_restored = saved_title.is_some();
    let title = saved_title
        .or_else(|| title_from_source(source))
        .unwrap_or_else(|| format!("Recovered script {}", &script_id.as_str()[..8]));
    let status = previous
        .and_then(|p| p.status.as_deref())
        .and_then(|status| {
            ["draft", "ready", "archived", "trash"]
                .into_iter()
                .find(|known| *known == status)
        })
        .unwrap_or("draft");
    let timestamp = |value: Option<&String>| {
        value
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|t| {
                t.with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
    };
    // A trashed script keeps the date it was trashed, so its 30 days run from
    // when they always did. Without one it is trashed as of now: never earlier,
    // which could expire it before anybody has seen it.
    let trashed_at = (status == "trash").then(|| {
        timestamp(previous.and_then(|p| p.trashed_at.as_ref())).unwrap_or_else(|| now.clone())
    });
    let script = repo::AdoptedScript {
        title,
        status,
        language: previous
            .and_then(|p| p.language.clone())
            .unwrap_or_else(|| "en".to_string()),
        settings_json: previous.and_then(|p| p.script_settings_json.clone()),
        created_at: timestamp(previous.and_then(|p| p.created_at.as_ref()))
            .unwrap_or_else(|| now.clone()),
        updated_at: timestamp(previous.and_then(|p| p.updated_at.as_ref()))
            .unwrap_or_else(|| now.clone()),
        trashed_at,
    };
    (script, title_restored)
}

/// A name for a script nothing remembers the name of: its first line of
/// spoken text, read the way the Library reads it, so `# Launch video` is
/// "Launch video" and `**Hello** [there](…)` is "Hello there" (#252). `None`
/// when the script says nothing at all.
///
/// Read in the context of the whole document, not line by line: a line inside
/// a comment, a code block, `:::silent` or coach front matter says nothing,
/// and which of those a line is in depends on the lines around it. So the
/// first line that speaks is found by growing a prefix of the script until it
/// says something that the WHOLE script also opens with — a prefix that cuts
/// a construct short (a comment not yet closed) says something the whole
/// script does not, and is passed over. A script that opens with nothing
/// found that way within its first lines is named after the head of its
/// spoken text instead.
pub fn title_from_source(source: &str) -> Option<String> {
    const MAX_CHARS: usize = 80;
    // Bounds the prefix search, which re-reads the prefix each time.
    const MAX_PREFIX_LINES: usize = 200;
    const MAX_PREFIX_BYTES: usize = 64 * 1024;
    let options = SpokenTextOptions {
        read_headings: true,
        read_image_alt_text: false,
        read_inline_code: true,
    };
    let source = super::without_bom(source);
    let whole = collapse_whitespace(&spoken_text(source, options).plain);
    if whole.is_empty() {
        return None;
    }

    let mut first_line = None;
    let mut end = 0;
    for line in source.split_inclusive('\n').take(MAX_PREFIX_LINES) {
        end += line.len();
        if end > MAX_PREFIX_BYTES {
            break;
        }
        let said = collapse_whitespace(&spoken_text(&source[..end], options).plain);
        if !said.is_empty() && whole.starts_with(&said) {
            first_line = Some(said);
            break;
        }
    }
    let text = first_line.unwrap_or(whole);

    if text.chars().count() <= MAX_CHARS {
        return Some(text);
    }
    // Cut on a word where there is one, like the Library's preview.
    let head: String = text.chars().take(MAX_CHARS).collect();
    let cut = head.rfind(char::is_whitespace).map_or(head.as_str(), |at| &head[..at]);
    Some(format!("{}…", cut.trim_end()))
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn write_report(paths: &DataPaths, report: &RecoveryReport) -> Result<(), AppError> {
    if !report.has_findings() {
        return Ok(());
    }
    let dir = paths.diagnostics_dir();
    fs::create_dir_all(&dir)?;
    let file = dir.join(format!(
        "recovery-{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ")
    ));
    if let Ok(json) = serde_json::to_vec_pretty(report) {
        let _ = atomic_write(&file, &json);
    }
    Ok(())
}

fn remove_stale_temp_files(paths: &DataPaths) -> Result<u32, AppError> {
    let mut removed = 0u32;
    let scripts_dir = paths.scripts_dir();
    if !scripts_dir.exists() {
        return Ok(0);
    }
    let cutoff = SystemTime::now() - STALE_TEMP_AGE;
    for script_entry in fs::read_dir(&scripts_dir)? {
        let script_entry = script_entry?;
        if !script_entry.file_type()?.is_dir() {
            continue;
        }
        for entry in fs::read_dir(script_entry.path())? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(".tmp-") {
                if let Ok(meta) = entry.metadata() {
                    if meta.modified().map(|m| m < cutoff).unwrap_or(true) {
                        let _ = fs::remove_file(entry.path());
                        removed += 1;
                    }
                }
            }
        }
    }
    Ok(removed)
}

fn remove_older_than(dir: &std::path::Path, age: Duration) -> std::io::Result<()> {
    let cutoff = SystemTime::now() - age;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            if let Ok(meta) = entry.metadata() {
                if meta.modified().map(|m| m < cutoff).unwrap_or(false) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(())
}

/// Startup reconciliation findings, kept until the frontend asks for them.
///
/// ## Why this exists
///
/// Reconciliation runs to completion inside Tauri's `setup` hook — before the
/// control webview has executed a line of JavaScript. A Tauri event is
/// delivered by evaluating JS in the target webview and is never queued, so the
/// `diagnostic://warning` this used to emit landed on a page with no listeners
/// and was simply gone. The code's own comment described the emit as "best
/// effort" and pointed at a diagnostics file as the fallback, which is a file
/// nobody opens.
///
/// The findings are held here instead and read once the frontend is up. The
/// emit is gone entirely rather than kept as a nudge — nothing ever listened
/// for it, and a declared event with no listener reads to the next person as a
/// delivery path that works.
#[derive(Debug)]
pub struct StartupFindings {
    report: std::sync::Mutex<Option<RecoveryReport>>,
}

impl StartupFindings {
    pub fn new(report: RecoveryReport) -> Self {
        Self {
            report: std::sync::Mutex::new(Some(report)),
        }
    }

    /// Take the findings. Once — they are a report on THIS launch, and a
    /// second reader is a second window showing the same one-time notice.
    pub fn take(&self) -> Option<RecoveryReport> {
        self.report.lock().ok().and_then(|mut held| held.take())
    }
}

#[cfg(test)]
mod title_tests {
    use super::title_from_source;

    #[test]
    fn a_script_is_named_after_its_first_spoken_line() {
        assert_eq!(title_from_source("# Launch video\n\nHello.").as_deref(), Some("Launch video"));
        assert_eq!(
            title_from_source("\n\n**Hello** there,   world.\nMore.").as_deref(),
            Some("Hello there, world.")
        );
        // A byte-order mark is not a character of the title (#247).
        assert_eq!(title_from_source("\u{feff}# Marked").as_deref(), Some("Marked"));
    }

    #[test]
    fn code_and_images_are_not_a_title() {
        let source = "```\nlet x = 1;\n```\n![Logo](assets/logo.png)\n\nIntro line.";
        assert_eq!(title_from_source(source).as_deref(), Some("Intro line."));
    }

    #[test]
    fn a_long_first_line_is_cut_on_a_word() {
        let source = "word ".repeat(40);
        let title = title_from_source(&source).expect("title");
        assert!(title.chars().count() <= 81, "{title}");
        assert!(title.ends_with("word…"), "{title}");
    }

    #[test]
    fn a_line_says_nothing_inside_what_the_document_keeps_silent() {
        // Only the whole document knows the comment, the silent block and
        // the four-backtick fence are closed where they are.
        let source = "<!--\nPrivate production note\n-->\n# The real opening";
        assert_eq!(title_from_source(source).as_deref(), Some("The real opening"));
        let source = ":::silent\nStage direction only\n:::\n\nSpoken first.";
        assert_eq!(title_from_source(source).as_deref(), Some("Spoken first."));
        let source = "````\n```\nstill code\n````\nAfter the code.";
        assert_eq!(title_from_source(source).as_deref(), Some("After the code."));
    }

    #[test]
    fn a_script_that_says_nothing_has_no_title_to_give() {
        assert_eq!(title_from_source(""), None);
        assert_eq!(title_from_source("\n   \n```\ncode only\n```\n"), None);
    }
}
