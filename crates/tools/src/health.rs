//! M0 工具：探测分析引擎连通性。用于验证 Agent → Tool → gRPC 全链路。
//! Phase 1 后续在此 crate 增量加入 analyze_pitch / detect_notes 等工具。

use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;

use music_agent::{no_params_schema, AgentError, AgentTool};
use music_analysis_client::AnalysisEngine;

pub struct PingEngineTool {
    engine: Arc<AnalysisEngine>,
}

impl PingEngineTool {
    pub fn new(engine: Arc<AnalysisEngine>) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl AgentTool for PingEngineTool {
    fn name(&self) -> &str {
        "ping_analysis_engine"
    }

    fn description(&self) -> &str {
        "检查音乐分析引擎（Python gRPC 服务）是否在线并返回其版本。"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        no_params_schema()
    }

    async fn execute(
        &self,
        _arguments: serde_json::Value,
    ) -> Result<serde_json::Value, AgentError> {
        match self.engine.ping().await {
            Ok(resp) => Ok(json!({
                "status": "up",
                "engine": resp.engine,
                "version": resp.version,
            })),
            Err(e) => {
                // 作为工具证据返回"引擎不可用"，Agent 不得据此编造分析结果
                Ok(json!({ "status": "down", "error": e.to_string() }))
            }
        }
    }
}
