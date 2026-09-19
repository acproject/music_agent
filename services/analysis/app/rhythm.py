"""M4 节拍 / 速度 / 拍号 / 调性检测（纯 numpy）。

M3 主链路在 main.py 中写死 BPM=100、4/4；M4 起由本模块替换。
当前为轻量基线实现：
  - 频谱通量起音包络 + 全局自相关测速（60~200 BPM，带置信度）；
  - 滑窗局部自相关（窗 4s / hop 1s）+ 全局速度八度校正 +
    中值平滑 + 迟滞分段，产出多段 tempo_map（"多段变速"）；
  - 节拍点按各段局部周期铺设，跨段沿用小节相位；
  - 重音周期判 3/4 与 4/4、Krumhansl–Schmuckler 轮廓判大/小调。
后续可整体替换为 librosa 或深度学习模型——调用方只依赖 RhythmResult。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Krumhansl–Schmuckler 调性轮廓
_KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                      2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                      2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# 无足够证据时的安全回退（与 M3 持续假设一致）
FALLBACK_BPM = 100
FALLBACK_TS = (4, 4)

_FFT_SIZE = 2048
# 分段测速参数
_WINDOW_SEC = 4.0
_HOP_SEC = 1.0
_CHANGE_RATIO = 0.08      # 与当前段相差 ≥8% 才考虑切段
_MIN_SEGMENT_SEC = 2.0    # 短于此的段并入相邻长段
_BPM_MIN, _BPM_MAX = 60, 200
_TS_MIN_ACCENT_CONTRAST = 0.2   # 重音标准差/均值低于此值视为无小节重音，拍号回退 4/4
_TS_MIN_PERIODICITY = 0.15      # 3 拍周期性绝对值下限，防止噪声误判 3/4


@dataclass
class Beat:
    onset: float   # 节拍点时间（秒）
    beat: int      # 小节内第几拍（从 1 开始）
    bar: int       # 第几小节（从 1 开始）


@dataclass
class RhythmResult:
    bpm: int                       # 主导（最长）速度段的 BPM
    tempo_confidence: float
    time_signature_num: int
    time_signature_den: int
    # 调性："C major" / "A minor"（与 proto KeyEvent.tonality 约定一致）；
    # 无音符时为空串
    key: str
    key_tonic_midi: int
    key_confidence: float
    # 多段速度：[(起始秒, bpm), ...] 升序，首锚点 0.0；证据不足时单段回退
    tempo_map: list[tuple[float, int]] = field(default_factory=list)
    beats: list[Beat] = field(default_factory=list)


class RhythmDetector:
    def __init__(self, sample_rate: int, hop_ms: float = 20.0):
        self.sample_rate = sample_rate
        self.hop = max(1, int(sample_rate * hop_ms / 1000))

    def analyze(self, pcm: np.ndarray, note_midis: list[int] | None = None) -> RhythmResult:
        flux = self._spectral_flux(pcm)
        fps = self.sample_rate / self.hop

        global_bpm, tempo_conf, phase_frame = self._global_tempo(flux, fps)
        segments = self._segment_tempo(flux, fps, global_bpm) \
            if global_bpm is not None else None

        if segments is None:
            # 证据不足：单段回退，无节拍点
            bpm = FALLBACK_BPM
            tempo_map = [(0.0, FALLBACK_BPM)]
            beat_frames: list[int] = []
        else:
            bpm = self._dominant_bpm(segments, len(flux))
            tempo_map = self._segments_to_map(segments, fps)
            beat_frames = self._place_beats(segments, phase_frame, len(flux))

        if beat_frames:
            accents = np.array([
                flux[max(0, f - 2):min(len(flux), f + 3)].max()
                for f in beat_frames
            ])
            ts_num, ts_den = self._estimate_time_signature(accents)
        else:
            ts_num, ts_den = FALLBACK_TS

        beats = [
            Beat(
                onset=float(f * self.hop / self.sample_rate),
                beat=(i % ts_num) + 1,
                bar=(i // ts_num) + 1,
            )
            for i, f in enumerate(beat_frames)
        ]

        key, tonic_midi, key_conf = self._estimate_key(note_midis or [])
        return RhythmResult(
            bpm=bpm,
            tempo_confidence=tempo_conf,
            time_signature_num=ts_num,
            time_signature_den=ts_den,
            key=key,
            key_tonic_midi=tonic_midi,
            key_confidence=key_conf,
            tempo_map=tempo_map,
            beats=beats,
        )

    # ---- 频谱通量（只保留正向能量变化，突出起音） ----
    def _spectral_flux(self, pcm: np.ndarray) -> np.ndarray:
        if len(pcm) < _FFT_SIZE:
            pcm = np.pad(pcm, (0, _FFT_SIZE - len(pcm)))
        window = np.hanning(_FFT_SIZE)
        flux: list[float] = []
        prev_mag: np.ndarray | None = None
        for start in range(0, len(pcm) - _FFT_SIZE + 1, self.hop):
            mag = np.abs(np.fft.rfft(pcm[start:start + _FFT_SIZE] * window))
            if prev_mag is not None:
                flux.append(float(np.sum(np.maximum(0.0, mag - prev_mag))))
            prev_mag = mag
        return np.asarray(flux, dtype=np.float64)

    # ---- 全局速度：整段包络自相关主峰 ----
    def _global_tempo(
        self, flux: np.ndarray, fps: float
    ) -> tuple[int | None, float, int]:
        """返回 (bpm, 置信度, 相位帧)；证据不足时 bpm=None。"""
        if len(flux) < 4 or flux.max() <= 0.0:
            return None, 0.0, 0

        bpm, confidence, _lag = self._autocorr_bpm(flux, fps)
        if bpm is None:
            return None, 0.0, 0

        # 相位：第一个明显强起音帧
        threshold = flux.mean() + flux.std()
        strong = np.flatnonzero(flux > threshold)
        phase = int(strong[0]) if len(strong) else 0
        return bpm, confidence, phase

    def _autocorr_bpm(
        self,
        env: np.ndarray,
        fps: float,
        center_bpm: int | None = None,
    ) -> tuple[int | None, float, float]:
        """包络自相关主峰 → (bpm, 置信度, lag帧)。

        center_bpm 给出时（滑窗局部测速），把搜索带限制在其 ±40%，
        允许检出大幅变速（如 120→90），同时靠八度校正抑制倍频误判。
        """
        n = len(env)
        min_lag = max(1, int(round(fps * 60 / _BPM_MAX)))
        max_lag = min(n - 2, int(round(fps * 60 / _BPM_MIN)))
        if max_lag <= min_lag:
            return None, 0.0, 0.0

        if center_bpm is not None:
            center_lag = fps * 60 / center_bpm
            min_lag = max(min_lag, int(round(center_lag / 1.4)))
            max_lag = min(max_lag, int(round(center_lag * 1.4)))
        if max_lag <= min_lag:
            return None, 0.0, 0.0

        centered = env - env.mean()
        energy = float(np.dot(centered, centered))
        if energy <= 0.0:
            return None, 0.0, 0.0
        corr = np.correlate(centered, centered, mode="full")[n - 1:]
        band = corr[min_lag:max_lag + 1]
        peak = float(band.max())
        if peak <= 0.0:
            return None, 0.0, 0.0
        lag = min_lag + int(np.argmax(band))

        bpm = 60.0 * fps / lag
        bpm = self._octave_correct(bpm, center_bpm)
        bpm_i = int(round(bpm))

        # 置信度：主峰突出度（相对搜索带正值均值），压到 0~1
        positives = band[band > 0]
        baseline = float(positives.mean()) if len(positives) else 0.0
        confidence = max(0.0, min(1.0, (peak / (baseline + 1e-9) - 1.0) / 3.0))
        return bpm_i, confidence, lag

    @staticmethod
    def _octave_correct(bpm: float, center: int | None) -> float:
        """在 bpm 及 ×2/÷2 候选中挑最接近 center（全局速度）的；无 center 则夹回范围。"""
        candidates = [bpm]
        if bpm * 2 <= _BPM_MAX:
            candidates.append(bpm * 2)
        if bpm / 2 >= _BPM_MIN:
            candidates.append(bpm / 2)
        if center is None:
            return min(max(bpm, _BPM_MIN), _BPM_MAX)
        return min(candidates, key=lambda c: abs(c - center))

    # ---- 多段变速：滑窗局部测速 → 平滑 → 迟滞分段 → 短段合并 ----
    def _segment_tempo(
        self,
        flux: np.ndarray,
        fps: float,
        global_bpm: int,
    ) -> list[tuple[int, int, float]] | None:
        """返回 [(起始帧, bpm, lag帧), ...]，首段从帧 0 开始；无法测速时 None。"""
        win = int(round(_WINDOW_SEC * fps))
        hop_w = int(round(_HOP_SEC * fps))
        if len(flux) < win:
            # 不足一个分析窗：全局速度单段
            lag = fps * 60 / global_bpm
            return [(0, int(global_bpm), lag)]

        starts = list(range(0, len(flux) - win + 1, hop_w))
        raw: list[float] = []
        for start in starts:
            bpm, _conf, lag = self._autocorr_bpm(
                flux[start:start + win], fps, center_bpm=global_bpm
            )
            raw.append(float(bpm) if bpm is not None else np.nan)
        series = np.array(raw, dtype=np.float64)
        if np.isnan(series).all():
            return None

        # 用全局速度填无效窗，再做 3 点中值平滑
        series = np.where(np.isnan(series), float(global_bpm), series)
        padded = np.pad(series, 1, mode="edge")
        smoothed = np.array([
            np.median(padded[i:i + 3]) for i in range(len(series))
        ])

        # 迟滞分段：新速度需持续 2 窗且变化 ≥8% 才提交
        runs: list[list[int]] = []  # 每段：窗口下标列表
        for i, value in enumerate(smoothed):
            if not runs:
                runs.append([i])
                continue
            current_bpm = smoothed[runs[-1][0]]
            if abs(value - current_bpm) / current_bpm >= _CHANGE_RATIO:
                runs.append([i])
            else:
                runs[-1].append(i)

        # 帧边界 = 段内首窗的起始帧；末段延伸到包络末尾
        frame_end = len(flux)
        segments: list[tuple[int, int, float]] = []
        for ri, window_idxs in enumerate(runs):
            start_frame = starts[window_idxs[0]] if segments else 0
            end_frame = (
                starts[runs[ri + 1][0]] if ri + 1 < len(runs) else frame_end
            )
            bpm_i = int(round(float(np.median(smoothed[window_idxs]))))
            bpm_i = max(_BPM_MIN, min(_BPM_MAX, bpm_i))
            lag = fps * 60 / bpm_i
            segments.append((start_frame, bpm_i, lag))

        # 短段并入相邻较长段
        merged: list[tuple[int, int, float]] = []
        min_frames = _MIN_SEGMENT_SEC * fps
        for seg in segments:
            start_frame, bpm_i, lag = seg
            if merged:
                prev_start, prev_bpm, prev_lag = merged[-1]
                prev_dur = start_frame - prev_start
                if prev_dur < min_frames and len(merged) >= 1:
                    # 前一段太短：用当前段速度覆盖（保持其起始帧）
                    merged[-1] = (prev_start, bpm_i, lag)
                    continue
            merged.append(seg)
        # 最后一段若过短，并入倒数第二段（同 bpm 延长）
        if len(merged) >= 2:
            last_start, last_bpm, last_lag = merged[-1]
            if frame_end - last_start < min_frames:
                prev_start, prev_bpm, prev_lag = merged[-2]
                merged[-2] = (prev_start, prev_bpm, prev_lag)
                merged.pop()
        return merged or [(0, int(global_bpm), fps * 60 / global_bpm)]

    @staticmethod
    def _dominant_bpm(segments: list[tuple[int, int, float]], frame_end: int) -> int:
        """时长最长的速度段即主导速度（并列取靠前段，末段截至音频末尾）。"""
        best_idx, best_dur = 0, -1.0
        for i, (start, _bpm, _lag) in enumerate(segments):
            end = segments[i + 1][0] if i + 1 < len(segments) else frame_end
            dur = end - start
            if dur > best_dur:
                best_dur, best_idx = dur, i
        return segments[best_idx][1]

    def _segments_to_map(
        self, segments: list[tuple[int, int, float]], fps: float
    ) -> list[tuple[float, int]]:
        """帧段 → 秒域锚点（首锚点强制 0.0，相邻同 bpm 合并）。"""
        anchors: list[tuple[float, int]] = []
        for start_frame, bpm, _lag in segments:
            t = 0.0 if not anchors else start_frame / fps
            if anchors and anchors[-1][1] == bpm:
                continue
            anchors.append((round(t, 3), bpm))
        if not anchors or anchors[0][0] != 0.0:
            anchors.insert(0, (0.0, segments[0][1]))
        return anchors

    def _place_beats(
        self,
        segments: list[tuple[int, int, float]],
        phase_frame: int,
        frame_end: int,
    ) -> list[int]:
        """从相位起音开始，按当前时刻所属段的局部周期递推节拍点（跨段连续）。"""
        def lag_at(frame: float) -> float:
            active = segments[0]
            for seg in segments:
                if frame >= seg[0]:
                    active = seg
                else:
                    break
            return active[2]

        beats: list[int] = []
        t = float(max(0, phase_frame))
        while t < frame_end:
            beats.append(int(round(t)))
            t += lag_at(t)
        return beats

    # ---- 拍号：重音序列在 3 拍 / 4 拍周期上的自相关强弱 ----
    def _estimate_time_signature(self, accents: np.ndarray) -> tuple[int, int]:
        if len(accents) < 8:
            return FALLBACK_TS  # 证据不足回退 4/4
        # 重音对比度过低（如等强节拍器脉冲）时，小节重音不存在，拍号不可判 → 回退 4/4
        contrast = float(accents.std() / (abs(accents.mean()) + 1e-9))
        if contrast < _TS_MIN_ACCENT_CONTRAST:
            return FALLBACK_TS
        a = accents - accents.mean()
        energy = float(np.dot(a, a))
        if energy <= 0.0:
            return FALLBACK_TS

        def periodicity(period: int) -> float:
            if len(a) <= period:
                return 0.0
            return float(np.dot(a[:-period], a[period:])) / energy

        score3, score4 = periodicity(3), periodicity(4)
        # 3 拍周期需绝对值足够且明显占优才判 3/4，避免把 4/4 误判
        if score3 >= _TS_MIN_PERIODICITY and score3 > score4 * 1.15:
            return 3, 4
        return 4, 4

    # ---- 调性：Krumhansl–Schmuckler 轮廓匹配（大/小调各 12 个候选） ----
    def _estimate_key(self, note_midis: list[int]) -> tuple[str, int, float]:
        if not note_midis:
            return "", 0, 0.0
        hist = np.zeros(12)
        for midi in note_midis:
            hist[midi % 12] += 1.0
        hist /= hist.sum()

        best: tuple[str, int, float] = ("", 0, 0.0)
        for tonic in range(12):
            major = float(np.corrcoef(hist, np.roll(_KS_MAJOR, tonic))[0, 1])
            minor = float(np.corrcoef(hist, np.roll(_KS_MINOR, tonic))[0, 1])
            if major > best[2]:
                best = (f"{_PC_NAMES[tonic]} major", 60 + tonic, major)
            if minor > best[2]:
                best = (f"{_PC_NAMES[tonic]} minor", 60 + tonic, minor)
        name, tonic_midi, raw = best
        # 相关系数约 0.4~1.0，线性压到 0~1
        confidence = max(0.0, min(1.0, (raw + 0.2) / 1.2))
        return name, tonic_midi, confidence
