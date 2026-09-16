//! 共享应用状态。

use music_analysis_client::AnalysisEngine;
use music_config::AppConfig;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
#[allow(dead_code)] // config/db 为 M1+ 路由预留
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub db: SqlitePool,
    pub engine: Arc<AnalysisEngine>,
}
