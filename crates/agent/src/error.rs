use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("llm http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("llm returned unexpected status {status}: {body}")]
    Status { status: u16, body: String },
    #[error("llm response could not be parsed: {0}")]
    Parse(String),
    #[error("llm configuration error: {0}")]
    Config(String),
    #[error("tool execution failed: {0}")]
    Tool(String),
    #[error("agent loop exceeded max iterations ({0})")]
    MaxIterations(u32),
}
