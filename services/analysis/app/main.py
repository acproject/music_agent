"""音乐分析引擎 gRPC 服务入口。

当前（M2）范围：
  - Ping：引擎健康检查 / 版本上报；
  - StreamAudio：实时 YIN 音高检测（numpy），逐帧输出 PitchFrame
    （frequency_hz / midi_cents / voiced / confidence）；
  - AnalyzeAudio：显式返回 UNIMPLEMENTED（高质量管线在 M3+ 落地）。

M3 起：onset/Note 聚合、AnalyzeAudio 输出 NoteSequence 与 MIDI。
所有输出只允许使用 proto 生成的 music.v1 结构。
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
from concurrent import futures
from pathlib import Path

# 生成的 proto 包位于 app/proto/music/v1，将其加入 sys.path
_PROTO_ROOT = Path(__file__).resolve().parent / "proto"
if str(_PROTO_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROTO_ROOT))

import grpc  # noqa: E402

import numpy as np  # noqa: E402

from music.v1 import analysis_pb2, analysis_pb2_grpc, events_pb2  # noqa: E402

from . import __version__, config  # noqa: E402
from .pitch import YinDetector  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("analysis")


class AnalysisService(analysis_pb2_grpc.AnalysisServiceServicer):
    """music.v1.AnalysisService 实现。"""

    def Ping(self, request, context):
        return analysis_pb2.PingResponse(
            message=request.message or "pong",
            engine=config.ENGINE_NAME,
            version=__version__,
        )

    def StreamAudio(self, request_iterator, context):
        """实时音频块流 -> 音乐事件流（M1 为占位回执，M2 接入真实音高检测）。"""
        # 立即 flush 响应头：否则 gRPC 要等首个 yield 才发头，
        # 而首个 yield 依赖客户端的第一个音频块，会与"等头才发数据"的客户端形成死锁。
        context.send_initial_metadata(())

        peer = context.peer()
        chunks = 0
        session_id = ""
        sample_count = 0
        # 每条实时流一个 YIN 实例（检测器无跨帧状态，但便于后续做中值平滑）
        detector = YinDetector(sample_rate=config.REALTIME_SAMPLE_RATE)

        for chunk in request_iterator:
            chunks += 1
            session_id = chunk.session_id
            if chunks == 1:
                logger.info(
                    "stream open session=%s peer=%s sr=%d ch=%d",
                    chunk.session_id,
                    peer,
                    chunk.sample_rate,
                    chunk.channels,
                )

            # final 是结束控制标记（PCM 为空），不产生分析事件
            if chunk.final:
                break

            # 事件时间戳：按已接收 PCM 样本数推算（秒）
            rate = chunk.sample_rate or config.REALTIME_SAMPLE_RATE
            n_samples = len(chunk.pcm_f32le) // 4  # Float32 = 4 字节
            timestamp = sample_count / rate if rate else 0.0
            sample_count += n_samples

            # 实时 YIN 音高检测：每 40ms 一帧 f0 / 连续 MIDI / voiced / 置信度
            if n_samples > 0:
                pcm = np.frombuffer(chunk.pcm_f32le, dtype=np.float32)
                result = detector.detect(pcm)
                yield events_pb2.MusicEvent(
                    session_id=chunk.session_id,
                    timestamp=timestamp,
                    source=events_pb2.SOURCE_REALTIME,
                    pitch=events_pb2.PitchFrame(
                        frequency_hz=result.frequency_hz,
                        midi_cents=result.midi_cents,
                        voiced=result.voiced,
                        confidence=result.confidence,
                    ),
                )

        logger.info(
            "stream close session=%s chunks=%d duration=%.2fs",
            session_id,
            chunks,
            sample_count / config.REALTIME_SAMPLE_RATE,
        )

    def AnalyzeAudio(self, request, context):
        # 高质量管线（降噪/分离/转谱/MIDI）在 M2/M3 实现
        context.abort(
            grpc.StatusCode.UNIMPLEMENTED,
            "high-quality analysis pipeline will land in M2/M3",
        )


def serve() -> None:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    analysis_pb2_grpc.add_AnalysisServiceServicer_to_server(
        AnalysisService(), server
    )
    server.add_insecure_port(f"[::]:{config.GRPC_PORT}")
    server.start()
    logger.info(
        "%s v%s listening on [::]:%d",
        config.ENGINE_NAME,
        __version__,
        config.GRPC_PORT,
    )

    stop = threading.Event()

    def _handle_signal(signum, _frame):
        logger.info("signal %s received, draining", signum)
        stop.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    stop.wait()
    server.stop(grace=2).wait()
    logger.info("stopped")


if __name__ == "__main__":
    serve()
