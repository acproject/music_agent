"""YIN 音高检测器单元测试：用已知频率的合成正弦验证（无外部音频依赖）。"""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pitch import YinDetector  # noqa: E402

SR = 16_000
FRAME = 640  # 40ms


def sine_frame(freq: float, frame_index: int, amplitude: float = 0.3) -> np.ndarray:
    start = frame_index * FRAME
    t = (np.arange(start, start + FRAME)) / SR
    return amplitude * np.sin(2 * np.pi * freq * t).astype(np.float32)


class YinDetectorTest(unittest.TestCase):
    def setUp(self):
        self.det = YinDetector(sample_rate=SR)

    def assert_freq_close(self, expected: float, tolerance_ratio: float = 0.01):
        # 取连续 4 帧，至少 3 帧 voiced 且频率误差在容差内
        voiced = []
        for i in range(4):
            r = self.det.detect(sine_frame(expected, i))
            if r.voiced:
                voiced.append(r.frequency_hz)
        self.assertGreaterEqual(len(voiced), 3, f"{expected}Hz 检出 voiced 帧不足")
        for f in voiced:
            self.assertLess(
                abs(f - expected) / expected,
                tolerance_ratio,
                f"期望 {expected}Hz，实测 {f:.1f}Hz",
            )

    def test_a4_440(self):
        self.assert_freq_close(440.0)

    def test_c4_261_63(self):
        self.assert_freq_close(261.63)

    def test_low_120(self):
        # 低音 40ms 内周期少，容差稍宽
        self.assert_freq_close(120.0, tolerance_ratio=0.02)

    def test_high_880(self):
        self.assert_freq_close(880.0)

    def test_silence_is_unvoiced(self):
        r = self.det.detect(np.zeros(FRAME, dtype=np.float32))
        self.assertFalse(r.voiced)
        self.assertEqual(r.frequency_hz, 0.0)
        self.assertEqual(r.midi_cents, 0.0)

    def test_white_noise_is_unvoiced(self):
        rng = np.random.default_rng(7)
        # 噪声有能量但无稳定周期：置信度应当较低
        unvoiced = 0
        for _ in range(8):
            r = self.det.detect(rng.standard_normal(FRAME).astype(np.float32) * 0.1)
            if not r.voiced:
                unvoiced += 1
        self.assertGreaterEqual(unvoiced, 6, "白噪声不应被频繁判为 voiced")

    def test_midi_mapping(self):
        # 440Hz = MIDI 69（A4）
        r = self.det.detect(sine_frame(440.0, 0))
        self.assertTrue(r.voiced)
        self.assertAlmostEqual(r.midi_cents, 69.0, delta=0.2)

    def test_dc_offset_sine(self):
        # 带直流偏置的正弦仍应正确检出
        frame = sine_frame(440.0, 0) + 0.2
        r = self.det.detect(frame)
        self.assertTrue(r.voiced)
        self.assertLess(abs(r.frequency_hz - 440.0) / 440.0, 0.01)

    def test_short_frame_guarded(self):
        r = self.det.detect(np.zeros(8, dtype=np.float32))
        self.assertFalse(r.voiced)


if __name__ == "__main__":
    unittest.main()
