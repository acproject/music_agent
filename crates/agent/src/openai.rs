//! OpenAI 兼容 Chat Completions Provider。
//!
//! 经 `base_url` 配置即可对接：OpenAI、Qwen DashScope（兼容模式）、
//! DeepSeek、vLLM、Ollama、llama.cpp 等。支持超时、有限重试与显式代理。

use async_trait::async_trait;
use music_config::LlmConfig;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

use crate::types::{ChatMessage, ChatRequest, ChatResponse, FinishReason, Role};
use crate::{AgentError, LlmProvider};

pub struct OpenAiCompatibleProvider {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
    max_retries: u32,
}

impl OpenAiCompatibleProvider {
    pub fn new(cfg: &LlmConfig) -> Result<Self, AgentError> {
        let mut builder = reqwest::Client::builder().timeout(cfg.timeout);
        if let Some(proxy_url) = &cfg.proxy_url {
            builder = builder.proxy(reqwest::Proxy::all(proxy_url).map_err(|e| {
                AgentError::Config(format!("invalid LLM_PROXY_URL {proxy_url}: {e}"))
            })?);
        }
        let http = builder.build()?;
        Ok(Self {
            http,
            base_url: cfg.base_url.trim_end_matches('/').to_string(),
            api_key: cfg.api_key.clone(),
            model: cfg.model.clone(),
            max_retries: cfg.max_retries,
        })
    }

    /// 带有限指数退避的重试。仅对网络错误 / 429 / 5xx 重试；
    /// 4xx（鉴权、参数错误）立即失败，避免放大错误请求。
    async fn post_with_retry(&self, body: Value) -> Result<Value, AgentError> {
        let mut attempt: u32 = 0;
        loop {
            let mut req = self
                .http
                .post(format!("{}/chat/completions", self.base_url))
                .json(&body);
            if !self.api_key.is_empty() {
                req = req.bearer_auth(&self.api_key);
            }

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        return Ok(resp.json::<Value>().await?);
                    }
                    let code = status.as_u16();
                    let text = resp.text().await.unwrap_or_default();
                    if code == 429 || (500..600).contains(&code) {
                        if attempt < self.max_retries {
                            Self::backoff(attempt).await;
                            attempt += 1;
                            continue;
                        }
                    }
                    return Err(AgentError::Status {
                        status: code,
                        body: truncate(&text, 500),
                    });
                }
                Err(e) => {
                    if attempt < self.max_retries {
                        tracing::warn!(error = %e, attempt, "LLM request failed, retrying");
                        Self::backoff(attempt).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(AgentError::Http(e));
                }
            }
        }
    }

    async fn backoff(attempt: u32) {
        tokio::time::sleep(Duration::from_millis(200u64 * 2u64.pow(attempt))).await;
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatibleProvider {
    fn name(&self) -> &str {
        "openai-compatible"
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, AgentError> {
        // model 以 provider 自身配置为准（请求未显式指定时）
        let model = if request.model.is_empty() {
            self.model.clone()
        } else {
            request.model
        };
        let body = serde_json::json!({
            "model": model,
            "messages": request.messages,
            "tools": request.tools.iter().map(|t| serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            })).collect::<Vec<_>>(),
            "temperature": request.temperature,
        });

        let raw = self.post_with_retry(body).await?;
        parse_completion(&raw)
    }
}

fn parse_completion(raw: &Value) -> Result<ChatResponse, AgentError> {
    let message_raw = raw
        .pointer("/choices/0/message")
        .ok_or_else(|| AgentError::Parse("missing choices[0].message".into()))?;

    #[derive(Deserialize)]
    struct WireFunction {
        name: String,
        arguments: String,
    }
    #[derive(Deserialize)]
    struct WireToolCall {
        id: String,
        function: WireFunction,
    }
    #[derive(Deserialize)]
    struct WireMessage {
        #[serde(default)]
        content: Option<String>,
        #[serde(default)]
        tool_calls: Option<Vec<WireToolCall>>,
    }

    let wire: WireMessage =
        serde_json::from_value(message_raw.clone()).map_err(|e| AgentError::Parse(e.to_string()))?;

    let tool_calls = wire
        .tool_calls
        .unwrap_or_default()
        .into_iter()
        .map(|tc| -> Result<crate::types::ToolCall, AgentError> {
            let arguments = if tc.function.arguments.trim().is_empty() {
                Value::Null
            } else {
                serde_json::from_str::<Value>(&tc.function.arguments).map_err(|e| {
                    AgentError::Parse(format!(
                        "tool {} arguments is not valid JSON: {e}",
                        tc.function.name
                    ))
                })?
            };
            Ok(crate::types::ToolCall {
                id: tc.id,
                name: tc.function.name,
                arguments,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let finish_reason = raw
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        .map(|s| match s {
            "stop" => FinishReason::Stop,
            "tool_calls" | "function_call" => FinishReason::ToolCalls,
            "length" => FinishReason::Length,
            other => FinishReason::Other(other.to_string()),
        })
        .unwrap_or_default();

    Ok(ChatResponse {
        message: ChatMessage {
            role: Role::Assistant,
            content: wire.content,
            tool_call_id: None,
            tool_calls,
        },
        finish_reason,
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}
