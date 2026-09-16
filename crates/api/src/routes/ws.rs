//! WebSocket 实时音频通道：浏览器 PCM 帧 ↔ Python 分析引擎 gRPC 双向流。
//!
//! 协议（文本帧为 JSON，二进制帧为 Float32LE PCM）：
//!   C→S  hello {sample_rate, channels, mode}   audio(binary)   stop   ping
//!   S→C  ready {session_id, ...}  pitch/note/beat...（MusicEvent 扁平化）
//!        stopped   pong   error{code,message,retriable}
//!
//! M1 只做零拷贝转发与事件回流，Rust 不解析音频内容；
//! 电平/静音检测等即时反馈在浏览器本地完成，避免无谓往返。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use music_domain::v1::AudioChunk;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::routes::out_events::music_event_json;
use crate::state::AppState;

/// gRPC 发送阻塞时单个帧最多等待的时间，超时丢帧以保证实时性
const SEND_TIMEOUT: Duration = Duration::from_millis(100);

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

fn new_session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("s-{nanos:x}-{n}")
}

struct SessionBridge {
    /// 向分析引擎发送音频块
    engine_tx: mpsc::Sender<AudioChunk>,
    /// 事件回流任务句柄
    pump: JoinHandle<()>,
    session_id: String,
}

pub async fn stream(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // 统一出站通道：主循环与引擎事件 pump 都写入这里，由 writer 独占 WS 发送端
    let (out_tx, mut out_rx) = mpsc::channel::<String>(128);
    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if ws_tx
                .send(Message::Text(Utf8Bytes::from(text)))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let mut bridge: Option<SessionBridge> = None;
    let mut seq: i64 = 0;
    let mut dropped_frames: u64 = 0;

    macro_rules! send_out {
        ($value:expr) => {
            if out_tx.send($value.to_string()).await.is_err() {
                break;
            }
        };
    }

    while let Some(msg) = ws_rx.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!("websocket read error: {e}");
                break;
            }
        };

        match msg {
            Message::Text(text) => {
                let value: Value = match serde_json::from_str(text.as_str()) {
                    Ok(v) => v,
                    Err(e) => {
                        send_out!(json!({"type":"error","code":"bad_json","message":e.to_string(),"retriable":false}));
                        continue;
                    }
                };

                let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "hello" => {
                        if bridge.is_some() {
                            send_out!(json!({"type":"error","code":"already_started","message":"session already established","retriable":false}));
                            continue;
                        }

                        let sample_rate = value
                            .get("sample_rate")
                            .and_then(Value::as_u64)
                            .unwrap_or(16_000) as i32;
                        let channels =
                            value.get("channels").and_then(Value::as_u64).unwrap_or(1) as i32;
                        let mode = value
                            .get("mode")
                            .and_then(Value::as_str)
                            .unwrap_or("streaming");

                        // 建立到 Python 引擎的 gRPC 双向流（懒连接，此处真正建连）
                        let audio_stream = match state.engine.stream_audio(128).await {
                            Ok(s) => s,
                            Err(e) => {
                                tracing::warn!("engine stream open failed: {e}");
                                send_out!(json!({
                                    "type":"error",
                                    "code":"engine_unavailable",
                                    "message": format!("analysis engine unavailable: {e}"),
                                    "retriable": true,
                                }));
                                break;
                            }
                        };

                        let session_id = new_session_id();
                        let mut event_rx = audio_stream.rx;
                        let pump_out = out_tx.clone();
                        let pump = tokio::spawn(async move {
                            while let Some(item) = event_rx.next().await {
                                match item {
                                    Ok(event) => {
                                        if pump_out
                                            .send(music_event_json(&event).to_string())
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    Err(status) => {
                                        tracing::warn!("engine stream rpc error: {status}");
                                        let _ = pump_out
                                            .send(
                                                json!({
                                                    "type":"error",
                                                    "code":"engine_rpc_error",
                                                    "message": status.message().to_string(),
                                                    "retriable": true,
                                                })
                                                .to_string(),
                                            )
                                            .await;
                                        break;
                                    }
                                }
                            }
                        });

                        bridge = Some(SessionBridge {
                            engine_tx: audio_stream.tx,
                            pump,
                            session_id: session_id.clone(),
                        });
                        seq = 0;
                        dropped_frames = 0;

                        tracing::info!(%session_id, sample_rate, channels, mode, "audio session opened");
                        send_out!(json!({
                            "type":"ready",
                            "session_id": session_id,
                            "sample_rate": sample_rate,
                            "channels": channels,
                            "mode": mode,
                        }));
                    }
                    "stop" => {
                        if let Some(b) = bridge.take() {
                            // 显式结束：发 final 帧，等待引擎收尾，停止 pump
                            let final_chunk = AudioChunk {
                                session_id: b.session_id.clone(),
                                sample_rate: 16_000,
                                channels: 1,
                                pcm_f32le: Vec::new(),
                                seq,
                                r#final: true,
                            };
                            let _ = tokio::time::timeout(
                                SEND_TIMEOUT,
                                b.engine_tx.send(final_chunk),
                            )
                            .await;
                            drop(b.engine_tx);
                            let _ = tokio::time::timeout(Duration::from_secs(1), b.pump).await;
                            tracing::info!(
                                "audio session closed: {} frames sent, {dropped_frames} dropped",
                                seq
                            );
                        }
                        send_out!(json!({"type":"stopped"}));
                        break;
                    }
                    "ping" => {
                        send_out!(json!({"type":"pong"}));
                    }
                    other => {
                        send_out!(json!({
                            "type":"error",
                            "code":"unknown_message_type",
                            "message": format!("unsupported type: {other}"),
                            "retriable": false,
                        }));
                    }
                }
            }
            Message::Binary(pcm) => {
                let Some(b) = bridge.as_ref() else {
                    send_out!(json!({
                        "type":"error",
                        "code":"not_ready",
                        "message":"send hello before audio frames",
                        "retriable": false,
                    }));
                    continue;
                };

                let chunk = AudioChunk {
                    session_id: b.session_id.clone(),
                    sample_rate: 16_000,
                    channels: 1,
                    pcm_f32le: pcm.to_vec(),
                    seq,
                    r#final: false,
                };
                seq += 1;

                // 背压保护：实时链路宁可丢帧也不阻塞浏览器
                match tokio::time::timeout(SEND_TIMEOUT, b.engine_tx.send(chunk)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => {
                        tracing::warn!("engine receiver gone, closing session");
                        break;
                    }
                    Err(_) => {
                        dropped_frames += 1;
                        if dropped_frames == 1 || dropped_frames % 50 == 0 {
                            tracing::warn!("engine send queue full, dropped frames: {dropped_frames}");
                        }
                    }
                }
            }
            Message::Close(_) => break,
            Message::Pong(_) | Message::Ping(_) => {}
        }
    }

    // 连接结束：尽力发一个 final 帧并回收 pump
    if let Some(b) = bridge.take() {
        let final_chunk = AudioChunk {
            session_id: b.session_id.clone(),
            sample_rate: 16_000,
            channels: 1,
            pcm_f32le: Vec::new(),
            seq,
            r#final: true,
        };
        let _ = tokio::time::timeout(SEND_TIMEOUT, b.engine_tx.send(final_chunk)).await;
        drop(b.engine_tx);
        let _ = tokio::time::timeout(Duration::from_secs(1), b.pump).await;
    }

    drop(out_tx);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
}
