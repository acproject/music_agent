//! Agent 可调用的音乐工具集合。
//!
//! Phase 1 将在此注册：analyze_pitch / detect_notes / generate_midi /
//! generate_score / compare_performance 等；新增工具只需实现 AgentTool。

mod health;
mod registry;

pub use health::PingEngineTool;
pub use registry::ToolRegistry;
