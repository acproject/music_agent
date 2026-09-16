//! AI Agent 核心：LLM Provider 抽象 + ReAct Tool-Calling 循环。
//!
//! 本 crate 不依赖具体音乐算法，只负责"理解 → 规划 → 调工具 → 教学回复"。

mod error;
mod openai;
mod provider;
mod react;
mod tool;
mod types;

pub use error::AgentError;
pub use openai::OpenAiCompatibleProvider;
pub use provider::LlmProvider;
pub use react::{ReActAgent, TEACHER_SYSTEM_PROMPT};
pub use tool::{no_params_schema, AgentTool};
pub use types::{ChatMessage, ChatRequest, ChatResponse, FinishReason, Role, ToolCall, ToolSpec};
