//! 离线高质量分析：`POST /api/music/analyze`。
//!
//! 请求体为原始 Float32LE PCM（application/octet-stream），查询参数：
//!   sample_rate  默认 16000
//!   channels     默认 1（>1 时引擎下混）
//!   pipeline     逗号分隔，默认 "notes,midi"；可选 pitch / notes / midi
//!
//! 响应 JSON：
//!   { recording_id, sequence{notes,total_duration,bpm,key,time_signature},
//!     events[扁平化 MusicEvent], midi_base64? }
//!
//! 实时链路仍走 /api/audio/stream；两条链路绝不混用（events.proto 全局约定）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use music_analysis_client::EngineError;
use music_domain::v1::AnalyzeAudioRequest;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routes::out_events::music_event_json;
use crate::state::AppState;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

const MAX_UPLOAD_MB: usize = 64;

#[derive(Debug, Deserialize)]
pub struct AnalyzeQuery {
    sample_rate: Option<i32>,
    channels: Option<i32>,
    pipeline: Option<String>,
}

/// axum 默认 body 上限 2MB（16k Float32 仅约 32s），此处放宽到 64MB。
pub fn body_limit() -> usize {
    MAX_UPLOAD_MB * 1024 * 1024
}

fn new_recording_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("r-{nanos:x}-{n}")
}

fn error_response(status: StatusCode, code: &str, message: String) -> Response {
    (status, Json(json!({"error": code, "message": message}))).into_response()
}

const B64_TABLE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 Base64（带填充）。MIDI 体积小，内联编码器避免再引一个三方依赖。
fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map(u32::from);
        let b2 = chunk.get(2).copied().map(u32::from);
        let triple = (b0 << 16) | (b1.unwrap_or(0) << 8) | b2.unwrap_or(0);
        out.push(B64_TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(B64_TABLE[((triple >> 12) & 0x3F) as usize] as char);
        out.push(
            b1.map(|_| B64_TABLE[((triple >> 6) & 0x3F) as usize] as char)
                .unwrap_or('='),
        );
        out.push(
            b2.map(|_| B64_TABLE[(triple & 0x3F) as usize] as char)
                .unwrap_or('='),
        );
    }
    out
}

pub async fn analyze(
    State(state): State<AppState>,
    Query(query): Query<AnalyzeQuery>,
    body: Bytes,
) -> Response {
    if body.is_empty() || body.len() % 4 != 0 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "bad_pcm",
            "body must be non-empty Float32LE PCM (byte length multiple of 4)".to_string(),
        );
    }

    let sample_rate = query.sample_rate.unwrap_or(16_000);
    if !(8_000..=192_000).contains(&sample_rate) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "bad_sample_rate",
            format!("unsupported sample_rate: {sample_rate}"),
        );
    }
    let channels = query.channels.unwrap_or(1).max(1);
    let pipeline: Vec<String> = query
        .pipeline
        .unwrap_or_else(|| "notes,midi".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let request = AnalyzeAudioRequest {
        recording_id: new_recording_id(),
        pcm_f32le: body.to_vec(),
        sample_rate,
        channels,
        pipeline,
    };

    let resp = match state.engine.analyze_audio(request).await {
        Ok(resp) => resp,
        Err(EngineError::Rpc(status)) => {
            let code = match status.code() {
                tonic::Code::InvalidArgument => StatusCode::BAD_REQUEST,
                tonic::Code::Unimplemented => StatusCode::NOT_IMPLEMENTED,
                tonic::Code::Unavailable | tonic::Code::Cancelled => StatusCode::BAD_GATEWAY,
                tonic::Code::DeadlineExceeded => StatusCode::GATEWAY_TIMEOUT,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            return error_response(code, "engine_rpc_error", status.message().to_string());
        }
        Err(e @ (EngineError::Timeout(_) | EngineError::Transport(_) | EngineError::InvalidEndpoint(_))) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "engine_unavailable",
                e.to_string(),
            );
        }
    };

    let seq = resp.sequence.unwrap_or_default();

    let notes: Vec<Value> = seq
        .notes
        .iter()
        .map(|n| {
            json!({
                "midi": n.midi,
                "cents_offset": n.cents_offset,
                "onset": n.onset,
                "duration": n.duration,
                "velocity": n.velocity,
                "confidence": n.confidence,
            })
        })
        .collect();

    let events: Vec<Value> = resp.events.iter().map(music_event_json).collect();

    let mut payload = json!({
        "recording_id": resp.recording_id,
        "sequence": {
            "notes": notes,
            "total_duration": seq.total_duration,
            "bpm": seq.bpm,
            "key": seq.key,
            "time_signature": seq.time_signature,
        },
        "events": events,
    });
    if !resp.midi.is_empty() {
        payload
            .as_object_mut()
            .expect("json object")
            .insert("midi_base64".to_string(), json!(base64_encode(&resp.midi)));
    }

    Json(payload).into_response()
}
