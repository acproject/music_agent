//! Agent 可调用的音乐工具集合。
//!
//! Phase 1：ping_analysis_engine + 录音上下文五件套
//! （get_current_recording / analyze_pitch / detect_notes /
//! analyze_rhythm / transcribe_music）。
//! 后续增量：compare_performance / generate_exercise /
//! get_student_profile 等；新增工具只需实现 AgentTool。

mod health;
mod recording;
mod registry;

pub use health::PingEngineTool;
pub use recording::{
    request_tools, AnalyzePitchTool, AnalyzeRhythmTool, DetectNotesTool,
    GetCurrentRecordingTool, RecordingContext, TranscribeMusicTool,
};
pub use registry::ToolRegistry;
