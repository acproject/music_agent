//! LLM Provider 抽象：Agent 只依赖此 trait，可在 OpenAI / Qwen / DeepSeek /
//! 本地 vLLM·Ollama（均兼容 OpenAI Chat Completions）之间切换。

use async_trait::async_trait;

use crate::types::{ChatRequest, ChatResponse};
use crate::AgentError;

#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// 提供商标识，用于日志与健康展示
    fn name(&self) -> &str;

    /// 单轮对话（含 tool_calls）。传输错误由实现负责有限次重试。
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, AgentError>;
}
