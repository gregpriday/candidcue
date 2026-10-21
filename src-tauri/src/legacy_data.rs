//! The data folder from before the rename to Speaking Glass.
//!
//! The app was called CandidCue until October 2026, with the bundle identifier
//! `com.candidcue.app`. Tauri keeps app data in `<data dir>/<identifier>`, so
//! the new identifier is a new, empty folder, and every script, revision,
//! setting, backup and downloaded model would otherwise stay in the old one.
//!
//! So the old folder is COPIED into place, renaming on the way the few files
//! inside it that carried the old name: the database and its WAL, the Rust
//! logs, and each installed model's seal. A seal is what makes a model
//! directory count as installed (`speech::model_store`), so a model left with
//! only the old one would be downloaded again.
//!
//! Copied, not moved. No public build ever shipped under the old identifier,
//! so the only old folders belong to people who build the app from source, and
//! an older checkout still reads its own folder. Moving it would leave that
//! checkout looking at an empty library. The old folder keeps its data and can
//! be deleted by hand once nothing needs it.
//!
//! The database is not copied as files. An older checkout can be running while
//! this one starts (the single-instance lock is per identifier too), and a file
//! copy of a live database and its WAL can catch them mid-checkpoint. SQLite's
//! own `VACUUM INTO`, through a read-only connection, takes a consistent
//! snapshot. The raw files are the fallback only for a database SQLite cannot
//! open or read at all; anything else that goes wrong fails the copy, so it is
//! tried again rather than settled on a copy that might be torn.
//!
//! ## When it runs
//!
//! [`migrate`] runs before the Tauri builder. That is the only point at which
//! nothing in this process has touched the new folder: the main window is
//! built before `setup`, and on Linux its web view keeps its data in that same
//! folder. The copy goes to a sibling named for this process and is renamed
//! into place only when it is complete, so an interrupted copy is never
//! mistaken for the real thing.
//!
//! A copied folder carries [`COPIED_MARKER`], and that is what makes it
//! settled. A new folder WITHOUT it means an earlier copy failed and the app
//! opened on a fresh folder instead, so a later launch tries again. It
//! replaces a fresh folder only while the user has done nothing in it that
//! matters: no script, and no restore or rebuild under way. Otherwise the
//! folder is marked settled as it is, because their work is never replaced.
//! And the folder it does replace is kept beside the new one rather than
//! deleted, since settings changed or a model downloaded meanwhile are still
//! in it.
//!
//! Replacing a folder another instance is running on would split that
//! instance between two folders, and the single-instance plugin is not a
//! guarantee this early: it can let two launches through in the moment both
//! start. So while the new folder is unsettled, every launch takes an OS file
//! lock beside the folders and holds it for as long as it runs: exclusively
//! only to copy or replace, and shared otherwise. A launch that cannot have it
//! exclusively waits for a share, which takes as long as a copy at most, and
//! leaves the folders alone. The lock file is never deleted, because a file
//! deleted while held is a second, unrelated lock to the next launch.
//!
//! It refuses, as a failure, while the old folder is partway through a
//! recovery (a scheduled restore, an interrupted rebuild). Those journals
//! record absolute paths into the old folder and file names under the old
//! name, and finishing them is the old build's job, not a guess made here.
//!
//! A failure never stops the app. It opens on an empty library, the log says
//! why, and the next launch tries again.

use std::path::{Path, PathBuf};

/// The bundle identifier before the rename, and so the old folder's name.
pub const LEGACY_IDENTIFIER: &str = "com.candidcue.app";

/// The Rust log prefix before the rename (`diagnostics::logging`).
const LEGACY_LOG_PREFIX: &str = "candidcue-rust.";

/// An installed model's seal before the rename (`speech::model_store`).
const LEGACY_SEAL_FILE: &str = ".candidcue-model.json";

/// In a new folder that is settled: the old one was copied into it, or work
/// had started in it before a copy could succeed.
pub const COPIED_MARKER: &str = ".candidcue-folder-copied";

/// Journals of a recovery that has not finished (`backup`). Each names paths
/// inside the folder it was written in.
const RECOVERY_JOURNALS: [&str; 3] = [
    "restore-pending.json",
    "rebuild-pending.json",
    "rebuild-script-index.json",
];

/// SQLite primary result codes that mean the old database cannot be opened at
/// all, which is when its raw files are copied instead: READONLY (a read-only
/// connection that cannot set up the WAL index), CORRUPT, CANTOPEN and NOTADB.
const UNOPENABLE: [i64; 4] = [8, 11, 14, 26];

/// The codes that, from the snapshot itself, say the SOURCE is bad: CORRUPT
/// and NOTADB. Anything else there (CANTOPEN or READONLY among them) may be
/// the snapshot's own file, which the next launch can try again.
const UNREADABLE: [i64; 2] = [11, 26];

/// What a launch did about the old folder.
#[derive(Debug)]
pub enum Outcome {
    /// Nothing to do: there is no old folder, the new one is settled, or
    /// another launch holds the lock.
    NotNeeded,
    /// The old folder was copied into place. `raw_database` says why the
    /// database was copied as files rather than snapshotted, when it was;
    /// `replaced` is where a fresh folder from an earlier failed copy went.
    Copied {
        from: PathBuf,
        to: PathBuf,
        raw_database: Option<String>,
        replaced: Option<PathBuf>,
    },
    /// The copy failed or was refused. Nothing was published, the old folder
    /// is intact, and the next launch tries again.
    Failed { from: PathBuf, to: PathBuf, error: std::io::Error },
    /// An earlier copy failed and the user has worked in the new folder since,
    /// so it is settled as it is.
    Abandoned { from: PathBuf, to: PathBuf },
}

impl Outcome {
    /// Say what happened. Called once logging exists, which is after this ran.
    pub fn log(&self) {
        match self {
            Outcome::NotNeeded => {}
            Outcome::Copied { from, to, raw_database, replaced } => {
                tracing::info!(
                    from = %from.display(),
                    to = %to.display(),
                    "copied the CandidCue data folder into place; the original is untouched"
                );
                if let Some(reason) = raw_database {
                    tracing::warn!(
                        reason = %reason,
                        "SQLite could not read the CandidCue database, so its files were copied \
                         as they were"
                    );
                }
                if let Some(replaced) = replaced {
                    tracing::warn!(
                        path = %replaced.display(),
                        "the folder an earlier launch started on was set aside, not deleted"
                    );
                }
            }
            Outcome::Failed { from, to, error } => tracing::error!(
                from = %from.display(),
                to = %to.display(),
                error = %error,
                "could not copy the CandidCue data folder, so this run started without it. The \
                 original is untouched, and the next launch tries again until a script is \
                 created here"
            ),
            Outcome::Abandoned { from, to } => tracing::warn!(
                from = %from.display(),
                to = %to.display(),
                "not copying the CandidCue data folder: work was started here after an earlier \
                 copy failed. The original is still there"
            ),
        }
    }
}

/// Copy the old folder into place, if there is one and the new one is not
/// settled. Called before the Tauri builder.
///
/// `data_dir` is the platform's data directory, the parent Tauri joins the
/// identifier onto (`PathResolver::app_data_dir`). The lock comes back with
/// the outcome, and the caller holds it for as long as the process runs.
pub fn migrate(data_dir: &Path, identifier: &str) -> (Outcome, Option<std::fs::File>) {
    if identifier == LEGACY_IDENTIFIER {
        return (Outcome::NotNeeded, None);
    }
    let from = data_dir.join(LEGACY_IDENTIFIER);
    let to = data_dir.join(identifier);
    let holds_data = from.join(crate::database::LEGACY_DB_FILE_NAME).is_file()
        || std::fs::read_dir(from.join("scripts"))
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false);
    if !holds_data {
        return (Outcome::NotNeeded, None);
    }
    if to.join(COPIED_MARKER).exists() {
        sweep_staging(data_dir, identifier);
        return (Outcome::NotNeeded, None);
    }
    let lock = match take_lock(data_dir, identifier) {
        Ok(Lock::Exclusive(lock)) => lock,
        // Another launch is copying, or running on the folder a copy would
        // replace. It has this in hand.
        Ok(Lock::Shared(lock)) => return (Outcome::NotNeeded, Some(lock)),
        Err(error) => return (Outcome::Failed { from, to, error }, None),
    };
    // `symlink_metadata`, so a dangling link at the new path still counts as
    // something being there.
    let outcome = if to.join(COPIED_MARKER).exists() {
        // Settled while this launch waited for the lock.
        Outcome::NotNeeded
    } else if std::fs::symlink_metadata(&to).is_err() {
        copy(from, to, data_dir, identifier, false)
    } else if holds_work(&to) {
        // Settled as it is, and said once rather than on every launch.
        let _ = std::fs::write(to.join(COPIED_MARKER), "work started here before a copy succeeded\n");
        Outcome::Abandoned { from, to }
    } else {
        copy(from, to, data_dir, identifier, true)
    };
    // Shared from here on, so the next launch can run beside this one. If the
    // share cannot be had after all, this run simply goes unguarded.
    let _ = lock.unlock().and_then(|()| lock.lock_shared());
    (outcome, Some(lock))
}

fn lock_path(data_dir: &Path, identifier: &str) -> PathBuf {
    data_dir.join(format!("{identifier}.legacy-copy.lock"))
}

enum Lock {
    /// This launch may copy and replace.
    Exclusive(std::fs::File),
    /// Another launch holds it: this one runs beside it and changes nothing.
    Shared(std::fs::File),
}

/// Exclusive when nobody else holds it; otherwise a share, waited for if a
/// copy is under way.
fn take_lock(data_dir: &Path, identifier: &str) -> std::io::Result<Lock> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path(data_dir, identifier))?;
    match file.try_lock() {
        Ok(()) => Ok(Lock::Exclusive(file)),
        Err(std::fs::TryLockError::WouldBlock) => {
            file.lock_shared()?;
            Ok(Lock::Shared(file))
        }
        Err(std::fs::TryLockError::Error(err)) => Err(err),
    }
}

/// Whether the user has done something in a fresh folder that a copy must
/// not replace: a script, or a restore or rebuild under way. A scripts folder
/// that cannot be read counts as holding scripts: not knowing is not a reason
/// to set it aside.
fn holds_work(root: &Path) -> bool {
    let scripts = match std::fs::read_dir(root.join("scripts")) {
        Ok(mut entries) => entries.next().is_some(),
        Err(err) => err.kind() != std::io::ErrorKind::NotFound,
    };
    scripts || RECOVERY_JOURNALS.iter().any(|name| root.join(name).exists())
}

fn copy(from: PathBuf, to: PathBuf, data_dir: &Path, identifier: &str, replace: bool) -> Outcome {
    if let Some(journal) = RECOVERY_JOURNALS.iter().find(|name| from.join(name).exists()) {
        let error = std::io::Error::other(format!(
            "CandidCue has not finished a recovery ({journal} is still there); open the build \
             that wrote it once to let it finish"
        ));
        return Outcome::Failed { from, to, error };
    }
    let staging = data_dir.join(format!("{identifier}.migrating-{}", std::process::id()));
    let result = (|| {
        if std::fs::symlink_metadata(&staging).is_ok() {
            std::fs::remove_dir_all(&staging)?;
        }
        copy_all_but_the_database(&from, &staging)?;
        let raw_database = snapshot_database(&from, &staging)?;
        rename_legacy_names(&staging)?;
        std::fs::write(staging.join(COPIED_MARKER), format!("{}\n", from.display()))?;
        let replaced = if replace {
            Some(replace_with(&staging, &to, data_dir, identifier)?)
        } else {
            crate::util::rename(&staging, &to)?;
            None
        };
        crate::util::sync_dir(data_dir).map_err(std::io::Error::other)?;
        Ok((raw_database, replaced))
    })();
    if std::fs::symlink_metadata(&staging).is_ok() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    match result {
        Ok((raw_database, replaced)) => Outcome::Copied { from, to, raw_database, replaced },
        Err(error) => Outcome::Failed { from, to, error },
    }
}

/// The database's files under their old names: the database, its WAL and its
/// shared-memory index.
fn legacy_database_files() -> [String; 3] {
    ["", "-wal", "-shm"].map(|suffix| format!("{}{suffix}", crate::database::LEGACY_DB_FILE_NAME))
}

/// Everything in the old folder except the database's own files, which the
/// snapshot below stands in for. Copying them as files would race the old
/// build's own connection: SQLite deletes the WAL and its index when the last
/// connection closes, so either can vanish between being listed and copied.
fn copy_all_but_the_database(from: &Path, staging: &Path) -> std::io::Result<()> {
    let skip = legacy_database_files();
    std::fs::create_dir_all(staging)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if skip.iter().any(|file| name == file.as_str()) {
            continue;
        }
        let file_type = entry.file_type()?;
        let target = staging.join(&name);
        if file_type.is_dir() {
            crate::backup::copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)?;
            crate::util::sync_file(&target).map_err(std::io::Error::other)?;
        }
    }
    Ok(())
}

/// Put a consistent snapshot of the old database into the copy.
/// `Ok(Some(reason))` when SQLite cannot read the old database at all, and its
/// raw files are copied instead; an error for anything that might pass on a
/// later try.
fn snapshot_database(from: &Path, staging: &Path) -> std::io::Result<Option<String>> {
    let source = from.join(crate::database::LEGACY_DB_FILE_NAME);
    if !source.is_file() {
        return Ok(None);
    }
    let target = staging.join(crate::database::DB_FILE_NAME);
    let snapshot: Result<(), (sqlx::Error, &[i64])> = tauri::async_runtime::block_on(async {
        // Read-only, so closing it cannot checkpoint the old folder's WAL.
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&source)
            .read_only(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|err| (err, &UNOPENABLE[..]))?;
        // Opening is lazy about the file itself; reading the schema is not.
        let probe = sqlx::query("SELECT count(*) FROM sqlite_master")
            .execute(&pool)
            .await
            .map_err(|err| (err, &UNOPENABLE[..]));
        // A literal, not a bind: `VACUUM INTO` takes no parameters.
        let sql = format!(
            "VACUUM INTO '{}'",
            target.display().to_string().replace('\'', "''")
        );
        let result = match probe {
            Ok(_) => sqlx::query(&sql)
                .execute(&pool)
                .await
                .map(|_| ())
                .map_err(|err| (err, &UNREADABLE[..])),
            Err(err) => Err(err),
        };
        pool.close().await;
        result
    });
    match snapshot {
        Ok(()) => {
            crate::util::sync_file(&target).map_err(std::io::Error::other)?;
            Ok(None)
        }
        Err((err, unreadable)) => {
            // Whatever half-written snapshot there is goes first, either way.
            remove_if_present(&target)?;
            if !primary_code(&err).is_some_and(|code| unreadable.contains(&code)) {
                return Err(std::io::Error::other(err));
            }
            // A database SQLite cannot read has no live connection to race,
            // so its files are copied as they are. Only the database itself
            // must be there; a WAL or index that is not is simply not copied.
            for (index, name) in legacy_database_files().iter().enumerate() {
                let copied = staging.join(name);
                match std::fs::copy(from.join(name), &copied) {
                    Ok(_) => crate::util::sync_file(&copied).map_err(std::io::Error::other)?,
                    Err(missing) if index > 0 && missing.kind() == std::io::ErrorKind::NotFound => {}
                    Err(other) => return Err(other),
                }
            }
            Ok(Some(err.to_string()))
        }
    }
}

/// SQLite's primary result code (sqlx reports the extended one, in decimal).
fn primary_code(err: &sqlx::Error) -> Option<i64> {
    let sqlx::Error::Database(db) = err else {
        return None;
    };
    db.code()
        .and_then(|code| code.parse::<i64>().ok())
        .map(|code| code & 0xff)
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

/// Rename, inside a copied folder, the files whose names carried the old name.
fn rename_legacy_names(root: &Path) -> std::io::Result<()> {
    // The WAL and shared-memory files first and the database last, so an
    // interruption can never leave the database under its new name without
    // the WAL holding its newest pages. (The whole copy is retried anyway.)
    for suffix in ["-wal", "-shm", ""] {
        let old = root.join(format!("{}{suffix}", crate::database::LEGACY_DB_FILE_NAME));
        let new = root.join(format!("{}{suffix}", crate::database::DB_FILE_NAME));
        if old.is_file() && !new.exists() {
            crate::util::rename(&old, &new)?;
        }
    }

    let logs = root.join("logs");
    if logs.is_dir() {
        for entry in std::fs::read_dir(&logs)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(rest) = name.strip_prefix(LEGACY_LOG_PREFIX) {
                let renamed = logs.join(format!(
                    "{}.{rest}",
                    crate::diagnostics::logging::RUST_LOG_PREFIX
                ));
                if !renamed.exists() {
                    crate::util::rename(entry.path(), renamed)?;
                }
            }
        }
    }

    let models = root.join("models");
    if models.is_dir() {
        for entry in std::fs::read_dir(&models)? {
            let dir = entry?.path();
            let old = dir.join(LEGACY_SEAL_FILE);
            let new = dir.join(crate::speech::model_store::SEAL_FILE);
            if old.is_file() && !new.exists() {
                crate::util::rename(&old, &new)?;
            }
        }
    }
    Ok(())
}

/// Put the copy where a fresh folder is, keeping the fresh one beside it.
///
/// Set aside rather than merged into, because a rename onto a folder that
/// exists is not one operation anywhere; kept rather than deleted, because it
/// can hold settings changed or a model downloaded since. Returns where it went.
fn replace_with(staging: &Path, to: &Path, data_dir: &Path, identifier: &str) -> std::io::Result<PathBuf> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.6fZ");
    let aside = data_dir.join(format!("{identifier}.replaced-{stamp}"));
    crate::util::rename(to, &aside)?;
    if let Err(err) = crate::util::rename(staging, to) {
        return Err(match crate::util::rename(&aside, to) {
            Ok(()) => err,
            Err(back) => std::io::Error::other(format!(
                "{err}; and the folder it was replacing could not be put back, so it is at {} \
                 ({back})",
                aside.display()
            )),
        });
    }
    Ok(aside)
}

/// Copies a crashed launch left behind. Only once the new folder is settled,
/// when no copy still running could be published anyway.
fn sweep_staging(data_dir: &Path, identifier: &str) {
    let prefix = format!("{identifier}.migrating-");
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTIFIER: &str = "com.speakingglass.app";

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn connect(path: &Path, create: bool) -> sqlx::SqlitePool {
        tauri::async_runtime::block_on(async {
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(create)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
            sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .unwrap()
        })
    }

    /// A real SQLite database, so the snapshot path is the one exercised.
    fn database(path: &Path, title: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let pool = connect(path, true);
        tauri::async_runtime::block_on(async {
            sqlx::query("CREATE TABLE scripts (title TEXT)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO scripts VALUES (?)").bind(title).execute(&pool).await.unwrap();
            pool.close().await;
        });
    }

    fn title_in(path: &Path) -> String {
        let pool = connect(path, false);
        tauri::async_runtime::block_on(async {
            let title: String = sqlx::query_scalar("SELECT title FROM scripts")
                .fetch_one(&pool)
                .await
                .unwrap();
            pool.close().await;
            title
        })
    }

    /// The old folder as the last CandidCue build left it.
    fn legacy_folder(data_dir: &Path) -> PathBuf {
        let root = data_dir.join(LEGACY_IDENTIFIER);
        database(&root.join("candidcue.sqlite3"), "Launch video");
        write(&root.join("scripts/abc/script.md"), "# Talk\n");
        write(&root.join("logs/candidcue-rust.2026-10-20.log"), "yesterday\n");
        write(&root.join("logs/client-trace.log"), "trace\n");
        write(&root.join("models/x-asr-480ms/.candidcue-model.json"), "{}");
        write(&root.join("models/x-asr-480ms/tokens.txt"), "tokens");
        write(&root.join("window-frame.json"), "{}");
        root
    }

    /// What `setup` leaves after a launch whose copy failed: a fresh folder.
    fn fresh_folder(data_dir: &Path) -> PathBuf {
        let new = data_dir.join(IDENTIFIER);
        write(&new.join("speaking-glass.sqlite3"), "fresh and empty");
        write(&new.join("models/x-asr-480ms/tokens.txt"), "downloaded meanwhile");
        std::fs::create_dir_all(new.join("scripts")).unwrap();
        new
    }

    fn siblings(data_dir: &Path, infix: &str) -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = std::fs::read_dir(data_dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().contains(infix))
            .collect();
        found.sort();
        found
    }

    fn run(data_dir: &Path) -> Outcome {
        migrate(data_dir, IDENTIFIER).0
    }

    #[test]
    fn the_old_folder_is_copied_into_place_under_the_new_names() {
        let data_dir = tempfile::tempdir().unwrap();
        legacy_folder(data_dir.path());

        let outcome = run(data_dir.path());
        assert!(
            matches!(outcome, Outcome::Copied { raw_database: None, replaced: None, .. }),
            "{outcome:?}"
        );

        let new = data_dir.path().join(IDENTIFIER);
        assert_eq!(title_in(&new.join("speaking-glass.sqlite3")), "Launch video");
        assert!(!new.join("candidcue.sqlite3").exists());
        assert!(!new.join("candidcue.sqlite3-wal").exists());
        assert_eq!(read(&new.join("scripts/abc/script.md")), "# Talk\n");
        assert_eq!(read(&new.join("logs/speaking-glass-rust.2026-10-20.log")), "yesterday\n");
        assert_eq!(read(&new.join("logs/client-trace.log")), "trace\n");
        assert_eq!(read(&new.join("models/x-asr-480ms/.speaking-glass-model.json")), "{}");
        assert!(!new.join("models/x-asr-480ms/.candidcue-model.json").exists());
        assert_eq!(read(&new.join("window-frame.json")), "{}");
        assert!(new.join(COPIED_MARKER).exists(), "a copied folder is settled");
        assert!(siblings(data_dir.path(), ".migrating-").is_empty());

        // Settled: nothing more to do, and no lock taken for it.
        let (again, lock) = migrate(data_dir.path(), IDENTIFIER);
        assert!(matches!(again, Outcome::NotNeeded), "{again:?}");
        assert!(lock.is_none());
    }

    #[test]
    fn a_live_database_is_snapshotted_and_its_wal_left_alone() {
        let data_dir = tempfile::tempdir().unwrap();
        let old = legacy_folder(data_dir.path());
        // An older checkout still has it open: its WAL holds an uncheckpointed row.
        let live = connect(&old.join("candidcue.sqlite3"), false);
        tauri::async_runtime::block_on(async {
            sqlx::query("PRAGMA wal_autocheckpoint = 0").execute(&live).await.unwrap();
            sqlx::query("UPDATE scripts SET title = 'Edited while open'")
                .execute(&live)
                .await
                .unwrap();
        });
        let wal = std::fs::read(old.join("candidcue.sqlite3-wal")).unwrap();
        let database = std::fs::read(old.join("candidcue.sqlite3")).unwrap();

        let outcome = run(data_dir.path());
        assert!(matches!(outcome, Outcome::Copied { raw_database: None, .. }), "{outcome:?}");

        let new = data_dir.path().join(IDENTIFIER);
        assert_eq!(title_in(&new.join("speaking-glass.sqlite3")), "Edited while open");
        assert!(
            !new.join("speaking-glass.sqlite3-wal").exists(),
            "a snapshot is one self-contained file, not a copy of the WAL"
        );
        assert_eq!(std::fs::read(old.join("candidcue.sqlite3-wal")).unwrap(), wal);
        assert_eq!(std::fs::read(old.join("candidcue.sqlite3")).unwrap(), database);
        tauri::async_runtime::block_on(live.close());
    }

    #[test]
    fn the_old_folder_keeps_its_data() {
        let data_dir = tempfile::tempdir().unwrap();
        let old = legacy_folder(data_dir.path());

        run(data_dir.path());

        assert_eq!(title_in(&old.join("candidcue.sqlite3")), "Launch video");
        assert_eq!(read(&old.join("scripts/abc/script.md")), "# Talk\n");
        assert_eq!(read(&old.join("logs/candidcue-rust.2026-10-20.log")), "yesterday\n");
        assert_eq!(read(&old.join("models/x-asr-480ms/.candidcue-model.json")), "{}");
        assert!(!old.join(COPIED_MARKER).exists());
    }

    #[test]
    fn a_database_sqlite_cannot_read_is_copied_as_it_is() {
        let data_dir = tempfile::tempdir().unwrap();
        let old = legacy_folder(data_dir.path());
        std::fs::remove_file(old.join("candidcue.sqlite3")).unwrap();
        write(&old.join("candidcue.sqlite3"), "not a database");
        write(&old.join("candidcue.sqlite3-wal"), "wal");

        let outcome = run(data_dir.path());
        assert!(matches!(outcome, Outcome::Copied { raw_database: Some(_), .. }), "{outcome:?}");

        let new = data_dir.path().join(IDENTIFIER);
        assert_eq!(read(&new.join("speaking-glass.sqlite3")), "not a database");
        assert_eq!(read(&new.join("speaking-glass.sqlite3-wal")), "wal");
    }

    #[test]
    fn with_no_old_folder_there_is_nothing_to_do() {
        let data_dir = tempfile::tempdir().unwrap();

        let (outcome, lock) = migrate(data_dir.path(), IDENTIFIER);
        assert!(matches!(outcome, Outcome::NotNeeded), "{outcome:?}");
        assert!(lock.is_none());
        assert!(
            !data_dir.path().join(IDENTIFIER).exists(),
            "creating the folder is setup's job, not this one's"
        );
        assert!(!lock_path(data_dir.path(), IDENTIFIER).exists());
    }

    fn held_shared(data_dir: &Path) -> std::fs::File {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path(data_dir, IDENTIFIER))
            .unwrap();
        file.lock_shared().unwrap();
        file
    }

    #[test]
    fn a_launch_beside_a_running_instance_leaves_its_folder_alone() {
        let data_dir = tempfile::tempdir().unwrap();
        legacy_folder(data_dir.path());
        let new = fresh_folder(data_dir.path());
        // Another instance, running on the fresh folder after its copy failed.
        let running = held_shared(data_dir.path());

        let (outcome, lock) = migrate(data_dir.path(), IDENTIFIER);
        assert!(matches!(outcome, Outcome::NotNeeded), "{outcome:?}");
        assert!(lock.is_some(), "it runs beside the other one, under a share");
        assert_eq!(read(&new.join("speaking-glass.sqlite3")), "fresh and empty");

        // Once neither is running, the next launch copies.
        drop(running);
        drop(lock);
        let outcome = run(data_dir.path());
        assert!(matches!(outcome, Outcome::Copied { replaced: Some(_), .. }), "{outcome:?}");
    }

    #[test]
    fn a_launch_that_copied_holds_only_a_share_afterwards() {
        let data_dir = tempfile::tempdir().unwrap();
        let old = legacy_folder(data_dir.path());
        write(&old.join("restore-pending.json"), "{}");

        let (outcome, lock) = migrate(data_dir.path(), IDENTIFIER);
        assert!(matches!(outcome, Outcome::Failed { .. }), "{outcome:?}");
        assert!(lock.is_some(), "a launch on an unsettled folder keeps the lock");

        // A second launch is not kept waiting behind the first.
        let beside = held_shared(data_dir.path());
        drop(beside);
        assert!(lock_path(data_dir.path(), IDENTIFIER).exists(), "the lock file stays");
    }

    #[test]
    fn a_recovery_in_progress_is_refused_then_retried_once_it_is_done() {
        for journal in RECOVERY_JOURNALS {
            let data_dir = tempfile::tempdir().unwrap();
            let old = legacy_folder(data_dir.path());
            write(&old.join(journal), "{}");

            let outcome = run(data_dir.path());
            assert!(matches!(outcome, Outcome::Failed { .. }), "{journal}: {outcome:?}");
            assert!(!data_dir.path().join(IDENTIFIER).exists(), "{journal}");

            // The app opens on a fresh folder, and the old build later
            // finishes its recovery.
            let new = fresh_folder(data_dir.path());
            std::fs::remove_file(old.join(journal)).unwrap();

            let outcome = run(data_dir.path());
            let Outcome::Copied { replaced: Some(aside), .. } = outcome else {
                panic!("{journal}: {outcome:?}");
            };
            assert_eq!(title_in(&new.join("speaking-glass.sqlite3")), "Launch video");
            assert_eq!(read(&new.join("scripts/abc/script.md")), "# Talk\n");
            assert!(new.join(COPIED_MARKER).exists());
            assert_eq!(
                read(&aside.join("models/x-asr-480ms/tokens.txt")),
                "downloaded meanwhile",
                "{journal}: the folder it replaced is kept"
            );
            assert!(siblings(data_dir.path(), ".migrating-").is_empty());
        }
    }

    #[test]
    fn a_fresh_folder_the_user_has_worked_in_is_settled_not_replaced() {
        let work: [(&str, &str); 4] = [
            ("scripts/xyz/script.md", "# Written in Speaking Glass\n"),
            ("restore-pending.json", "{}"),
            ("rebuild-pending.json", "{}"),
            ("rebuild-script-index.json", "{}"),
        ];
        for (path, contents) in work {
            let data_dir = tempfile::tempdir().unwrap();
            legacy_folder(data_dir.path());
            let new = fresh_folder(data_dir.path());
            write(&new.join(path), contents);

            let outcome = run(data_dir.path());
            assert!(matches!(outcome, Outcome::Abandoned { .. }), "{path}: {outcome:?}");
            assert_eq!(read(&new.join(path)), contents);
            assert!(!new.join("scripts/abc").exists(), "{path}");
            assert_eq!(read(&new.join("speaking-glass.sqlite3")), "fresh and empty");

            let outcome = run(data_dir.path());
            assert!(matches!(outcome, Outcome::NotNeeded), "{path}: said once, not every launch");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_scripts_folder_that_cannot_be_read_counts_as_holding_scripts() {
        use std::os::unix::fs::PermissionsExt;
        let data_dir = tempfile::tempdir().unwrap();
        legacy_folder(data_dir.path());
        let new = fresh_folder(data_dir.path());
        let scripts = new.join("scripts");
        std::fs::set_permissions(&scripts, std::fs::Permissions::from_mode(0o000)).unwrap();

        let outcome = run(data_dir.path());
        std::fs::set_permissions(&scripts, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(outcome, Outcome::Abandoned { .. }), "{outcome:?}");
        assert_eq!(read(&new.join("speaking-glass.sqlite3")), "fresh and empty");
    }

    #[test]
    fn a_first_copy_never_publishes_over_a_folder_that_appeared_meanwhile() {
        let data_dir = tempfile::tempdir().unwrap();
        let staging = data_dir.path().join("staging");
        write(&staging.join("speaking-glass.sqlite3"), "the copy");
        let to = data_dir.path().join(IDENTIFIER);
        write(&to.join("speaking-glass.sqlite3"), "another launch's");

        assert!(crate::util::rename(&staging, &to).is_err());
        assert_eq!(read(&to.join("speaking-glass.sqlite3")), "another launch's");
    }

    #[test]
    fn a_replacement_that_cannot_land_puts_the_fresh_folder_back() {
        let data_dir = tempfile::tempdir().unwrap();
        let to = fresh_folder(data_dir.path());
        let missing = data_dir.path().join("no-such-staging");

        assert!(replace_with(&missing, &to, data_dir.path(), IDENTIFIER).is_err());
        assert_eq!(read(&to.join("speaking-glass.sqlite3")), "fresh and empty");
        assert!(siblings(data_dir.path(), ".replaced-").is_empty());
    }

    #[test]
    fn a_copy_a_crashed_launch_left_is_cleaned_up_once_the_folder_is_settled() {
        let data_dir = tempfile::tempdir().unwrap();
        legacy_folder(data_dir.path());
        write(&data_dir.path().join(format!("{IDENTIFIER}.migrating-1/half.txt")), "half");

        run(data_dir.path());
        assert_eq!(siblings(data_dir.path(), ".migrating-").len(), 1);

        run(data_dir.path());
        assert!(siblings(data_dir.path(), ".migrating-").is_empty());
    }

    #[test]
    fn a_name_already_taken_inside_the_copy_is_kept() {
        let data_dir = tempfile::tempdir().unwrap();
        let old = legacy_folder(data_dir.path());
        write(&old.join("logs/speaking-glass-rust.2026-10-20.log"), "already renamed\n");

        run(data_dir.path());

        let logs = data_dir.path().join(IDENTIFIER).join("logs");
        assert_eq!(read(&logs.join("speaking-glass-rust.2026-10-20.log")), "already renamed\n");
        assert_eq!(read(&logs.join("candidcue-rust.2026-10-20.log")), "yesterday\n");
    }
}
