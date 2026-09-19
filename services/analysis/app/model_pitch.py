"""离线高质量基频后端：CREPE（ONNX Runtime，CPU 推理）。

与实时链路解耦：仅被 notes.NoteTracker 的离线管线按环境变量
PITCH_BACKEND=crepe 选用，实时 WebSocket/YIN 链路不受影响。

模型契约（NeoPy/Ultimate-Models 的标准 CREPE ONNX 导出）：
  输入  frames   [n_frames, 1024] float32，每帧已做零均值/单位方差归一化；
  输出 probabilities [n_frames, 360] float32，360 个音分级（已含 sigmoid，
  覆盖 C1(≈31.7Hz)~B6(≈2kHz)，每级 20 cents），不可再次 sigmoid。

输出与 pitch.PitchResult / notes.PitchTrack 对齐：
  track() 返回与 YIN 逐帧回路相同的 10ms 网格（帧中心从 win_sec/2 起），
  notes.py 后续的桥接/切分/聚合逻辑无需感知 f0 来源。

依赖 onnxruntime 为**懒加载**：未安装时默认 YIN 后端照常工作，
仅在显式选择 crepe 时抛出带安装指引的中文错误。
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from .pitch import PitchResult

# CREPE 固定工作采样率
CREPE_SAMPLE_RATE = 16_000
CREPE_FRAME = 1024          # 样本（64ms）
CREPE_PAD = 512             # 两端各 pad 512（center=True）
CREPE_BINS = 360
# 360 级音高的 cents 值：0..7180（步长 20）。
# 官方 CREPE 约定 cents 以 **10Hz** 为基准（第 0 级 = 10*2^(1997.38/1200)
# ≈ 31.7Hz = C1），故 f = 10 * 2**(cents/1200)；误用 16.35(C0) 基准会
# 整体偏高 8.5 个半音。
_CENTS_MAPPING = np.linspace(0, 7180, CREPE_BINS) + 1997.3794084376191
_REF_HZ = 10.0

_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODEL_DIR = _REPO_ROOT / "models" / "crepe"
VALID_SIZES = ("tiny", "small", "medium", "large", "full")


@lru_cache(maxsize=4)
def _load_session(model_path: str):
    """缓存 ONNX 会话，避免每个分析请求重复加载权重。"""
    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise ImportError(
            "crepe 音高后端需要 onnxruntime，但当前未安装。\n"
            "  安装：pip install onnxruntime（CPU 版，无需 torch）\n"
            "  或保持默认后端：PITCH_BACKEND=yin"
        ) from exc
    return ort.InferenceSession(
        model_path, providers=["CPUExecutionProvider"]
    )


def default_model_path(size: str, model_dir: str | os.PathLike[str] | None) -> Path:
    base = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
    return base / f"crepe_{size}.onnx"


class CrepeBackend:
    """整段 PCM 批量推理 f0；接口供 NoteTracker 鸭型分派。

    与 YinDetector 的差异：YIN 按 640 样本短窗逐帧 detect；
    CREPE 需要看到整段信号以按其固定 hop 批量取帧，因此暴露 track()。
    """

    def __init__(
        self,
        sample_rate: int = CREPE_SAMPLE_RATE,
        model_size: str = "tiny",
        model_dir: str | os.PathLike[str] | None = None,
        min_confidence: float = 0.5,
        rms_floor: float = 0.01,
        batch_size: int = 1024,
        model_path: str | os.PathLike[str] | None = None,
    ) -> None:
        if model_size not in VALID_SIZES:
            raise ValueError(
                f"未知 CREPE 规格 {model_size!r}，可选：{', '.join(VALID_SIZES)}"
            )
        self.input_sr = sample_rate
        self.model_size = model_size
        self.min_confidence = min_confidence
        self.rms_floor = rms_floor
        self.batch_size = batch_size

        path = Path(model_path) if model_path else default_model_path(
            model_size, model_dir
        )
        if not path.exists():
            raise FileNotFoundError(
                f"未找到 CREPE 模型权重：{path}\n"
                f"请先下载（默认走 hf-mirror.com 国内镜像）：\n"
                f"  python scripts/download_model.py --models {model_size}\n"
                f"可用 HF_ENDPOINT 或 --endpoint 切换源；或改用 PITCH_BACKEND=yin。"
            )
        self.model_path = path
        self.session = _load_session(str(path.resolve()))
        self._input_name = self.session.get_inputs()[0].name

    # ------------------------------------------------------------------ 取帧

    @staticmethod
    def _resample_to_16k(pcm: np.ndarray, src_sr: int) -> np.ndarray:
        """无 scipy 依赖的线性重采样（f0 估计对插值误差不敏感）。"""
        if src_sr == CREPE_SAMPLE_RATE:
            return pcm.astype(np.float32, copy=False)
        n16 = int(round(pcm.size * CREPE_SAMPLE_RATE / src_sr))
        if n16 <= 0:
            return np.empty(0, dtype=np.float32)
        x_old = np.linspace(0.0, 1.0, pcm.size, dtype=np.float64)
        x_new = np.linspace(0.0, 1.0, n16, dtype=np.float64)
        return np.interp(x_new, x_old, pcm.astype(np.float64, copy=False)).astype(
            np.float32
        )

    def _build_frames(self, pcm16: np.ndarray, hop: int, win: int):
        """构造 CREPE 帧。

        帧中心与 YIN 网格对齐：center_k = win/2 + k*hop（16k 下即
        320, 480, ...），两侧 pad 512 后用 strided view 零拷贝取 1024 帧。
        返回 (帧数组 [K,1024], 帧中心 [K], 帧 RMS [K], 帧时间 [K])。
        """
        n = pcm16.size
        centers = np.arange(win // 2, n - win // 2 + 1, hop, dtype=np.int64)
        if centers.size == 0:
            return None
        padded = np.pad(pcm16, CREPE_PAD, mode="constant")
        # 帧中心为 centers[k]（原信号坐标），对应 1024 窗在 padded 中的
        # 起点 = centers[k] - 512 + 512 = centers[k]。故 strided 视图必须
        # 从 padded[centers[0]] 开始、行间跨 hop；若误从 padded[0] 取帧，
        # 帧内容会比时间戳早 win/2（20ms），动态音高（滑音/颤音）即现偏差。
        c0 = int(centers[0])
        frames = np.lib.stride_tricks.as_strided(
            padded[c0:],
            shape=(centers.size, CREPE_FRAME),
            strides=(hop * padded.strides[0], padded.strides[0]),
            writeable=False,
        )
        frames = np.ascontiguousarray(frames, dtype=np.float32)

        # RMS 用 win(640) 短窗，与 notes.py 能量口径一致
        rms_starts = np.clip(centers - win // 2, 0, max(0, n - win))
        rms_windows = np.lib.stride_tricks.as_strided(
            pcm16,
            shape=(rms_starts.size, win),
            strides=(hop * pcm16.strides[0], pcm16.strides[0]),
        )
        rms = np.sqrt(np.mean(np.asarray(rms_windows, dtype=np.float64) ** 2, axis=1))
        times = centers.astype(np.float64) / CREPE_SAMPLE_RATE
        return frames, centers, rms, times

    # ------------------------------------------------------------------ 解码

    @staticmethod
    def _decode_cents(probs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """360 级激活 → 局部加权平均 cents 与每帧置信度。

        官方 CREPE 做法：取 argmax 附近 [c-4, c+5) 的激活做加权平均，
        比直接 argmax 量化到 20 cents 更精细。
        """
        peak = np.argmax(probs, axis=1)
        confidence = probs[np.arange(probs.shape[0]), peak]
        cents = np.full(probs.shape[0], np.nan, dtype=np.float64)
        for i, c in enumerate(peak):
            lo = max(0, c - 4)
            hi = min(CREPE_BINS, c + 5)
            weights = probs[i, lo:hi]
            total = float(weights.sum())
            if total > 1e-8:
                cents[i] = float(np.dot(_CENTS_MAPPING[lo:hi], weights) / total)
        return cents, confidence.astype(np.float64)

    # ------------------------------------------------------------------ 主入口

    def track(
        self, pcm: np.ndarray, hop_sec: float = 0.01, win_sec: float = 0.04
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """整段 PCM → (times, hz, midi_cents, voiced, confidence)。

        网格与 notes.NoteTracker._track_pitch 的 YIN 回路一致。
        """
        empty = np.empty(0, dtype=np.float64)
        pcm16 = self._resample_to_16k(np.asarray(pcm, dtype=np.float32), self.input_sr)
        hop = max(1, int(round(hop_sec * CREPE_SAMPLE_RATE)))
        win = max(hop, int(round(win_sec * CREPE_SAMPLE_RATE)))
        if pcm16.size < win:
            return empty, empty.copy(), empty.copy(), np.empty(0, dtype=bool), empty.copy()

        built = self._build_frames(pcm16, hop, win)
        if built is None:
            return empty, empty.copy(), empty.copy(), np.empty(0, dtype=bool), empty.copy()
        frames, _centers, rms, times = built

        # 逐帧零均值/单位方差（CREPE 训练时的输入归一化）
        mean = frames.mean(axis=1, keepdims=True)
        std = frames.std(axis=1, keepdims=True)
        frames = (frames - mean) / (std + 1e-9)

        probs = np.empty((frames.shape[0], CREPE_BINS), dtype=np.float32)
        for lo in range(0, frames.shape[0], self.batch_size):
            hi = lo + self.batch_size
            (probs[lo:hi],) = self.session.run(
                None, {self._input_name: frames[lo:hi]}
            )

        cents, confidence = self._decode_cents(probs)
        hz = _REF_HZ * np.power(2.0, cents / 1200.0)
        midi_cents = 69.0 + 12.0 * np.log2(hz / 440.0)

        voiced = (
            np.isfinite(cents)
            & (rms >= self.rms_floor)
            & (confidence >= self.min_confidence)
        )
        # unvoiced 帧口径与 YIN 回路一致：hz / midi 置 0
        hz = np.where(voiced, hz, 0.0)
        midi_out = np.where(voiced, midi_cents, 0.0)
        return times, hz, midi_out, voiced, confidence

    def detect(self, pcm: np.ndarray) -> PitchResult:
        """单帧兼容接口（取信号中央 64ms），便于对照测试/调试。"""
        times, hz, midi, voiced, conf = self.track(np.asarray(pcm, dtype=np.float32))
        if times.size == 0 or not bool(voiced.any()):
            return PitchResult(0.0, 0.0, False, 0.0)
        mid = times.size // 2
        return PitchResult(
            frequency_hz=float(hz[mid]),
            midi_cents=float(midi[mid]),
            voiced=bool(voiced[mid]),
            confidence=float(conf[mid]),
        )
