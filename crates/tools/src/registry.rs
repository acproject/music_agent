//! 音乐工具注册表：集中管理 Agent 可调用的全部工具。

use std::collections::HashMap;
use std::sync::Arc;

use music_agent::AgentTool;

#[derive(Default)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn AgentTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Arc<dyn AgentTool>) -> &mut Self {
        let name = tool.name().to_string();
        self.tools.insert(name, tool);
        self
    }

    pub fn into_tools(self) -> Vec<Arc<dyn AgentTool>> {
        self.tools.into_values().collect()
    }
}
