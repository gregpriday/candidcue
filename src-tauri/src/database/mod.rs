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

/// Create the app data directory if needed, open the pool, run migrations.
pub async fn init(app_data_dir: &Path) -> Result<SqlitePool, AppError> {
    std::fs::create_dir_all(app_data_dir)?;
    let db_path = app_data_dir.join(DB_FILE_NAME);

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

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}
