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

/// How many pre-migration snapshots to keep (spec §47.7 rotating backups).
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

    if pre_existing {
        if let Err(err) = write_pre_migration_backup(&pool, app_data_dir).await {
            // A backup that cannot be written is worth knowing about, but it
            // is not itself a reason to refuse to start.
            tracing::warn!(error = %err, "could not write a pre-migration database backup");
        }
    }

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

/// Consistent snapshot via SQLite's own `VACUUM INTO`, which reads through the
/// WAL and produces a coherent copy without stopping the app.
async fn write_pre_migration_backup(pool: &SqlitePool, app_data_dir: &Path) -> Result<(), AppError> {
    let backups = app_data_dir.join("backups");
    std::fs::create_dir_all(&backups)?;
    let target = backups.join(format!(
        "pre-migration-{}.sqlite3",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ")
    ));
    if target.exists() {
        return Ok(());
    }
    sqlx::query("VACUUM INTO ?")
        .bind(target.to_string_lossy().to_string())
        .execute(pool)
        .await?;
    prune_backups(&backups);
    Ok(())
}

fn prune_backups(backups: &Path) {
    let Ok(entries) = std::fs::read_dir(backups) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("pre-migration-")
        })
        .map(|e| e.path())
        .collect();
    files.sort();
    while files.len() > MAX_PRE_MIGRATION_BACKUPS {
        let oldest = files.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
}
