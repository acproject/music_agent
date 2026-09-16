"""实时单音音高检测（YIN 算法，纯 numpy 实现）。

实时链路每帧只有 40ms（16kHz 下 640 采样）、每秒 25 帧，
numpy 向量化的 YIN 完全够用且零原生依赖。
后续高质量链路可无缝替换为 aubio / crepe，输出契约不变。

参考：de Cheveigné & Kawahara (2002), YIN, a fundamental frequency estimator.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class PitchResult:
    frequency_hz: float  # 基频；unvoiced 时为 0
    midi_cents: float    # 连续 MIDI 音高（含小数）；unvoiced 时为 0
    voiced: bool
    confidence: float    # 0..1，越大越可信


class YinDetector:
    def __init__(
        self,
        sample_rate: int = 16_000,
        fmin: float = 65.0,    # C2 附近，覆盖男低音
        fmax: float = 1200.0, # 高于 D6，覆盖女声/高音乐器主要音区
        threshold: float = 0.15,  # CMND 绝对阈值
        rms_floor: float = 0.01,   # 静音/极低能量门限
        min_confidence: float = 0.5,
    ) -> None:
        self.sample_rate = sample_rate
        self.threshold = threshold
        self.rms_floor = rms_floor
        self.min_confidence = min_confidence
        # tau 搜索范围（采样）；帧长约束在 detect 内再收紧
        self.tau_min = max(2, int(sample_rate / fmax))
        self.tau_max = int(sample_rate / fmin)

    def _diff_and_cmnd(self, frame: np.ndarray) -> np.ndarray:
        """差分函数 d(τ) 与累积均值归一化差分 d'(τ)。"""
        x = frame.astype(np.float64, copy=False)
        n = len(x)
        tau_max = min(self.tau_max, n - 2)

        # 自相关（640 点的直接相关代价很小）
        acf = np.correlate(x, x, mode="full")[n - 1:]
        total_energy = float(np.dot(x, x))

        # tail_energy(τ) = Σ_{j=0}^{n-1-τ} x[j+τ]² = E - Σ_{j=0}^{τ-1} x[j]²
        head_energy = np.concatenate(([0.0], np.cumsum(x * x)))
        tail_energy = total_energy - head_energy[: tau_max + 1]

        diff = total_energy + tail_energy - 2.0 * acf[: tau_max + 1]
        diff = np.maximum(diff, 0.0)

        cmnd = np.ones_like(diff)
        if tau_max >= 1:
            running = np.cumsum(diff[1:])
            taus = np.arange(1, tau_max + 1)
            # 防止首个样本除零
            mean = running / taus
            valid = mean > 1e-12
            cmnd[1: tau_max + 1] = np.where(valid, diff[1: tau_max + 1] / np.where(valid, mean, 1.0), 1.0)
        return cmnd

    @staticmethod
    def _parabolic_interp(values: np.ndarray, tau: int) -> float:
        """对谷值做抛物线插值，得到亚采样精度 τ。"""
        if 0 < tau < len(values) - 1:
            a, b, c = values[tau - 1], values[tau], values[tau + 1]
            denom = a - 2.0 * b + c
            if abs(denom) > 1e-12:
                return tau + 0.5 * (a - c) / denom
        return float(tau)

    def detect(self, pcm: np.ndarray) -> PitchResult:
        frame = np.asarray(pcm, dtype=np.float32)
        if frame.size < self.tau_max + 2:
            return PitchResult(0.0, 0.0, False, 0.0)

        # 去直流：麦克风常有微小 DC offset，会抬高频谱底部影响 YIN
        frame = frame - float(np.mean(frame))

        rms = float(np.sqrt(np.mean(frame * frame)))
        if rms < self.rms_floor:
            return PitchResult(0.0, 0.0, False, 0.0)

        cmnd = self._diff_and_cmnd(frame)

        search = cmnd[self.tau_min:]
        below = np.flatnonzero(search < self.threshold)
        if below.size == 0:
            # 未越过阈值：取全局最小值，但要求置信度足够高
            tau = int(np.argmin(cmnd[self.tau_min:]) + self.tau_min)
        else:
            tau = int(below[0] + self.tau_min)
            # 继续向下走到局部最小（YIN 建议）
            upper = min(len(cmnd) - 1, tau + 8)
            local = tau + int(np.argmin(cmnd[tau: upper + 1]))
            tau = local

        confidence = float(np.clip(1.0 - cmnd[tau], 0.0, 1.0))
        if confidence < self.min_confidence:
            return PitchResult(0.0, 0.0, False, confidence)

        tau_hat = self._parabolic_interp(cmnd, tau)
        f0 = self.sample_rate / tau_hat

        midi_cents = 69.0 + 12.0 * np.log2(f0 / 440.0)
        return PitchResult(
            frequency_hz=float(f0),
            midi_cents=float(midi_cents),
            voiced=True,
            confidence=confidence,
        )
