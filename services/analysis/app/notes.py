"""离线单音 Note 分割（M3，纯 numpy）。

输入整段单声道 PCM，输出音符级中间表示，供 AnalyzeAudio 组装 NoteSequence：

  PCM
   ├─ 短 hop（10ms）逐帧 YIN → midi_cents / voiced / confidence / rms
   ├─ STFT 频谱通量（spectral flux）   → 同音反复等"音高不跳变"的起音
   └─ 轨迹聚合：短间隙桥接 → 稳定音高跳变切分 → 通量补强切分
                                                            → 最小音长修剪 → DetectedNote

与实时链路共享 pitch.YinDetector，保持"算法可替换、输出契约不变"：
后续接入 aubio onset / crepe / basic-pitch 时，main.py 只需替换本模块内部实现。

适用范围：单音旋律（哼唱 / 单音乐器）。和弦、复调不在 M3 范围内。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .pitch import YinDetector, PitchResult


@dataclass(frozen=True)
class DetectedNote:
    """分割结果；字段与 music.v1.NoteEvent 一一对应。"""

    midi: int
    cents_offset: float
    onset: float
    duration: float
    velocity: float
    confidence: float


@dataclass(frozen=True)
class PitchTrack:
    """整段 f0 轨迹（pipeline 含 "pitch" 时随事件返回）。"""

    times: np.ndarray
    frequency_hz: np.ndarray
    midi_cents: np.ndarray
    voiced: np.ndarray
    confidence: np.ndarray


@dataclass(frozen=True)
class SegmentationParams:
    hop_sec: float = 0.01          # 帧移 10ms（离线可比实时 40ms 更密）
    win_sec: float = 0.04          # YIN 分析窗 40ms（与实时一致）
    min_note_sec: float = 0.09     # 短于此长度的 voiced 段视为碎噪丢弃
    merge_gap_sec: float = 0.07    # 同音高间短于此的无声间隙桥接（辅音/换气短缺口）
    pitch_jump_semitones: float = 0.7  # 稳定音高跳变阈值
    flux_z_split: float = 2.0      # voiced 段内靠通量切分所需 z-score
    velocity_ref_rms: float = 0.25  # 力度归一化参考能量


class NoteTracker:
    """整段 PCM → f0 轨迹 + 音符分割。"""

    def __init__(
        self,
        sample_rate: int = 16_000,
        params: SegmentationParams | None = None,
        backend: object | None = None,
    ) -> None:
        self.sample_rate = sample_rate
        self.p = params or SegmentationParams()
        # backend 鸭型分派：
        #   - 默认 pitch.YinDetector：逐帧 detect（实时链路同款，零依赖）；
        #   - model_pitch.CrepeBackend：整段批量 track()（ONNX 高质量后端）。
        # 两者输出同一 10ms 帧网格，后续分割逻辑与 f0 来源解耦。
        self.detector = backend or YinDetector(sample_rate=sample_rate)
        self.hop = max(1, int(round(self.p.hop_sec * sample_rate)))
        self.win = max(self.hop, int(round(self.p.win_sec * sample_rate)))

    # ------------------------------------------------------------------ f0 轨迹

    def _track_pitch(self, pcm: np.ndarray) -> PitchTrack:
        n = len(pcm)
        if n < self.win:
            empty = np.empty(0, dtype=np.float64)
            return PitchTrack(empty, empty.copy(), empty.copy(),
                              np.empty(0, dtype=bool), empty.copy())

        starts = np.arange(0, n - self.win + 1, self.hop)
        count = starts.size
        times = np.empty(count, dtype=np.float64)
        hz = np.zeros(count, dtype=np.float64)
        midi = np.zeros(count, dtype=np.float64)
        voiced = np.zeros(count, dtype=bool)
        conf = np.zeros(count, dtype=np.float64)

        batch_track = getattr(self.detector, "track", None)
        if callable(batch_track):
            # 批量后端（CREPE）：内部固定 16k + 自有取帧，返回同网格数组
            b_times, b_hz, b_midi, b_voiced, b_conf = batch_track(
                pcm, self.p.hop_sec, self.p.win_sec
            )
            count = min(count, b_times.size)
            times[:count] = b_times[:count]
            hz[:count] = b_hz[:count]
            midi[:count] = b_midi[:count]
            voiced[:count] = b_voiced[:count]
            conf[:count] = b_conf[:count]
            if b_times.size < starts.size:
                # 重采样后帧数略少：截断尾部未填充槽位
                times = times[:count]
                hz = hz[:count]
                midi = midi[:count]
                voiced = voiced[:count]
                conf = conf[:count]
        else:
            for k, s in enumerate(starts):
                r: PitchResult = self.detector.detect(pcm[s:s + self.win])
                # 帧时间取分析窗中点：YIN 描述的是窗内基频，
                # 中点比窗起点更接近实际发声时刻。
                times[k] = (s + self.win / 2) / self.sample_rate
                if r.voiced:
                    hz[k] = r.frequency_hz
                    midi[k] = r.midi_cents
                    voiced[k] = True
                    conf[k] = r.confidence

        # voiced 帧做 3 点中值平滑，剔除单帧八度/五度跳变；unvoiced 帧不参与
        if count >= 3:
            smoothed = midi.copy()
            for i in range(1, count - 1):
                if voiced[i]:
                    neigh = [midi[j] for j in (i - 1, i, i + 1) if voiced[j]]
                    smoothed[i] = float(np.median(neigh))
            midi = smoothed

        return PitchTrack(times, hz, midi, voiced, conf)

    # ------------------------------------------------------------ 频谱通量 onset

    def _spectral_flux(self, pcm: np.ndarray) -> np.ndarray:
        """与 hop 网格对齐的归一化频谱通量；长度不足一帧 FFT 时返回全零。"""
        nfft = 1024
        if len(pcm) < nfft:
            return np.zeros(0, dtype=np.float64)

        window = np.hanning(nfft)
        count = 1 + (len(pcm) - nfft) // self.hop
        flux = np.zeros(count, dtype=np.float64)
        prev: np.ndarray | None = None

        for k in range(count):
            s = k * self.hop
            mag = np.abs(np.fft.rfft(pcm[s:s + nfft] * window))
            if prev is not None:
                diff = mag - prev
                pos = diff[diff > 0.0]
                flux[k] = float(pos.sum() / (np.linalg.norm(mag) + 1e-9))
            prev = mag
        return flux

    # ------------------------------------------------------------------ 轨迹聚合

    @staticmethod
    def _runs(flag: np.ndarray) -> list[tuple[int, int]]:
        """返回 True 连续段的 [起, 止) 帧下标。"""
        if flag.size == 0:
            return []
        idx = np.flatnonzero(flag)
        if idx.size == 0:
            return []
        breaks = np.flatnonzero(np.diff(idx) > 1)
        starts = np.concatenate(([idx[0]], idx[breaks + 1]))
        ends = np.concatenate((idx[breaks], [idx[-1]])) + 1
        return list(zip(starts.tolist(), ends.tolist(), strict=True))

    def _bridge_short_gaps(self, track: PitchTrack) -> np.ndarray:
        """桥接同音高 voiced 段之间的短间隙，返回桥接后的 voiced 掩码。

        不同音高的短间隙不桥接（留给音高跳变规则切分成两个音）。
        """
        voiced = track.voiced.copy()
        voiced_runs = self._runs(voiced)
        max_gap = int(round(self.p.merge_gap_sec / self.p.hop_sec))
        for (s1, e1), (s2, e2) in zip(voiced_runs, voiced_runs[1:], strict=False):
            gap = s2 - e1
            if gap <= 0 or gap > max_gap:
                continue
            p1 = float(np.median(track.midi_cents[max(s1, e1 - 3):e1]))
            p2 = float(np.median(track.midi_cents[s2:min(e2, s2 + 3)]))
            if abs(p1 - p2) <= 0.5:
                voiced[e1:s2] = True
                # 间隙帧线性插值，避免中值统计被拉偏
                track.midi_cents[e1:s2] = np.linspace(p1, p2, gap, endpoint=False)
        return voiced

    def _pitch_split_points(self, track: PitchTrack, s: int, e: int) -> list[int]:
        """voiced 段内部的稳定音高跳变点（新音从该帧起算）。"""
        points: list[int] = []
        # 前窗取 [i-3, i)：i 必须 >= s+3，否则 run 起点接近 0 时下标为负产生空切片
        for i in range(s + 3, e - 2):
            prev3 = track.midi_cents[i - 3:i]
            next3 = track.midi_cents[i:i + 3]
            if (np.abs(float(np.median(next3)) - float(np.median(prev3)))
                    >= self.p.pitch_jump_semitones):
                # 相邻跳变点保持最小间距（约一个最小音长）
                if not points or i - points[-1] >= int(
                    round(self.p.min_note_sec / self.p.hop_sec)
                ):
                    points.append(i)
        return points

    def _flux_split_points(
        self,
        track: PitchTrack,
        flux: np.ndarray,
        s: int,
        e: int,
    ) -> list[int]:
        """voiced 段内部的频谱通量强起音点（同音高反复咬字/再触发）。"""
        if flux.size < 5:
            return []
        mu, sigma = float(np.mean(flux)), float(np.std(flux))
        if sigma < 1e-9:
            return []
        z = (flux - mu) / sigma

        points: list[int] = []
        min_dist = max(3, int(round(self.p.min_note_sec / self.p.hop_sec)))
        # flux 帧时间为 s_hop*k + nfft/2，换算到轨迹帧下标（轨迹时间也是窗中点）
        t_offset_frames = (1024 / 2 - self.win / 2) / self.sample_rate / self.p.hop_sec
        for k in np.flatnonzero(z > self.p.flux_z_split):
            k = int(k)
            if k - 2 < 0 or k + 2 >= flux.size:
                continue
            if flux[k] != np.max(flux[k - 2:k + 3]):
                continue
            fi = int(round(k - t_offset_frames))
            if s + min_dist <= fi < e - min_dist and all(
                abs(fi - q) >= min_dist for q in points
            ):
                points.append(fi)
        return points

    def _make_note(
        self,
        track: PitchTrack,
        rms: np.ndarray,
        s: int,
        e: int,
    ) -> DetectedNote:
        """把一段连续同音乐音帧聚合为 Note。"""
        # 音高统计去掉首尾各 ~50ms 的过渡帧（滑音/抖音起止）
        trim = max(2, int(round(0.05 / self.p.hop_sec)))
        lo = min(s + trim, e - 1)
        hi = max(e - trim, lo + 1)
        med_midi = float(np.median(track.midi_cents[lo:hi]))
        midi = int(np.clip(round(med_midi), 0, 127))
        cents = float(np.clip((med_midi - midi) * 100.0, -99.0, 99.0))

        onset = float(track.times[s] - self.p.win_sec / 2)
        onset = max(0.0, onset)
        # 时长按帧跨度计，含半个窗的前后补偿
        duration = float((e - s) * self.hop / self.sample_rate)

        energy = float(np.percentile(rms[s:e], 90))
        velocity = float(np.clip(energy / self.p.velocity_ref_rms, 0.05, 1.0))
        voicing_ratio = float(np.mean(track.voiced[s:e]))
        confidence = float(
            np.clip(np.mean(track.confidence[s:e]) * voicing_ratio, 0.0, 1.0)
        )
        return DetectedNote(midi, cents, onset, duration, velocity, round(confidence, 3))

    # ------------------------------------------------------------------ 主入口

    def run(self, pcm: np.ndarray) -> tuple[list[DetectedNote], PitchTrack]:
        pcm = np.ascontiguousarray(pcm, dtype=np.float32)
        track = self._track_pitch(pcm)
        if track.times.size == 0:
            return [], track

        # 每帧 RMS（与轨迹帧网格一致）
        rms = np.zeros(track.times.size, dtype=np.float64)
        for k, t in enumerate(track.times):
            center = int(round(t * self.sample_rate))
            lo = max(0, center - self.win // 2)
            hi = min(len(pcm), lo + self.win)
            seg = pcm[lo:hi]
            rms[k] = float(np.sqrt(np.mean(seg * seg))) if seg.size else 0.0

        flux = self._spectral_flux(pcm)
        bridged = self._bridge_short_gaps(track)

        notes: list[DetectedNote] = []
        min_frames = max(1, int(round(self.p.min_note_sec / self.p.hop_sec)))
        for rs, re_ in self._runs(bridged):
            cuts = sorted(
                self._pitch_split_points(track, rs, re_)
                + self._flux_split_points(track, flux, rs, re_)
            )
            bounds = [rs, *cuts, re_]
            for s, e in zip(bounds, bounds[1:]):
                if e - s < min_frames:
                    continue
                notes.append(self._make_note(track, rms, s, e))

        notes.sort(key=lambda n: n.onset)
        return notes, track
