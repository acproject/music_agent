"""RhythmDetector 单测：合成已知速度脉冲与已知调性音符验证推断。"""

import unittest

import numpy as np

from app.rhythm import FALLBACK_BPM, RhythmDetector

SR = 16_000


def pulse_track(bpm: int, seconds: float = 4.0, sr: int = SR) -> np.ndarray:
    """每隔一个拍点放一小段衰减正弦脉冲（模拟踢鼓式强拍）。"""
    pcm = np.zeros(int(seconds * sr), dtype=np.float32)
    period = int(60 / bpm * sr)
    tone_len = int(0.06 * sr)
    t = np.arange(tone_len) / sr
    burst = 0.5 * np.sin(2 * np.pi * 150 * t) * np.exp(-t * 40)
    for start in range(0, len(pcm) - tone_len, period):
        pcm[start:start + tone_len] += burst
    return pcm


def two_tempo_track(bpm_a: int = 120, bpm_b: int = 90,
                    seconds_a: float = 4.0, seconds_b: float = 4.0,
                    sr: int = SR) -> np.ndarray:
    """前后两段不同速度的脉冲拼接（变速点在 seconds_a）。"""
    a = pulse_track(bpm_a, seconds_a, sr)
    b = pulse_track(bpm_b, seconds_b, sr)
    return np.concatenate([a, b]).astype(np.float32)


class TempoTests(unittest.TestCase):
    def test_known_bpm_120(self):
        det = RhythmDetector(SR)
        result = det.analyze(pulse_track(120))
        self.assertAlmostEqual(result.bpm, 120, delta=4)
        self.assertGreaterEqual(result.tempo_confidence, 0.3)
        self.assertGreater(len(result.beats), 4)
        # 第一拍定位为第 1 小节第 1 拍
        self.assertEqual(result.beats[0].bar, 1)
        self.assertEqual(result.beats[0].beat, 1)
        # 4/4 下第 5 个节拍点进入第 2 小节
        self.assertEqual(result.beats[4].bar, 2)
        self.assertEqual(result.beats[4].beat, 1)

    def test_known_bpm_90(self):
        det = RhythmDetector(SR)
        result = det.analyze(pulse_track(90, seconds=5.0))
        self.assertAlmostEqual(result.bpm, 90, delta=4)

    def test_silence_falls_back(self):
        det = RhythmDetector(SR)
        result = det.analyze(np.zeros(SR, dtype=np.float32))
        self.assertEqual(result.bpm, FALLBACK_BPM)
        self.assertEqual(result.tempo_confidence, 0.0)
        self.assertEqual(result.beats, [])
        self.assertEqual(result.time_signature_num, 4)
        self.assertEqual(result.tempo_map, [(0.0, FALLBACK_BPM)])


class TimeSignatureTests(unittest.TestCase):
    def test_4_4_accent_pattern(self):
        det = RhythmDetector(SR)
        # 强-弱-弱-弱 循环
        accents = np.tile([1.0, 0.15, 0.15, 0.15], 6)
        num, den = det._estimate_time_signature(accents)
        self.assertEqual((num, den), (4, 4))

    def test_3_4_accent_pattern(self):
        det = RhythmDetector(SR)
        accents = np.tile([1.0, 0.15, 0.15], 8)
        num, den = det._estimate_time_signature(accents)
        self.assertEqual((num, den), (3, 4))

    def test_insufficient_beats_fallback(self):
        det = RhythmDetector(SR)
        num, den = det._estimate_time_signature(np.array([1.0, 0.2, 0.2]))
        self.assertEqual((num, den), (4, 4))

    def test_flat_accents_fallback(self):
        det = RhythmDetector(SR)
        # 等强节拍器脉冲：没有强弱拍层级，无法判 3/4 → 回退 4/4
        num, den = det._estimate_time_signature(np.ones(16))
        self.assertEqual((num, den), (4, 4))


class KeyTests(unittest.TestCase):
    def test_c_major_scale(self):
        det = RhythmDetector(SR)
        # C 大调音阶 + C/E/G 长音加权
        notes = [60, 62, 64, 65, 67, 69, 71, 72, 60, 64, 67]
        key, tonic, conf = det._estimate_key(notes)
        self.assertEqual(key, "C major")
        self.assertEqual(tonic, 60)
        self.assertGreater(conf, 0.5)

    def test_a_minor_scale(self):
        det = RhythmDetector(SR)
        notes = [57, 59, 60, 62, 64, 65, 67, 69, 57, 60, 64]
        key, tonic, _ = det._estimate_key(notes)
        self.assertEqual(key, "A minor")
        self.assertEqual(tonic, 69)

    def test_empty_notes(self):
        det = RhythmDetector(SR)
        key, tonic, conf = det._estimate_key([])
        self.assertEqual(key, "")
        self.assertEqual(tonic, 0)
        self.assertEqual(conf, 0.0)

    def test_full_analyze_attaches_key(self):
        det = RhythmDetector(SR)
        result = det.analyze(pulse_track(120), note_midis=[60, 64, 67, 72])
        self.assertEqual(result.key, "C major")
        self.assertEqual(result.time_signature_den, 4)


class TempoMapSegmentationTests(unittest.TestCase):
    def test_constant_tempo_single_anchor(self):
        det = RhythmDetector(SR)
        result = det.analyze(pulse_track(120, seconds=8.0))
        self.assertEqual(len(result.tempo_map), 1)
        self.assertEqual(result.tempo_map[0][0], 0.0)
        self.assertAlmostEqual(result.tempo_map[0][1], 120, delta=5)

    def test_two_tempo_segments_detected(self):
        det = RhythmDetector(SR)
        result = det.analyze(two_tempo_track(120, 90))
        self.assertEqual(len(result.tempo_map), 2)
        t0, bpm0 = result.tempo_map[0]
        t1, bpm1 = result.tempo_map[1]
        self.assertEqual(t0, 0.0)
        self.assertAlmostEqual(bpm0, 120, delta=5)
        self.assertAlmostEqual(bpm1, 90, delta=5)
        # 变速点真值在 4.0s；窗口粒度 1s，留 ±1.5s 容差
        self.assertGreaterEqual(t1, 2.5)
        self.assertLessEqual(t1, 5.5)
        # 检出变速点偏前（~3s），后段更长，主导速度应为后段 90
        self.assertAlmostEqual(result.bpm, 90, delta=5)

    def test_beats_spread_apart_after_rallentando(self):
        det = RhythmDetector(SR)
        result = det.analyze(two_tempo_track(120, 90))
        onsets = [b.onset for b in result.beats]
        mid = 4.0
        gaps_before = [
            b - a for a, b in zip(onsets, onsets[1:]) if b <= mid
        ]
        gaps_after = [
            b - a for a, b in zip(onsets, onsets[1:]) if a >= mid + 0.5
        ]
        self.assertTrue(gaps_before and gaps_after)
        # 90 BPM 拍间距 0.667s，应明显大于 120 BPM 的 0.5s
        self.assertLess(np.median(gaps_before), 0.58)
        self.assertGreater(np.median(gaps_after), 0.60)
        # 小节编号连续递增、不回跳
        bars = [b.bar for b in result.beats]
        self.assertEqual(bars, sorted(bars))

    def test_anchor_structure_invariants(self):
        det = RhythmDetector(SR)
        result = det.analyze(two_tempo_track(120, 90))
        times = [t for t, _ in result.tempo_map]
        self.assertEqual(times, sorted(times))
        self.assertTrue(all(60 <= b <= 200 for _, b in result.tempo_map))


if __name__ == "__main__":
    unittest.main()
