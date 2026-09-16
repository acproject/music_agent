//! Agent 可调用工具的抽象。具体音乐工具在 `music-tools` crate 中实现，
//! 避免 Agent 核心与分析引擎/数据库直接耦合。

use async_trait::async_trait;
use serde_json::Value;

use crate::types::ToolSpec;
use crate::AgentError;

#[async_trait]
pub trait AgentTool: Send + Sync {
    /// 工具名（同时作为 LLM function name，需稳定且唯一）
    fn name(&self) -> &str;

    /// 给 LLM 的用途说明
    fn description(&self) -> &str;

    /// 入参 JSON Schema（无参数时返回空 object schema）
    fn parameters_schema(&self) -> Value;

    /// 执行工具。返回结构化 JSON 证据，供 Agent 引用；不得返回自然语言"猜测"。
    async fn execute(&self, arguments: Value) -> Result<Value, AgentError>;

    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name().to_string(),
            description: self.description().to_string(),
            parameters: self.parameters_schema(),
        }
    }
}

/// 无入参工具通用 schema
pub fn no_params_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}
