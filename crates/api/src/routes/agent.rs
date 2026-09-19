//! `POST /api/agent/chat`：AI 音乐老师对话入口。
//!
//! 一元 JSON（非流式）。每次请求携带多轮历史与可选的最近录音 PCM（base64），
//! 路由按请求构造录音上下文与音乐工具集，交给 ReActAgent 运行
//! （LLM 决策 → Tool Calling → gRPC 结构化证据 → 教学回复）。
//!
//! 安全/契约要点：
//! - LLM 未配置时返回 503 与中文配置指引，不影响其他路由；
//! - Agent 只能通过工具取得分析证据（护栏见 TEACHER_SYSTEM_PROMPT）；
//! - 消息走明确 DTO，历史最多取最近 20 条；PCM 必须是 4 字节对齐的 Float32LE。

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use music_agent::{AgentError, ChatMessage, ReActAgent, Role};
use music_tools::{request_tools, PingEngineTool};
use serde::Deserialize;
use serde_json::json;

use crate::routes::analyze::base64_decode;
use crate::state::AppState;

/// 历史消息条数上限（防超长上下文）
const MAX_MESSAGES: usize = 20;
/// PCM 原始字节上限（16kHz 单声道约 12 分钟；前端另有更严格的 18MB 截断）
const MAX_PCM_BYTES: usize = 48 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct ChatRequestDto {
    messages: Vec<MessageDto>,
    #[serde(default)]
    recording: Option<RecordingDto>,
}

#[derive(Debug, Deserialize)]
struct MessageDto {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct RecordingDto {
    #[serde(default)]
    pcm_base64: String,
    #[serde(default = "default_sample_rate")]
    sample_rate: i32,
    #[serde(default = "default_channels")]
    channels: i32,
    #[serde(default)]
    label: String,
}

fn default_sample_rate() -> i32 {
    16_000
}

fn default_channels() -> i32 {
    1
}

fn error_response(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": code, "message": message.into() }))).into_response()
}

pub async fn chat(
    State(state): State<AppState>,
    raw_body: String,
) -> Response {
    let Some(provider) = state.llm.clone() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "llm_disabled",
            "AI 老师未启用：请在 .env 配置 LLM_API_KEY（OpenAI/Qwen/DeepSeek 等 OpenAI 兼容服务），\
             或将 LLM_BASE_URL 指向本机 Ollama/vLLM 后重启网关。录音、转谱等功能不受影响。",
        );
    };

    let req: ChatRequestDto = match serde_json::from_str(&raw_body) {
        Ok(dto) => dto,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "bad_request",
                format!("请求体不是合法 JSON 或字段缺失: {e}"),
            )
        }
    };

    // ---- 消息历史校验与转换 ----
    if req.messages.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "bad_request", "messages 不能为空");
    }
    let mut history: Vec<ChatMessage> = Vec::with_capacity(req.messages.len());
    for m in &req.messages {
        let role = match m.role.as_str() {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            other => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "bad_request",
                    format!("不支持的消息角色: {other}（仅允许 user/assistant）"),
                )
            }
        };
        if m.content.trim().is_empty() {
            return error_response(StatusCode::BAD_REQUEST, "bad_request", "消息内容不能为空");
        }
        history.push(ChatMessage {
            role,
            content: Some(m.content.clone()),
            tool_call_id: None,
            tool_calls: vec![],
        });
    }
    // 仅保留最近 MAX_MESSAGES 条
    if history.len() > MAX_MESSAGES {
        history.drain(0..history.len() - MAX_MESSAGES);
    }

    // ---- 录音上下文解析 ----
    let (pcm, sample_rate, channels, label) = match req.recording {
        Some(rec) => {
            if !(8_000..=192_000).contains(&rec.sample_rate) {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "bad_pcm",
                    format!("unsupported sample_rate: {}", rec.sample_rate),
                );
            }
            let channels = rec.channels.max(1);
            let pcm = if rec.pcm_base64.trim().is_empty() {
                None
            } else {
                let Some(bytes) = base64_decode(rec.pcm_base64.trim()) else {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        "bad_pcm",
                        "pcm_base64 不是合法的标准 Base64",
                    );
                };
                if bytes.len() % 4 != 0 {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        "bad_pcm",
                        "PCM 字节数必须是 4 的倍数（Float32LE）",
                    );
                }
                if bytes.len() > MAX_PCM_BYTES {
                    return error_response(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "pcm_too_large",
                        format!("录音过大（上限 {} 字节），请分段录音", MAX_PCM_BYTES),
                    );
                }
                Some(bytes)
            };
            (pcm, rec.sample_rate, channels, rec.label)
        }
        None => (None, 16_000, 1, String::new()),
    };

    // ---- 请求级工具装配：ping + 录音五件套（共享一次引擎分析缓存）----
    let (_, mut tools) =
        request_tools(state.engine.clone(), pcm, sample_rate, channels, label);
    tools.insert(0, Arc::new(PingEngineTool::new(state.engine.clone())));

    let agent = ReActAgent::new(provider, tools, state.config.agent.max_iterations);
    match agent.run(history).await {
        Ok(reply) => Json(json!({
            "reply": reply.content.unwrap_or_default(),
            "model": state.config.llm.model,
        }))
        .into_response(),
        Err(e) => map_agent_error(e),
    }
}

fn map_agent_error(e: AgentError) -> Response {
    match e {
        AgentError::Status { status, body } => error_response(
            StatusCode::BAD_GATEWAY,
            "llm_status_error",
            format!("LLM 服务返回 HTTP {status}: {body}"),
        ),
        AgentError::Http(inner) => error_response(
            StatusCode::BAD_GATEWAY,
            "llm_unavailable",
            format!("无法连接 LLM 服务: {inner}"),
        ),
        AgentError::Parse(detail) => error_response(
            StatusCode::BAD_GATEWAY,
            "llm_bad_response",
            format!("LLM 响应无法解析: {detail}"),
        ),
        AgentError::Config(detail) => {
            error_response(StatusCode::SERVICE_UNAVAILABLE, "llm_config_error", detail)
        }
        AgentError::Tool(detail) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "tool_error",
            format!("工具执行异常: {detail}"),
        ),
        AgentError::MaxIterations(n) => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "agent_max_iterations",
            format!("Agent 在 {n} 轮工具调用内未得出结论，请简化问题后重试"),
        ),
    }
}
