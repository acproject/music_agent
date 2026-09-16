//! 健康检查：上报 HTTP 网关与 Python 分析引擎状态（引擎离线不影响进程存活）。

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;

pub async fn health(State(state): State<AppState>) -> Json<Value> {
    let engine = match state.engine.ping().await {
        Ok(resp) => json!({
            "connected": true,
            "engine": resp.engine,
            "version": resp.version,
        }),
        Err(e) => json!({
            "connected": false,
            "error": e.to_string(),
        }),
    };

    Json(json!({
        "status": "ok",
        "service": "music-api",
        "version": env!("CARGO_PKG_VERSION"),
        "analysis_engine": engine,
    }))
}
