//! SQLite 元数据存储。大文件（音频/MIDI）走文件存储，这里只存路径与结构化结果。

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, StorageError>;

/// 连接 SQLite（必要时创建父目录）并执行嵌入式迁移。
///
/// `url` 形如 `sqlite://data/music.db?mode=rwc`。
pub async fn connect(url: &str) -> Result<SqlitePool> {
    // 确保 SQLite 文件父目录存在（文件存储目录由 api 层负责创建）
    if let Some(path) = sqlite_file_path(url) {
        if let Some(parent) = Path::new(&path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
    }

    let options = SqliteConnectOptions::from_str(url)?.create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("sqlite migrations applied ({url})");
    Ok(pool)
}

/// 从 sqlx 连接串中提取文件路径（内存库/无名库返回 None）。
fn sqlite_file_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("sqlite://")?;
    let path = rest.split('?').next().unwrap_or("");
    if path.is_empty() || path == ":memory:" {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_file_path() {
        assert_eq!(
            sqlite_file_path("sqlite://data/music.db?mode=rwc").as_deref(),
            Some("data/music.db")
        );
        assert_eq!(sqlite_file_path("sqlite://:memory:"), None);
    }
}
