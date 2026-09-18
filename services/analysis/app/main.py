"""音乐分析引擎 gRPC 服务入口。

当前（M3）范围：
  - Ping：引擎健康检查 / 版本上报；
  - StreamAudio：实时 YIN 音高检测（numpy），逐帧输出 PitchFrame
    （frequency_hz / midi_cents / voiced / confidence）；
  - AnalyzeAudio：离线管线，整段 PCM → NoteSequence + MusicEvent + MIDI。
    pipeline 支持 "pitch"（逐帧 PitchFrame 事件）/ "notes"（Note 分割）/
    "midi"（Standard MIDI File 字节）。

M4 起接入节拍/速度自动检测，替换当前的固定 BPM 量化假设。
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
from .midi import write_smf  # noqa: E402
from .notes import NoteTracker  # noqa: E402
from .pitch import YinDetector  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("analysis")

# M3 固定量化假设：M4 节拍检测落地前，NoteSequence/MIDI 使用统一默认速度与拍号
DEFAULT_BPM = 100
DEFAULT_TIME_SIGNATURE = "4/4"


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
        """离线高质量管线：整段 Float32 PCM → NoteSequence / 事件 / MIDI。"""
        if len(request.pcm_f32le) < 4 or len(request.pcm_f32le) % 4 != 0:
            context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                "pcm_f32le must contain at least one Float32 sample",
            )

        sample_rate = request.sample_rate or config.REALTIME_SAMPLE_RATE
        if not 8_000 <= sample_rate <= 192_000:
            context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                f"unsupported sample_rate: {sample_rate}",
            )
        channels = max(1, request.channels)

        pcm = np.frombuffer(request.pcm_f32le, dtype=np.float32)
        if channels > 1:
            # 交错多声道下混为单声道（M3 分析仅支持单音旋律）
            usable = (pcm.size // channels) * channels
            pcm = pcm[:usable].reshape(-1, channels).mean(axis=1).astype(np.float32)

        steps = {s.strip() for s in request.pipeline if s.strip()}
        if not steps:
            steps = {"notes", "midi"}
        unknown = steps - {"pitch", "notes", "midi"}
        if unknown:
            context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                f"unsupported pipeline steps: {sorted(unknown)}",
            )

        total_duration = pcm.size / sample_rate
        logger.info(
            "analyze open recording=%s sr=%d dur=%.2fs pipeline=%s",
            request.recording_id,
            sample_rate,
            total_duration,
            sorted(steps),
        )

        notes, track = NoteTracker(sample_rate=sample_rate).run(pcm)

        seq = events_pb2.NoteSequence(
            total_duration=total_duration,
            bpm=DEFAULT_BPM,
            time_signature=DEFAULT_TIME_SIGNATURE,
        )
        events: list[events_pb2.MusicEvent] = []

        if "pitch" in steps:
            for i, t in enumerate(track.times):
                events.append(
                    events_pb2.MusicEvent(
                        session_id=request.recording_id,
                        timestamp=float(t),
                        source=events_pb2.SOURCE_HIGH_QUALITY,
                        pitch=events_pb2.PitchFrame(
                            frequency_hz=float(track.frequency_hz[i]),
                            midi_cents=float(track.midi_cents[i]),
                            voiced=bool(track.voiced[i]),
                            confidence=float(track.confidence[i]),
                        ),
                    )
                )

        if "notes" in steps:
            for n in notes:
                note_event = events_pb2.NoteEvent(
                    midi=n.midi,
                    cents_offset=n.cents_offset,
                    onset=n.onset,
                    duration=n.duration,
                    velocity=n.velocity,
                    confidence=n.confidence,
                )
                seq.notes.append(note_event)
                events.append(
                    events_pb2.MusicEvent(
                        session_id=request.recording_id,
                        timestamp=n.onset,
                        source=events_pb2.SOURCE_HIGH_QUALITY,
                        note=note_event,
                    )
                )

        midi_bytes = write_smf(notes, bpm=DEFAULT_BPM) if "midi" in steps else b""

        logger.info(
            "analyze close recording=%s notes=%d events=%d midi=%dB",
            request.recording_id,
            len(seq.notes),
            len(events),
            len(midi_bytes),
        )
        return analysis_pb2.AnalyzeAudioResponse(
            recording_id=request.recording_id,
            sequence=seq,
            events=events,
            midi=midi_bytes,
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
