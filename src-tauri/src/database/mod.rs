//! SQLite connection pool + migrations (spec §44.3).
//!
//! WAL mode, foreign keys on, busy timeout, pool sized for a desktop app.
//! Migrations are embedded from `src-tauri/migrations` and run at startup
//! before any command can touch the database.

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use crate::errors::AppError;

/// Spec §47.1 data-directory layout.
pub const DB_FILE_NAME: &str = "candidcue.sqlite3";

/// Managed Tauri state wrapping the pool. Typed repositories (spec §44.3)
/// hang off this as they are implemented.
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

/// Did the database come up, and if not, what stopped it?
///
/// ## Why this is managed state rather than a `?` in `setup`
///
/// `database::init` runs inside Tauri's setup hook, which is BEFORE any webview
/// exists. Returning an error from there aborts startup — in a release build,
/// through a panic the abort profile turns into a vanished application. So the
/// two failures most likely to need a human, `DATABASE_CORRUPT` and a failed
/// migration, removed every in-app recovery action at exactly the moment one
/// was needed. The frontend's own boot-failure screen said as much: its comment
/// noted that neither code could actually reach it.
///
/// The failure is now carried into the running app instead. The control window
/// opens, asks `get_boot_status` before it routes anywhere, and renders
/// recovery rather than the application. The recovery commands work on files —
/// backups, the canonical Markdown tree, the data folder — and never touch the
/// damaged database.
pub enum BootStatus {
    Ready,
    /// The database could not be opened, verified or migrated. The application
    /// must not open; only recovery may.
    Failed(AppError),
}

impl BootStatus {
    pub fn is_ready(&self) -> bool {
        matches!(self, BootStatus::Ready)
    }

    /// Refuse a command that has no business running in recovery mode.
    ///
    /// The frontend gates on `get_boot_status` before it routes anywhere, and
    /// that is not enough on its own. A gate in one process's UI is a policy;
    /// this is the boundary. The specific hazard is that several commands
    /// touch the FILESYSTEM before they touch the database — `create_script`
    /// writes the canonical Markdown and then inserts the row — so a stray
    /// call in recovery mode would leave a real file on disk indexed only in a
    /// scratch database that vanishes with the process.
    pub fn require_ready(&self) -> Result<(), AppError> {
        match self {
            BootStatus::Ready => Ok(()),
            BootStatus::Failed(_) => Err(AppError::structured(
                "DATABASE_UNAVAILABLE",
                crate::errors::ErrorCategory::Storage,
                "CandidCue is in recovery mode because its database did not open, so this \
                 action is unavailable. Recover the database and reopen CandidCue.",
                true,
            )),
        }
    }

    /// The mirror image: refuse a destructive recovery action while the
    /// database is perfectly healthy.
    ///
    /// `rebuild_database_index` moves the live database into quarantine. That
    /// is the right answer to a database that will not open and the wrong
    /// answer to one that is open and being written to.
    pub fn require_recovery(&self) -> Result<(), AppError> {
        match self {
            BootStatus::Failed(_) => Ok(()),
            BootStatus::Ready => Err(AppError::invalid_input(
                "CandidCue's database is working, so there is nothing to recover. This action \
                 is only available when the app has failed to start.",
            )),
        }
    }
}

/// A scratch, in-memory database used ONLY while recovery is on screen.
///
/// Tauri's `State<'_, Database>` panics when the type was never managed, so a
/// build that failed to open its real database would panic on the first
/// command a stray effect fired — replacing a recovery screen with a crash.
/// Managing an empty in-memory pool keeps every existing command answerable.
///
/// It is safe precisely because it is empty and unreachable: nothing on disk is
/// opened, and the frontend gates on `get_boot_status` before it routes into
/// the application at all. Anything written here disappears with the process,
/// which is the correct outcome for input the user was never meant to be able
/// to give.
pub async fn in_memory_recovery_pool() -> Result<SqlitePool, AppError> {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .map_err(sqlx::Error::from)?
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// How many pre-migration snapshots to keep (spec §47.7 rotating backups).
///
/// Five MIGRATION EVENTS, which is a different quantity from what this used to
/// mean. A snapshot was taken on every launch of an existing database, so five
/// ordinary starts after an upgrade rotated away the only snapshot anyone would
/// want — the state immediately before the schema changed. Backups are now
/// taken only when something is actually pending, so five of them span five
/// schema transitions.
const MAX_PRE_MIGRATION_BACKUPS: usize = 5;

/// A database that fails its integrity check must not be migrated or written
/// to. The error preserves the on-disk evidence (the `.sqlite3`, `-wal` and
/// `-shm` files are left exactly as they are) so the user can be offered a
/// rebuild from the canonical Markdown files, which remain the authority for
/// script content (spec §48.1, §48.5).
pub fn corrupt_database_error(detail: &str) -> AppError {
    AppError::structured(
        "DATABASE_CORRUPT",
        crate::errors::ErrorCategory::Storage,
        "CandidCue's database failed its integrity check and was not modified. \
         Your script files are unaffected.",
        true,
    )
    .with_action(crate::errors::RecoveryAction::RevealFolder)
    .with_log(format!("integrity check: {detail}"))
}

/// Create the app data directory if needed, open the pool, verify integrity,
/// take a pre-migration backup, then run migrations.
pub async fn init(app_data_dir: &Path) -> Result<SqlitePool, AppError> {
    std::fs::create_dir_all(app_data_dir)?;
    let db_path = app_data_dir.join(DB_FILE_NAME);

    /*
     * A scheduled restore, before anything opens anything.
     *
     * This is the ONLY point in the process where no pool exists, which is why
     * `restore_all_data` only validates and writes a marker: replacing the
     * database file underneath an open pool does not do what it looks like it
     * does. On Unix the existing connections keep writing to the renamed
     * inode; on Windows the rename fails outright, and it fails after the
     * scripts tree has already moved.
     */
    let paths = crate::scripts::DataPaths::new(app_data_dir.to_path_buf());
    crate::backup::apply_pending_restore(&paths).await?;

    // Then: is this a database from before the 1.0 schema baseline? See
    // `quarantine_pre_baseline_database`.
    quarantine_pre_baseline_database(app_data_dir, &db_path).await?;

    let pre_existing = db_path.exists() && std::fs::metadata(&db_path).map(|m| m.len() > 0).unwrap_or(false);

    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
        .map_err(sqlx::Error::from)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;

    // Integrity BEFORE migrations. Migrations are the single most destructive
    // thing the app does to the database, and running them against a corrupt
    // file can turn a recoverable problem into an unrecoverable one — so this
    // check has to come first, not after (H7).
    let check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| format!("quick_check failed to run: {e}"));
    if check != "ok" {
        pool.close().await;
        tracing::error!(check = %check, "database failed its integrity check; refusing to migrate");
        return Err(corrupt_database_error(&check));
    }

    /*
     * A backup, only when a migration is actually about to run — and then a
     * backup that has to succeed.
     *
     * Two things were wrong here, and they pulled against each other.
     *
     * A snapshot was written on EVERY launch of an existing database, whether
     * or not anything was pending. On a busy machine that is a `VACUUM INTO`
     * of the whole database at every start, and — worse — the rotation keeps
     * only the five newest, so five ordinary launches after an upgrade would
     * discard the one snapshot anybody would ever want: the state immediately
     * before the schema changed.
     *
     * And a backup that FAILED was logged as a warning, after which the
     * migration ran anyway. A pre-migration backup exists for exactly one
     * moment — the destructive one — so proceeding without it inverts the
     * safety property it is named for.
     *
     * So: ask the migrator what is pending, and if anything is, refuse to
     * migrate unless a verified snapshot exists. Refusing to start is a real
     * cost, but it is recoverable and the user still has their data; a
     * half-applied migration over an unbacked database is neither.
     */
    let migrator = sqlx::migrate!("./migrations");

    if pre_existing {
        let pending = pending_migrations(&pool, &migrator).await?;
        if pending.is_empty() {
            tracing::debug!("no pending migrations; skipping the pre-migration backup");
        } else {
            tracing::info!(
                count = pending.len(),
                versions = ?pending,
                "pending migrations: taking a verified pre-migration backup first"
            );
            let backup = write_pre_migration_backup(&pool, app_data_dir, &pending)
                .await
                .map_err(|err| backup_required_error(&err))?;
            tracing::info!(path = %backup.display(), "pre-migration backup verified");
        }
    }

    migrator.run(&pool).await?;

    Ok(pool)
}

/// Move a pre-1.0-baseline database aside so the baseline can be applied
/// cleanly, and let startup reconciliation rebuild the index from the
/// canonical Markdown files.
///
/// ## Why this exists
///
/// The 1.0 baseline is a SQUASH: the original `0001_initial.sql` and
/// `0002_session_takes.sql` were collapsed into one file with the dead tables
/// removed. sqlx checksums each migration and refuses to run when a migration
/// it has already applied has changed — which is correct, and which would stop
/// every pre-1.0 database from opening, with an error about checksums that
/// says nothing a user could act on.
///
/// CandidCue has never been publicly released, so there is no beta-user
/// database to migrate forward. What there IS, on any machine that ran a dev
/// build, is a database whose scripts are also sitting on disk as Markdown —
/// and those files, not the database, are the authority for script content
/// (§48.1). So the safe move is to set the old database aside intact and start
/// from the baseline; `run_startup_reconciliation` then re-indexes every
/// canonical file it finds.
///
/// What is NOT recovered: session history, take history, and any retained
/// transcripts. The quarantined file still contains them, and it is never
/// deleted — this renames, it does not remove.
async fn quarantine_pre_baseline_database(
    app_data_dir: &Path,
    db_path: &Path,
) -> Result<(), AppError> {
    if !db_path.exists() {
        return Ok(());
    }

    // Open read-only and ask what has been applied. A file that cannot be
    // opened at all is not this function's problem — `init` runs the integrity
    // check and reports it properly a few lines later.
    let options = match SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display())) {
        Ok(options) => options.create_if_missing(false).read_only(true),
        Err(_) => return Ok(()),
    };
    let Ok(pool) = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
    else {
        return Ok(());
    };

    /*
     * The tell is the CHECKSUM of migration 1, compared against the exact
     * value the pre-baseline file had.
     *
     * The first version of this used "an applied migration 2" as the tell,
     * reasoning that the pre-1.0 sequence was `0001_initial` +
     * `0002_session_takes` while the baseline is version 1 alone. Two things
     * are wrong with that. It MISSES a database that only ever applied the old
     * migration 1 — which then reaches sqlx as a bare checksum-mismatch error,
     * the exact unactionable failure this function exists to prevent. And,
     * worse, the first legitimate post-1.0 migration numbered 2 would make
     * every healthy database in the world look pre-baseline and be quarantined.
     *
     * An exact checksum cannot do either. It recognises the one file that
     * existed, and recognises nothing else — so an unknown mismatch stays
     * sqlx's business rather than becoming grounds to move somebody's database.
     */
    let applied: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations")
            .fetch_all(&pool)
            .await
            .unwrap_or_default();
    pool.close().await;

    /// SHA-384 of the pre-1.0 `0001_initial.sql`, which the 1.0 baseline
    /// replaced. This is what sqlx recorded for it.
    const LEGACY_MIGRATION_1: &str = "8faf4be144c99a72b6460a0188e1986c465e58291724b36d2f0a75cdfc47ffb9cbbab0801cef31a025c6d627fd28795c";
    /// SHA-384 of the pre-1.0 `0002_session_takes.sql`, folded into the
    /// baseline. Corroborating evidence, not required: a database can have
    /// applied 1 and never reached 2.
    const LEGACY_MIGRATION_2: &str = "5878c0338feb78522c5b1c51da8758cf395885469f89e2a455705485d319a551994774bcef26efcebe700ca78a1f088c";

    let is_pre_baseline = applied.iter().any(|(version, checksum)| {
        let hex = hex::encode(checksum);
        (*version == 1 && hex == LEGACY_MIGRATION_1) || (*version == 2 && hex == LEGACY_MIGRATION_2)
    });
    if !is_pre_baseline {
        return Ok(());
    }
    let applied: Vec<i64> = applied.into_iter().map(|(version, _)| version).collect();

    let quarantine = app_data_dir.join("quarantine");
    std::fs::create_dir_all(&quarantine)?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let target = quarantine.join(format!("pre-1.0-baseline-{stamp}.sqlite3"));

    // The WAL and SHM go with it. Leaving them beside a renamed database would
    // hand the next open a write-ahead log belonging to a file that is no
    // longer there.
    for suffix in ["", "-wal", "-shm"] {
        let from = db_path.with_file_name(format!("{DB_FILE_NAME}{suffix}"));
        if from.exists() {
            let to = target.with_file_name(format!(
                "{}{suffix}",
                target.file_name().unwrap_or_default().to_string_lossy()
            ));
            std::fs::rename(&from, &to)?;
        }
    }

    std::fs::write(
        target.with_extension("json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "quarantinedAt": crate::util::now_iso(),
            "appVersion": env!("CARGO_PKG_VERSION"),
            "reason": "database predates the CandidCue 1.0 schema baseline",
            "appliedMigrations": applied,
            "recovered": "scripts, revisions and assets are rebuilt from the canonical Markdown files",
            "notRecovered": ["session history", "take history", "retained transcripts"],
        }))
        .unwrap_or_default(),
    )
    .ok();

    tracing::warn!(
        path = %target.display(),
        "database predates the 1.0 schema baseline; quarantined it and starting from the baseline. \
         Scripts will be rebuilt from their canonical files; session history is not carried over."
    );

    Ok(())
}

/// Which migrations this build has that the database has not applied.
///
/// Read from `_sqlx_migrations` rather than inferred from a version number:
/// a database can be missing a migration in the middle of the sequence (an
/// interrupted run, a restored backup), and "highest applied version" would
/// call that up to date.
async fn pending_migrations(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> Result<Vec<i64>, AppError> {
    // The table does not exist until the first migration has run. A database
    // that pre-dates it has EVERYTHING pending, which is the safe reading.
    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations")
        .fetch_all(pool)
        .await
        .unwrap_or_default();

    Ok(migrator
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .map(|migration| migration.version)
        .filter(|version| !applied.contains(version))
        .collect())
}

/// The one failure that stops CandidCue starting on purpose.
fn backup_required_error(detail: &AppError) -> AppError {
    AppError::structured(
        "DATABASE_BACKUP_REQUIRED",
        crate::errors::ErrorCategory::Storage,
        "CandidCue needs to upgrade its database, but could not first save a backup of it, \
         so it has not made any changes. This is usually a full disk or a permissions \
         problem in CandidCue's data folder. Your script files are unaffected.",
        true,
    )
    .with_action(crate::errors::RecoveryAction::RevealFolder)
    .with_log(format!("pre-migration backup failed: {detail}"))
}

/// Consistent snapshot via SQLite's own `VACUUM INTO`, which reads through the
/// WAL and produces a coherent copy without stopping the app.
///
/// Returns the path only after the copy has been opened and integrity-checked.
/// A file that exists is not a backup — `VACUUM INTO` onto a volume that fills
/// up mid-write leaves one behind — and the whole point of taking it here is
/// that the next thing to happen is destructive.
///
/// A sidecar `.json` records what the snapshot is OF: the schema it was taken
/// at, the migrations it was taken before, and the app version that took it.
/// Without that, a directory of `pre-migration-*.sqlite3` files is a set of
/// timestamps, and choosing between them during a recovery is guesswork.
async fn write_pre_migration_backup(
    pool: &SqlitePool,
    app_data_dir: &Path,
    pending: &[i64],
) -> Result<std::path::PathBuf, AppError> {
    let backups = app_data_dir.join("backups");
    std::fs::create_dir_all(&backups)?;

    let applied_high: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap_or(0);

    let target = backups.join(format!(
        "pre-migration-{}-schema{}.sqlite3",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ"),
        applied_high
    ));

    // A collision means the same millisecond and the same schema, which is a
    // re-entry rather than a second upgrade. The existing file is the backup.
    if !target.exists() {
        sqlx::query("VACUUM INTO ?")
            .bind(target.to_string_lossy().to_string())
            .execute(pool)
            .await?;
    }

    verify_backup(&target).await?;

    let manifest = serde_json::json!({
        "takenAt": crate::util::now_iso(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "schemaVersionBefore": applied_high,
        "pendingMigrations": pending,
        "sizeBytes": std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0),
    });
    // Best-effort: the snapshot is the artefact that matters, and refusing to
    // migrate because a descriptive sidecar could not be written would be a
    // worse trade than migrating without the description.
    if let Err(err) = std::fs::write(
        target.with_extension("json"),
        serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
    ) {
        tracing::warn!(error = %err, "backup written, but its manifest was not");
    }

    prune_backups(&backups);
    Ok(target)
}

/// Open the snapshot on its own and make it prove it is a database.
///
/// `VACUUM INTO` reporting success is not the same as a usable file: a volume
/// that runs out of space, or a filesystem that has not flushed, can leave a
/// truncated copy behind. This is cheap relative to a migration and it is the
/// difference between "a backup exists" and "a backup works".
async fn verify_backup(path: &Path) -> Result<(), AppError> {
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
        .map_err(sqlx::Error::from)?
        .create_if_missing(false)
        .read_only(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;

    let check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| format!("quick_check failed to run: {e}"));
    pool.close().await;

    if check != "ok" {
        // Remove it: a corrupt file under `backups/` is worse than no file,
        // because a recovery would offer it as an option.
        let _ = std::fs::remove_file(path);
        return Err(AppError::structured(
            "DATABASE_BACKUP_REQUIRED",
            crate::errors::ErrorCategory::Storage,
            "CandidCue could not verify the database backup it just wrote.",
            true,
        )
        .with_log(format!("backup quick_check: {check}")));
    }
    Ok(())
}

fn prune_backups(backups: &Path) {
    let Ok(entries) = std::fs::read_dir(backups) else {
        return;
    };
    /*
     * The SNAPSHOTS, not the sidecars.
     *
     * Each backup is two files: `pre-migration-….sqlite3` and its `.json`
     * manifest. Matching on the prefix alone counted both, so "keep five" kept
     * five FILES — about two and a half backups, and in steady state one of
     * them without its manifest.
     */
    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|path| {
            path.extension().map(|ext| ext == "sqlite3").unwrap_or(false)
                && path
                    .file_name()
                    .map(|name| name.to_string_lossy().starts_with("pre-migration-"))
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    while files.len() > MAX_PRE_MIGRATION_BACKUPS {
        let oldest = files.remove(0);
        // The manifest goes with the snapshot it describes. Leaving it behind
        // would populate `backups/` with descriptions of files that are gone,
        // which is exactly the wrong thing to hand someone mid-recovery.
        let _ = std::fs::remove_file(oldest.with_extension("json"));
        let _ = std::fs::remove_file(oldest);
    }
}
