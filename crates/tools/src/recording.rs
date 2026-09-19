//! 请求级录音上下文与音乐分析工具集。
//!
//! 设计约束（prompt.md 第 16 节）：Agent 只能通过这些工具取得音乐分析证据，
//! 不允许伪造任何数值。工具的证据来源只有两条：
//!   1. 请求携带的录音元数据（label / 时长）；
//!   2. 对 Python 分析引擎的真实 gRPC 调用（AnalyzeAudio）。
//!
//! 一次 Agent 运行内多个分析工具共享同一次引擎调用（RecordingContext 缓存），
//! 模型连续调用 analyze_pitch / analyze_rhythm / transcribe_music 不会重复跑引擎。
//! 无录音或引擎不可用时，工具返回结构化 status 证据（而非报错文本），
//! Agent 必须据此如实告知用户、引导重录，不能编造结果。

use std::sync::Arc;

use async_trait::async_trait;
use music_analysis_client::AnalysisEngine;
use music_domain::v1::{
    music_event::Payload, AnalyzeAudioRequest, AnalyzeAudioResponse,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use music_agent::{no_params_schema, AgentError, AgentTool};

/// 分析管线固定为"音符 + MIDI + 节奏"：一次调用覆盖全部四个分析工具的视图。
const PIPELINE: [&str; 3] = ["notes", "midi", "rhythm"];

/// 工具取证据失败的原因（最终以 JSON 证据返回给模型）。
#[derive(Debug)]
pub enum EvidenceError {
    /// 本次对话没有携带任何录音
    NoRecording,
    /// 分析引擎不可用或调用失败
    EngineDown(String),
}

/// 一次聊天请求内共享的录音上下文（请求结束即释放，不做服务端持久化）。
pub struct RecordingContext {
    engine: Arc<AnalysisEngine>,
    pcm: Option<Vec<u8>>,
    sample_rate: i32,
    channels: i32,
    label: String,
    cache: Mutex<Option<Arc<AnalyzeAudioResponse>>>,
}

impl RecordingContext {
    pub fn new(
        engine: Arc<AnalysisEngine>,
        pcm: Option<Vec<u8>>,
        sample_rate: i32,
        channels: i32,
        label: String,
    ) -> Self {
        Self {
            engine,
            pcm,
            sample_rate,
            channels,
            label,
            cache: Mutex::new(None),
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// 录音时长（秒）；无 PCM 时为 None。
    pub fn duration_sec(&self) -> Option<f64> {
        let bytes = self.pcm.as_ref()?.len();
        if self.sample_rate <= 0 {
            return None;
        }
        Some(bytes as f64 / 4.0 / self.sample_rate as f64)
    }

    fn recording_info(&self) -> Value {
        json!({
            "status": "ok",
            "label": self.label,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "duration_sec": self.duration_sec().map(|d| (d * 100.0).round() / 100.0),
            "analyzable": self.pcm.is_some(),
        })
    }

    /// 取（必要时真实发起）整段分析结果；同请求内只调用一次引擎。
    async fn ensure_analysis(&self) -> Result<Arc<AnalyzeAudioResponse>, EvidenceError> {
        {
            let guard = self.cache.lock().await;
            if let Some(cached) = guard.as_ref() {
                return Ok(Arc::clone(cached));
            }
        }

        let pcm = self.pcm.as_ref().ok_or(EvidenceError::NoRecording)?;
        let request = AnalyzeAudioRequest {
            recording_id: String::new(),
            pcm_f32le: pcm.clone(),
            sample_rate: self.sample_rate,
            channels: self.channels,
            pipeline: PIPELINE.iter().map(|s| (*s).to_string()).collect(),
        };
        let resp = self
            .engine
            .analyze_audio(request)
            .await
            .map_err(|e| EvidenceError::EngineDown(e.to_string()))?;

        let shared = Arc::new(resp);
        *self.cache.lock().await = Some(Arc::clone(&shared));
        Ok(shared)
    }

    /// 分析类工具统一入口：成功走投影，失败回结构化证据。
    async fn project<F>(&self, f: F) -> Value
    where
        F: FnOnce(&AnalyzeAudioResponse) -> Value,
    {
        match self.ensure_analysis().await {
            Ok(resp) => f(&resp),
            Err(EvidenceError::NoRecording) => json!({
                "status": "no_recording",
                "message": "当前对话没有携带可分析的录音。请引导用户先录音或使用合成测试音完成转谱，再重新提问；不要猜测任何分析数值。",
            }),
            Err(EvidenceError::EngineDown(error)) => json!({
                "status": "engine_down",
                "error": error,
                "message": "音乐分析引擎当前不可用。请如实告知用户稍后重试或检查分析服务，不要编造分析结果。",
            }),
        }
    }
}

// ============ 纯函数投影（不触引擎，便于单测） ============

/// 音高视图：逐音 MIDI 音号 / 音分偏差 / 置信度 + 总体音准概览。
pub fn project_pitch(resp: &AnalyzeAudioResponse) -> Value {
    let seq = resp.sequence.clone().unwrap_or_default();
    let notes: Vec<Value> = seq
        .notes
        .iter()
        .map(|n| {
            json!({
                "midi": n.midi,
                "cents_offset": (n.cents_offset * 10.0).round() / 10.0,
                "onset": n.onset,
                "duration": n.duration,
                "confidence": n.confidence,
            })
        })
        .collect();
    let mean_abs_cents = if seq.notes.is_empty() {
        None
    } else {
        let sum: f64 = seq.notes.iter().map(|n| n.cents_offset.abs()).sum();
        Some((sum / seq.notes.len() as f64 * 10.0).round() / 10.0)
    };
    json!({
        "status": "ok",
        "note_count": notes.len(),
        "mean_abs_cents_offset": mean_abs_cents,
        "notes": notes,
    })
}

/// 音符分割视图：起音 / 时长 / 力度。
pub fn project_notes(resp: &AnalyzeAudioResponse) -> Value {
    let seq = resp.sequence.clone().unwrap_or_default();
    let notes: Vec<Value> = seq
        .notes
        .iter()
        .map(|n| {
            json!({
                "midi": n.midi,
                "onset": n.onset,
                "duration": n.duration,
                "velocity": n.velocity,
                "confidence": n.confidence,
            })
        })
        .collect();
    json!({
        "status": "ok",
        "note_count": notes.len(),
        "total_duration": seq.total_duration,
        "notes": notes,
    })
}

/// 节奏视图：主导速度、多段速度锚点、拍号、调性、逐拍位置。
pub fn project_rhythm(resp: &AnalyzeAudioResponse) -> Value {
    let seq = resp.sequence.clone().unwrap_or_default();
    let mut tempos: Vec<Value> = Vec::new();
    let mut beats: Vec<Value> = Vec::new();
    for ev in &resp.events {
        match ev.payload.as_ref() {
            Some(Payload::Tempo(t)) => tempos.push(json!({
                "time_sec": t.time,
                "bpm": (t.bpm * 10.0).round() / 10.0,
            })),
            Some(Payload::Beat(b)) => beats.push(json!({
                "onset": b.onset,
                "beat": b.beat,
                "bar": b.bar,
            })),
            _ => {}
        }
    }
    json!({
        "status": "ok",
        "dominant_bpm": seq.bpm,
        "key": seq.key,
        "time_signature": seq.time_signature,
        "tempo_segments": tempos,
        "beat_count": beats.len(),
        "beats": beats,
    })
}

/// 完整转谱摘要：不把 MIDI base64 回灌给模型，只给字节数。
pub fn project_transcription(resp: &AnalyzeAudioResponse) -> Value {
    let seq = resp.sequence.clone().unwrap_or_default();
    let tempo_count = resp
        .events
        .iter()
        .filter(|e| matches!(e.payload.as_ref(), Some(Payload::Tempo(_))))
        .count();
    json!({
        "status": "ok",
        "recording_id": resp.recording_id,
        "note_count": seq.notes.len(),
        "total_duration": seq.total_duration,
        "dominant_bpm": seq.bpm,
        "key": seq.key,
        "time_signature": seq.time_signature,
        "tempo_segments": tempo_count,
        "midi_bytes": resp.midi.len(),
    })
}

// ============ 工具定义 ============

/// get_current_recording：只查元数据，不触发引擎。
pub struct GetCurrentRecordingTool {
    ctx: Arc<RecordingContext>,
}

impl GetCurrentRecordingTool {
    pub fn new(ctx: Arc<RecordingContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl AgentTool for GetCurrentRecordingTool {
    fn name(&self) -> &str {
        "get_current_recording"
    }

    fn description(&self) -> &str {
        "查看当前对话携带的录音信息（名称、时长、采样率）。回答与用户录音相关的问题前应先调用，确认确实存在可分析的录音。"
    }

    fn parameters_schema(&self) -> Value {
        no_params_schema()
    }

    async fn execute(&self, _arguments: Value) -> Result<Value, AgentError> {
        Ok(self.ctx.recording_info())
    }
}

/// analyze_pitch：逐音音高与音分偏差证据。
pub struct AnalyzePitchTool {
    ctx: Arc<RecordingContext>,
}

impl AnalyzePitchTool {
    pub fn new(ctx: Arc<RecordingContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl AgentTool for AnalyzePitchTool {
    fn name(&self) -> &str {
        "analyze_pitch"
    }

    fn description(&self) -> &str {
        "对当前录音做音高分析，返回每个音的 MIDI 音号、相对十二平均律的音分偏差(cents)、起音时间与置信度，以及全曲平均绝对音分偏差。评价音准/跑调/唱高唱低时必须调用本工具，不得凭空给数值。"
    }

    fn parameters_schema(&self) -> Value {
        no_params_schema()
    }

    async fn execute(&self, _arguments: Value) -> Result<Value, AgentError> {
        Ok(self.ctx.project(project_pitch).await)
    }
}

/// detect_notes：音符分割证据。
pub struct DetectNotesTool {
    ctx: Arc<RecordingContext>,
}

impl DetectNotesTool {
    pub fn new(ctx: Arc<RecordingContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl AgentTool for DetectNotesTool {
    fn name(&self) -> &str {
        "detect_notes"
    }

    fn description(&self) -> &str {
        "对当前录音做音符分割，返回音符数量、总时长及每个音的起音/时长/力度/置信度。讨论唱了哪些音、音的长短、漏音多音时调用。"
    }

    fn parameters_schema(&self) -> Value {
        no_params_schema()
    }

    async fn execute(&self, _arguments: Value) -> Result<Value, AgentError> {
        Ok(self.ctx.project(project_notes).await)
    }
}

/// analyze_rhythm：速度/节拍/调性证据。
pub struct AnalyzeRhythmTool {
    ctx: Arc<RecordingContext>,
}

impl AnalyzeRhythmTool {
    pub fn new(ctx: Arc<RecordingContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl AgentTool for AnalyzeRhythmTool {
    fn name(&self) -> &str {
        "analyze_rhythm"
    }

    fn description(&self) -> &str {
        "对当前录音做节奏分析，返回主导速度 BPM、多段速度锚点（含变速点时间）、拍号、调性及逐拍位置（小节/拍号）。评价节奏、速度、变速、拍号时必须调用本工具。"
    }

    fn parameters_schema(&self) -> Value {
        no_params_schema()
    }

    async fn execute(&self, _arguments: Value) -> Result<Value, AgentError> {
        Ok(self.ctx.project(project_rhythm).await)
    }
}

/// transcribe_music：整段转谱摘要证据。
pub struct TranscribeMusicTool {
    ctx: Arc<RecordingContext>,
}

impl TranscribeMusicTool {
    pub fn new(ctx: Arc<RecordingContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl AgentTool for TranscribeMusicTool {
    fn name(&self) -> &str {
        "transcribe_music"
    }

    fn description(&self) -> &str {
        "对当前录音做完整转谱，返回音符数、总时长、主导速度、调性、拍号、速度段数等总体摘要。用户要求整体分析/转谱或问题同时涉及音高与节奏时调用；需要某维度详细数值时再调对应专项工具。"
    }

    fn parameters_schema(&self) -> Value {
        no_params_schema()
    }

    async fn execute(&self, _arguments: Value) -> Result<Value, AgentError> {
        Ok(self.ctx.project(project_transcription).await)
    }
}

/// 构造一次聊天请求的全部音乐工具（含引擎 ping）。
pub fn request_tools(
    engine: Arc<AnalysisEngine>,
    pcm: Option<Vec<u8>>,
    sample_rate: i32,
    channels: i32,
    label: String,
) -> (
    Arc<RecordingContext>,
    Vec<Arc<dyn AgentTool>>,
) {
    let ctx = Arc::new(RecordingContext::new(engine, pcm, sample_rate, channels, label));
    let tools: Vec<Arc<dyn AgentTool>> = vec![
        Arc::new(GetCurrentRecordingTool::new(Arc::clone(&ctx))),
        Arc::new(AnalyzePitchTool::new(Arc::clone(&ctx))),
        Arc::new(DetectNotesTool::new(Arc::clone(&ctx))),
        Arc::new(AnalyzeRhythmTool::new(Arc::clone(&ctx))),
        Arc::new(TranscribeMusicTool::new(Arc::clone(&ctx))),
    ];
    (ctx, tools)
}

#[cfg(test)]
mod tests {
    use super::*;
    use music_domain::v1::{
        BeatEvent, KeyEvent, MusicEvent, NoteEvent, NoteSequence, TempoEvent,
    };

    fn sample_response() -> AnalyzeAudioResponse {
        let notes = vec![
            NoteEvent {
                midi: 60,
                cents_offset: 5.0,
                onset: 0.0,
                duration: 0.48,
                velocity: 0.8,
                confidence: 0.95,
            },
            NoteEvent {
                midi: 64,
                cents_offset: -15.0,
                onset: 0.5,
                duration: 0.48,
                velocity: 0.75,
                confidence: 0.9,
            },
        ];
        let events = vec![
            MusicEvent {
                session_id: String::new(),
                timestamp: 0.0,
                source: 0,
                payload: Some(Payload::Tempo(TempoEvent {
                    time: 0.0,
                    bpm: 120.0,
                })),
            },
            MusicEvent {
                session_id: String::new(),
                timestamp: 0.0,
                source: 0,
                payload: Some(Payload::Tempo(TempoEvent {
                    time: 3.0,
                    bpm: 91.0,
                })),
            },
            MusicEvent {
                session_id: String::new(),
                timestamp: 0.0,
                source: 0,
                payload: Some(Payload::Beat(BeatEvent {
                    onset: 0.0,
                    beat: 1,
                    bar: 1,
                    bpm: 120.0,
                    timing_error_ms: 0.0,
                })),
            },
            MusicEvent {
                session_id: String::new(),
                timestamp: 0.0,
                source: 0,
                payload: Some(Payload::Key(KeyEvent {
                    time: 0.0,
                    tonality: "C major".to_string(),
                    tonic_midi: 60,
                    confidence: 0.8,
                })),
            },
        ];
        AnalyzeAudioResponse {
            recording_id: "r-test".to_string(),
            sequence: Some(NoteSequence {
                notes,
                total_duration: 8.0,
                bpm: 91,
                key: "C major".to_string(),
                time_signature: "4/4".to_string(),
            }),
            events,
            midi: vec![0x4d, 0x54, 0x68, 0x64],
        }
    }

    #[test]
    fn pitch_projection_has_evidence_fields() {
        let v = project_pitch(&sample_response());
        assert_eq!(v["status"], "ok");
        assert_eq!(v["note_count"], 2);
        assert_eq!(v["notes"][0]["midi"], 60);
        assert_eq!(v["notes"][1]["cents_offset"], -15.0);
        // |5| 与 |-15| 的平均
        assert_eq!(v["mean_abs_cents_offset"], 10.0);
    }

    #[test]
    fn notes_projection_lists_segmentation() {
        let v = project_notes(&sample_response());
        assert_eq!(v["note_count"], 2);
        assert_eq!(v["total_duration"], 8.0);
        assert_eq!(v["notes"][0]["velocity"], 0.8);
    }

    #[test]
    fn rhythm_projection_collects_tempos_and_beats() {
        let v = project_rhythm(&sample_response());
        assert_eq!(v["dominant_bpm"], 91);
        assert_eq!(v["time_signature"], "4/4");
        assert_eq!(v["tempo_segments"].as_array().unwrap().len(), 2);
        assert_eq!(v["tempo_segments"][1]["time_sec"], 3.0);
        assert_eq!(v["tempo_segments"][1]["bpm"], 91.0);
        assert_eq!(v["beat_count"], 1);
        assert_eq!(v["beats"][0]["bar"], 1);
    }

    #[test]
    fn transcription_projection_summarizes_without_midi_payload() {
        let v = project_transcription(&sample_response());
        assert_eq!(v["recording_id"], "r-test");
        assert_eq!(v["tempo_segments"], 2);
        assert_eq!(v["midi_bytes"], 4);
        assert!(v.get("midi_base64").is_none());
    }

    #[tokio::test]
    async fn no_recording_produces_structured_evidence() {
        // 无 PCM 时不应触达引擎：给一个不可达地址也无所谓，因为会先返回 NoRecording。
        let engine = Arc::new(
            AnalysisEngine::new("http://127.0.0.1:1", std::time::Duration::from_millis(10), 0)
                .unwrap(),
        );
        let ctx = RecordingContext::new(engine, None, 16_000, 1, "测试".to_string());
        assert!(matches!(
            ctx.ensure_analysis().await,
            Err(EvidenceError::NoRecording)
        ));
        let v = ctx.project(project_pitch).await;
        assert_eq!(v["status"], "no_recording");
        let info = ctx.recording_info();
        assert_eq!(info["analyzable"], false);
        assert!(info["duration_sec"].is_null());
    }

    #[tokio::test]
    async fn recording_info_duration_from_pcm_bytes() {
        // 16kHz 单声道 1 秒 = 16000 帧 * 4 字节
        let engine = Arc::new(
            AnalysisEngine::new("http://127.0.0.1:1", std::time::Duration::from_millis(10), 0)
                .unwrap(),
        );
        let pcm = vec![0u8; 16_000 * 4];
        let ctx = RecordingContext::new(engine, Some(pcm), 16_000, 1, "x".to_string());
        assert_eq!(ctx.duration_sec(), Some(1.0));
    }

    #[tokio::test]
    async fn tool_schemas_are_valid_objects() {
        let engine = Arc::new(
            AnalysisEngine::new("http://127.0.0.1:1", std::time::Duration::from_millis(10), 0)
                .unwrap(),
        );
        let (_, tools) = request_tools(engine, None, 16_000, 1, "x".to_string());
        assert_eq!(tools.len(), 5);
        for t in &tools {
            assert!(!t.name().is_empty());
            assert!(!t.description().is_empty());
            assert_eq!(t.parameters_schema()["type"], "object");
        }
        // 工具名稳定（LLM function name，变更需评估兼容性）
        let names: Vec<&str> = tools.iter().map(|t| t.name()).collect();
        assert_eq!(
            names,
            vec![
                "get_current_recording",
                "analyze_pitch",
                "detect_notes",
                "analyze_rhythm",
                "transcribe_music",
            ]
        );
    }
}
