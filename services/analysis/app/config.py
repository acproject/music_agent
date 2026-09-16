"""分析引擎配置（全部来自环境变量，与 Rust 端约定一致）。"""

import os

# gRPC 监听端口
GRPC_PORT = int(os.getenv("ANALYSIS_GRPC_PORT", "50051"))

ENGINE_NAME = "python-analysis"
ENGINE_VERSION = "0.1.0-m0"

# 实时链路音频约定（与 crates/audio 保持一致）
REALTIME_SAMPLE_RATE = 16_000
REALTIME_CHANNELS = 1
