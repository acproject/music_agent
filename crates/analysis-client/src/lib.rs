//! Python 音乐分析引擎的 gRPC 客户端。
//!
//! - 连接懒建立：api 可以先于 analysis 服务启动，健康检查会如实报告引擎状态；
//! - 每次调用带超时；传输类错误由调用方按 `max_retries` 决定重试；
//! - 实时链路使用 `StreamAudio` 双向流，高质量分析使用 `AnalyzeAudio` 一元调用。

use music_domain::v1::{
    analysis_service_client::AnalysisServiceClient, AnalyzeAudioRequest, AnalyzeAudioResponse,
    AudioChunk, MusicEvent, PingRequest, PingResponse,
};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Channel, Endpoint};
use tonic::Streaming;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("engine transport error: {0}")]
    Transport(#[from] tonic::transport::Error),
    #[error("engine rpc error: {0}")]
    Rpc(#[from] tonic::Status),
    #[error("engine request timed out after {0:?}")]
    Timeout(Duration),
    #[error("invalid engine url: {0}")]
    InvalidEndpoint(String),
}

pub type Result<T> = std::result::Result<T, EngineError>;

/// 实时双向流句柄：`tx` 发送 AudioChunk，`rx` 接收 MusicEvent。
pub struct AudioStream {
    pub tx: mpsc::Sender<AudioChunk>,
    pub rx: Streaming<MusicEvent>,
}

#[derive(Clone)]
pub struct AnalysisEngine {
    client: AnalysisServiceClient<Channel>,
    timeout: Duration,
    max_retries: u32,
}

impl AnalysisEngine {
    /// 懒连接：立即返回，首个 RPC 时才真正建连。
    pub fn new(url: &str, timeout: Duration, max_retries: u32) -> Result<Self> {
        let endpoint = Endpoint::from_shared(url.to_string())
            .map_err(|_| EngineError::InvalidEndpoint(url.to_string()))?
            .connect_timeout(timeout)
            .timeout(timeout);
        let channel = endpoint.connect_lazy();
        Ok(Self {
            client: AnalysisServiceClient::new(channel),
            timeout,
            max_retries,
        })
    }

    pub fn max_retries(&self) -> u32 {
        self.max_retries
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// 引擎健康检查（带超时，不吞错误，交由调用方降级展示）。
    pub async fn ping(&self) -> Result<PingResponse> {
        let mut client = self.client.clone();
        let req = PingRequest {
            message: "ping".to_string(),
        };
        match tokio::time::timeout(self.timeout, client.ping(req)).await {
            Ok(inner) => inner.map(|r| r.into_inner()).map_err(Into::into),
            Err(_) => Err(EngineError::Timeout(self.timeout)),
        }
    }

    /// 建立实时音频双向流。
    /// 返回发送端与事件流；`tx` drop 时流自动半关闭，如需显式结束可发 final chunk。
    pub async fn stream_audio(&self, buffer: usize) -> Result<AudioStream> {
        let mut client = self.client.clone();
        let (tx, rx) = mpsc::channel::<AudioChunk>(buffer);
        let response = client
            .stream_audio(ReceiverStream::new(rx))
            .await?;
        Ok(AudioStream {
            tx,
            rx: response.into_inner(),
        })
    }

    /// 高质量整段分析（M2/M3 接入）。
    pub async fn analyze_audio(
        &self,
        request: AnalyzeAudioRequest,
    ) -> Result<AnalyzeAudioResponse> {
        let mut client = self.client.clone();
        match tokio::time::timeout(self.timeout * 30, client.analyze_audio(request)).await {
            Ok(inner) => inner.map(|r| r.into_inner()).map_err(Into::into),
            Err(_) => Err(EngineError::Timeout(self.timeout * 30)),
        }
    }
}
