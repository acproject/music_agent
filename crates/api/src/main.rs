//! AI 音乐教学系统 HTTP / WebSocket 网关（Rust 核心入口）。
//!
//! M0：/health 聚合 Python 分析引擎状态；/api/audio/stream 完成 WS 握手自检。
//! 后续：REST 音乐分析接口、Agent SSE 对话、音频会话持久化在此挂载。

mod routes;
mod state;

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use music_analysis_client::AnalysisEngine;
use music_config::AppConfig;
use serde_json::json;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    let config = AppConfig::from_env();

    init_tracing(&config.log);

    // 运行时目录（SQLite 父目录由 storage 层创建）
    std::fs::create_dir_all(&config.storage.audio_dir)?;

    let db = music_storage::connect(&config.storage.database_url).await?;

    let engine = Arc::new(AnalysisEngine::new(
        &config.analysis.grpc_url,
        config.analysis.timeout,
        config.analysis.max_retries,
    )?);
    tracing::info!("analysis engine client -> {}", config.analysis.grpc_url);

    let state = AppState {
        config: Arc::new(config.clone()),
        db,
        engine,
    };

    let app = Router::new()
        .route("/health", get(routes::health::health))
        .route("/api/audio/stream", get(routes::ws::stream))
        .fallback(|| async {
            (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "not_found"})),
            )
        })
        .with_state(state);

    let addr = config.http.bind_addr();
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("music-api listening on http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // 给连接留出一点排空时间
    tokio::time::sleep(Duration::from_millis(100)).await;
    Ok(())
}

fn init_tracing(filter: &str) {
    use tracing_subscriber::{fmt, EnvFilter};
    let env_filter = EnvFilter::try_new(filter).unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(env_filter).init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
