//! ReAct 风格 Agent 循环：LLM 决策 → Tool Calling → 结构化结果回灌 → 再决策。
//!
//! 硬约束（需求第 16 节）：Agent 只能依据工具返回的结构化证据下结论，
//! 系统提示词明确禁止伪造音高/节奏等任何数值分析结果。

use std::sync::Arc;

use serde_json::Value;

use crate::types::{ChatMessage, ChatRequest, ToolSpec};
use crate::{AgentError, AgentTool, LlmProvider};

/// 系统级护栏提示：禁止伪造分析结果
pub const TEACHER_SYSTEM_PROMPT: &str = r#"你是一名严谨的 AI 音乐老师。
你只能依据工具调用返回的结构化音乐分析数据（音高、节奏、音符、偏差等）给出评价与教学建议。
严禁在没有调用对应工具、或工具未返回该数据时，编造任何具体数值、音符名、小节号或偏差。
定位问题必须引用工具证据（第几小节、第几个音、目标音 vs 实际音、偏差大小），并给出可执行的练习建议。
如果工具不可用或数据置信度过低，必须如实说明，并引导用户重新录音，而不是猜测。"#;

pub struct ReActAgent {
    provider: Arc<dyn LlmProvider>,
    tools: Vec<Arc<dyn AgentTool>>,
    system_prompt: String,
    max_iterations: u32,
}

impl ReActAgent {
    pub fn new(
        provider: Arc<dyn LlmProvider>,
        tools: Vec<Arc<dyn AgentTool>>,
        max_iterations: u32,
    ) -> Self {
        Self {
            provider,
            tools,
            system_prompt: TEACHER_SYSTEM_PROMPT.to_string(),
            max_iterations,
        }
    }

    fn tool_specs(&self) -> Vec<ToolSpec> {
        self.tools.iter().map(|t| t.spec()).collect()
    }

    fn find_tool(&self, name: &str) -> Option<Arc<dyn AgentTool>> {
        self.tools.iter().find(|t| t.name() == name).cloned()
    }

    /// 运行一个完整的推理-行动循环，直到模型给出最终自然语言回复。
    /// `history` 为不含 system 消息的会话历史，方法内部会前置 system 消息。
    pub async fn run(&self, history: Vec<ChatMessage>) -> Result<ChatMessage, AgentError> {
        let mut messages = Vec::with_capacity(history.len() + 8);
        messages.push(ChatMessage::system(self.system_prompt.clone()));
        messages.extend(history);

        for iteration in 0..self.max_iterations {
            let request = ChatRequest {
                // model 由 provider 自身配置决定，这里占位
                model: String::new(),
                messages: clone_messages(&messages),
                tools: self.tool_specs(),
                temperature: Some(0.2),
            };
            let response = self.provider.chat(request).await?;
            let assistant = response.message;

            if assistant.tool_calls.is_empty() {
                return Ok(assistant);
            }

            let tool_calls = assistant.tool_calls.clone();
            messages.push(assistant);

            for call in tool_calls {
                tracing::info!(
                    iteration,
                    tool = %call.name,
                    args = %call.arguments,
                    "agent tool call"
                );
                let result = match self.find_tool(&call.name) {
                    Some(tool) => tool.execute(call.arguments).await,
                    None => Err(AgentError::Tool(format!("unknown tool: {}", call.name))),
                };
                let content = match result {
                    Ok(value) => value,
                    // 工具失败信息回灌给模型，让其改道而不是假装成功
                    Err(e) => Value::String(format!("TOOL_ERROR: {e}")),
                };
                messages.push(ChatMessage::tool(
                    call.id,
                    serde_json::to_string(&content).unwrap_or_else(|_| "null".into()),
                ));
            }
        }

        Err(AgentError::MaxIterations(self.max_iterations))
    }
}

fn clone_messages(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    messages
        .iter()
        .map(|m| ChatMessage {
            role: m.role.clone(),
            content: m.content.clone(),
            tool_call_id: m.tool_call_id.clone(),
            tool_calls: m.tool_calls.clone(),
        })
        .collect()
}
