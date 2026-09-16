//! 全局配置：全部来自环境变量（可由 `.env` 覆盖），所有外部依赖均可配置
//! 地址、超时与重试次数，符合系统对可配置性的要求。

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub http: HttpConfig,
    pub analysis: AnalysisConfig,
    pub llm: LlmConfig,
    pub storage: StorageConfig,
    pub log: String,
}

#[derive(Debug, Clone)]
pub struct HttpConfig {
    pub host: String,
    pub port: u16,
}

impl HttpConfig {
    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Clone)]
pub struct AnalysisConfig {
    /// Python 分析引擎 gRPC 地址，如 http://127.0.0.1:50051
    pub grpc_url: String,
    pub timeout: Duration,
    pub max_retries: u32,
}

#[derive(Debug, Clone)]
pub struct LlmConfig {
    /// OpenAI 兼容 `/chat/completions` 的基础地址
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout: Duration,
    pub max_retries: u32,
    /// 显式代理；为空时 reqwest 跟随 HTTP_PROXY/HTTPS_PROXY 环境变量
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StorageConfig {
    /// SQLite 连接串，如 sqlite://data/music.db?mode=rwc
    pub database_url: String,
    /// 音频等大文件存放目录（SQLite 只存元数据）
    pub audio_dir: String,
}

impl AppConfig {
    pub fn from_env() -> Self {
        Self {
            http: HttpConfig {
                host: env_or("HTTP_HOST", "0.0.0.0".to_string()),
                port: env_parse("HTTP_PORT", 8080),
            },
            analysis: AnalysisConfig {
                grpc_url: env_or("ANALYSIS_GRPC_URL", "http://127.0.0.1:50051".to_string()),
                timeout: Duration::from_millis(env_parse("ANALYSIS_TIMEOUT_MS", 2000)),
                max_retries: env_parse("ANALYSIS_MAX_RETRIES", 2),
            },
            llm: LlmConfig {
                base_url: env_or("LLM_BASE_URL", "https://api.openai.com/v1".to_string()),
                api_key: env_or("LLM_API_KEY", String::new()),
                model: env_or("LLM_MODEL", "gpt-4o-mini".to_string()),
                timeout: Duration::from_millis(env_parse("LLM_TIMEOUT_MS", 30_000)),
                max_retries: env_parse("LLM_MAX_RETRIES", 2),
                proxy_url: env_opt("LLM_PROXY_URL"),
            },
            storage: StorageConfig {
                database_url: env_or("DATABASE_URL", "sqlite://data/music.db?mode=rwc".to_string()),
                audio_dir: env_or("AUDIO_DIR", "data/audio".to_string()),
            },
            log: env_or("RUST_LOG", "info".to_string()),
        }
    }
}

fn env_or(key: &str, default: String) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or(default)
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
