//! 音频基础约定与轻量 PCM 工具。
//!
//! 实时链路统一使用 16kHz / 单声道 / Float32 LE PCM，
//! 由浏览器 AudioWorklet 分帧后经 WebSocket 上传。

/// 实时链路采样率
pub const SAMPLE_RATE: u32 = 16_000;
/// 实时链路声道数
pub const CHANNELS: u16 = 1;
/// 实时分帧长度（毫秒）
pub const FRAME_MS: u32 = 40;
/// 每帧采样点数（16000 * 0.04 = 640）
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize * FRAME_MS as usize) / 1000;

/// 小端 Float32 字节流 → f32 采样
pub fn pcm_f32le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// f32 采样 → 小端 Float32 字节流
pub fn f32_to_pcm_f32le(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// RMS 电平（0.0 - 1.0），用于前端音量条/静音检测
pub fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_roundtrip() {
        let samples = vec![0.0, 0.5, -0.5, 1.0];
        let bytes = f32_to_pcm_f32le(&samples);
        assert_eq!(bytes.len(), 16);
        assert_eq!(pcm_f32le_to_f32(&bytes), samples);
    }

    #[test]
    fn frame_size_is_640() {
        assert_eq!(FRAME_SAMPLES, 640);
    }
}
