"""分析引擎配置（全部来自环境变量，与 Rust 端约定一致）。"""

import os

# gRPC 监听端口
GRPC_PORT = int(os.getenv("ANALYSIS_GRPC_PORT", "50051"))

ENGINE_NAME = "python-analysis"
ENGINE_VERSION = "0.1.0-m0"

# 实时链路音频约定（与 crates/audio 保持一致）
REALTIME_SAMPLE_RATE = 16_000
REALTIME_CHANNELS = 1

# 离线 AnalyzeAudio 音高后端：
#   yin   —— 纯 numpy YIN（默认，零额外依赖，实时链路同款）；
#   crepe —— 本地 CREPE ONNX 模型（CPU onnxruntime，高质量 f0）。
# 实时 StreamAudio 链路始终用 YIN，不受此开关影响。
PITCH_BACKEND = os.getenv("PITCH_BACKEND", "yin").strip().lower()
CREPE_MODEL = os.getenv("CREPE_MODEL", "tiny").strip().lower()
# 留空则使用仓库根 models/crepe/crepe_{size}.onnx
CREPE_MODEL_DIR = os.getenv("CREPE_MODEL_DIR", "").strip()
CREPE_MIN_CONFIDENCE = float(os.getenv("CREPE_MIN_CONFIDENCE", "0.5"))
