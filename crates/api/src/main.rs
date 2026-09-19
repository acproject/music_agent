//! AI 音乐教学系统 HTTP / WebSocket 网关（Rust 核心入口）。
//!
//! M0：/health 聚合 Python 分析引擎状态；/api/audio/stream 完成 WS 握手自检。
//! M3：/api/music/analyze 离线转谱。
//! Agent：/api/agent/chat ReAct 工具调用对话（LLM 未配置时 503 降级）。

mod routes;
mod state;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use music_agent::{LlmProvider, OpenAiCompatibleProvider};
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

    // LLM Provider：启用失败不阻断网关启动，Agent 路由降级为 503。
    let llm: Option<Arc<dyn LlmProvider>> = if config.llm.enabled() {
        match OpenAiCompatibleProvider::new(&config.llm) {
            Ok(provider) => {
                tracing::info!(
                    "llm agent enabled -> {} model={}",
                    config.llm.base_url,
                    config.llm.model
                );
                Some(Arc::new(provider))
            }
            Err(e) => {
                tracing::warn!("llm provider init failed, agent disabled: {e}");
                None
            }
        }
    } else {
        tracing::info!(
            "llm agent disabled: set LLM_API_KEY (or point LLM_BASE_URL at localhost) to enable /api/agent/chat"
        );
        None
    };

    let state = AppState {
        config: Arc::new(config.clone()),
        db,
        engine,
        llm,
    };

    let app = Router::new()
        .route("/health", get(routes::health::health))
        .route("/api/audio/stream", get(routes::ws::stream))
        .route("/api/music/analyze", post(routes::analyze::analyze))
        .route("/api/agent/chat", post(routes::agent::chat))
        .fallback(|| async {
            (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "not_found"})),
            )
        })
        .layer(DefaultBodyLimit::max(routes::analyze::body_limit()))
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
