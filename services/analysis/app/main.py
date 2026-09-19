"""音乐分析引擎 gRPC 服务入口。

当前范围：
  - Ping：引擎健康检查 / 版本上报；
  - StreamAudio：实时 YIN 音高检测（numpy），逐帧输出 PitchFrame
    （frequency_hz / midi_cents / voiced / confidence）；
  - AnalyzeAudio：离线管线，整段 PCM → NoteSequence + MusicEvent + MIDI。
    pipeline 支持 "pitch"（逐帧 PitchFrame 事件）/ "notes"（Note 分割）/
    "midi"（Standard MIDI File 字节）/ "rhythm"（M4：速度/拍号/调性/节拍事件）。

M4 起节拍/速度/调性自动检测（app/rhythm.py）替换原固定 BPM=100 假设：
只要请求 "midi" 或 "rhythm" 即运行检测，NoteSequence 携带真实 bpm/key/拍号，
"rhythm" 步骤额外输出 TempoEvent / KeyEvent / BeatEvent / MeasureEvent。
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
from .rhythm import RhythmDetector  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("analysis")

# 节奏证据不足时的安全回退（与 M3 固定假设一致）
DEFAULT_BPM = 100
DEFAULT_TIME_SIGNATURE = "4/4"


def build_note_tracker(sample_rate: int) -> NoteTracker:
    """按环境变量 PITCH_BACKEND 构建离线分割器。

    yin（默认）：纯 numpy，零额外依赖；crepe：本地 ONNX 高质量后端，
    权重由 scripts/download_model.py 下载。实时 StreamAudio 始终用 YIN。
    """
    name = config.PITCH_BACKEND
    if name == "yin":
        return NoteTracker(sample_rate=sample_rate)
    if name == "crepe":
        from .model_pitch import CrepeBackend

        backend = CrepeBackend(
            sample_rate=sample_rate,
            model_size=config.CREPE_MODEL,
            model_dir=config.CREPE_MODEL_DIR or None,
            min_confidence=config.CREPE_MIN_CONFIDENCE,
        )
        return NoteTracker(sample_rate=sample_rate, backend=backend)
    raise ValueError(f"未知 PITCH_BACKEND={name!r}，可选：yin / crepe")


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
        unknown = steps - {"pitch", "notes", "midi", "rhythm"}
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

        try:
            tracker = build_note_tracker(sample_rate)
        except (ImportError, FileNotFoundError, ValueError) as exc:
            context.abort(
                grpc.StatusCode.FAILED_PRECONDITION,
                f"音高后端不可用：{exc}",
            )
        notes, track = tracker.run(pcm)

        # M4：节拍/速度/拍号/调性检测。midi 需要真实 bpm，rhythm 额外产出事件；
        # 检测证据不足时 RhythmResult 内部回退 100 / 4/4（置信度 0）。
        rhythm = None
        if steps & {"midi", "rhythm"}:
            rhythm = RhythmDetector(sample_rate).analyze(
                pcm, note_midis=[n.midi for n in notes]
            )

        seq_bpm = rhythm.bpm if rhythm else DEFAULT_BPM
        seq_time_signature = (
            f"{rhythm.time_signature_num}/{rhythm.time_signature_den}"
            if rhythm
            else DEFAULT_TIME_SIGNATURE
        )
        seq = events_pb2.NoteSequence(
            total_duration=total_duration,
            bpm=seq_bpm,
            time_signature=seq_time_signature,
            key=rhythm.key if rhythm else "",
        )
        events: list[events_pb2.MusicEvent] = []

        if rhythm is not None and "rhythm" in steps:
            # 多段速度：每段一个 TempoEvent（首段 time=0）；
            # 调性整曲一条（M4 基线不做转调，后续可扩展多 KeyEvent）
            for t_sec, seg_bpm in rhythm.tempo_map:
                events.append(
                    events_pb2.MusicEvent(
                        session_id=request.recording_id,
                        timestamp=t_sec,
                        source=events_pb2.SOURCE_HIGH_QUALITY,
                        tempo=events_pb2.TempoEvent(time=t_sec, bpm=seg_bpm),
                    )
                )
            if rhythm.key:
                events.append(
                    events_pb2.MusicEvent(
                        session_id=request.recording_id,
                        timestamp=0.0,
                        source=events_pb2.SOURCE_HIGH_QUALITY,
                        key=events_pb2.KeyEvent(
                            time=0.0,
                            tonality=rhythm.key,
                            tonic_midi=rhythm.key_tonic_midi,
                            confidence=rhythm.key_confidence,
                        ),
                    )
                )
            for b in rhythm.beats:
                events.append(
                    events_pb2.MusicEvent(
                        session_id=request.recording_id,
                        timestamp=b.onset,
                        source=events_pb2.SOURCE_HIGH_QUALITY,
                        beat=events_pb2.BeatEvent(
                            onset=b.onset,
                            beat=b.beat,
                            bar=b.bar,
                            bpm=rhythm.bpm,
                        ),
                    )
                )
                if b.beat == 1:
                    events.append(
                        events_pb2.MusicEvent(
                            session_id=request.recording_id,
                            timestamp=b.onset,
                            source=events_pb2.SOURCE_HIGH_QUALITY,
                            measure=events_pb2.MeasureEvent(
                                index=b.bar,
                                start=b.onset,
                                time_signature_num=rhythm.time_signature_num,
                                time_signature_den=rhythm.time_signature_den,
                            ),
                        )
                    )

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

        midi_bytes = (
            write_smf(
                notes,
                bpm=seq_bpm,
                numerator=rhythm.time_signature_num if rhythm else 4,
                denominator=rhythm.time_signature_den if rhythm else 4,
                tempo_map=rhythm.tempo_map if rhythm else None,
            )
            if "midi" in steps
            else b""
        )

        logger.info(
            "analyze close recording=%s notes=%d events=%d midi=%dB bpm=%s ts=%s key=%s",
            request.recording_id,
            len(seq.notes),
            len(events),
            len(midi_bytes),
            seq_bpm,
            seq_time_signature,
            rhythm.key if rhythm else "-",
        )
        return analysis_pb2.AnalyzeAudioResponse(
            recording_id=request.recording_id,
            sequence=seq,
            events=events,
            midi=midi_bytes,
        )


def serve() -> None:
    if config.PITCH_BACKEND not in ("yin", "crepe"):
        raise SystemExit(
            f"未知 PITCH_BACKEND={config.PITCH_BACKEND!r}，可选：yin / crepe"
        )
    # crepe 后端在启动时预热一次：缺权重 / 缺 onnxruntime 立即暴露，
    # 而非等到首个分析请求才失败（ONNX 会话本身带缓存，重复构建代价很小）。
    if config.PITCH_BACKEND == "crepe":
        try:
            build_note_tracker(config.REALTIME_SAMPLE_RATE)
        except (ImportError, FileNotFoundError) as exc:
            raise SystemExit(f"crepe 后端初始化失败：{exc}") from exc
    logger.info("offline pitch backend: %s", config.PITCH_BACKEND)

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
