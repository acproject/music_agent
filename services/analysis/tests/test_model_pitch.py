"""CREPE ONNX 后端单元测试。

需要 onnxruntime 与本地权重 models/crepe/crepe_tiny.onnx；
任一缺失则整体 skip（CI 无权重环境不阻塞）。权重下载：
    python scripts/download_model.py --models tiny
"""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

REPO_ROOT = Path(__file__).resolve().parents[3]
MODEL_PATH = REPO_ROOT / "models" / "crepe" / "crepe_tiny.onnx"

try:
    import onnxruntime  # noqa: F401

    HAS_ORT = True
except ImportError:
    HAS_ORT = False

SKIP_REASON = "需要 onnxruntime 与 models/crepe/crepe_tiny.onnx（scripts/download_model.py）"

SR = 16_000


def midi_freq(midi: int) -> float:
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def sine(midi: float, seconds: float, amp: float = 0.3, sr: int = SR) -> np.ndarray:
    n = int(seconds * sr)
    t = np.arange(n) / sr
    x = amp * np.sin(2 * np.pi * midi_freq(int(midi)) * t)
    fade = int(0.01 * sr)
    x[:fade] *= np.linspace(0, 1, fade)
    x[-fade:] *= np.linspace(1, 0, fade)
    return x.astype(np.float32)


@unittest.skipUnless(HAS_ORT and MODEL_PATH.exists(), SKIP_REASON)
class CrepeBackendTest(unittest.TestCase):
    def setUp(self) -> None:
        from app.model_pitch import CrepeBackend

        self.backend = CrepeBackend(sample_rate=SR, model_size="tiny")

    def test_grid_matches_yin(self):
        """帧网格须与 YIN 回路一致：10ms 间隔、首帧中心 20ms。"""
        times, hz, midi, voiced, conf = self.backend.track(sine(69, 0.5))
        self.assertGreater(times.size, 30)
        self.assertAlmostEqual(times[0], 0.02, places=6)
        np.testing.assert_allclose(np.diff(times), 0.01, rtol=0, atol=1e-9)
        self.assertEqual(hz.shape, times.shape)
        self.assertEqual(midi.shape, times.shape)
        self.assertEqual(voiced.shape, times.shape)
        self.assertEqual(conf.shape, times.shape)

    def test_pure_sine_pitch_accuracy(self):
        """稳定正弦中段：CREPE tiny 的 f0 中值应落在 ±25 cents 内且高置信度。"""
        times, hz, midi, voiced, conf = self.backend.track(sine(69, 1.0))
        # 取中间 60% 帧，避开起止淡入淡出
        lo, hi = int(times.size * 0.2), int(times.size * 0.8)
        mid_voiced = voiced[lo:hi]
        self.assertGreater(mid_voiced.mean(), 0.8, "中段绝大多数帧应判为 voiced")
        med_midi = float(np.median(midi[lo:hi][mid_voiced]))
        self.assertAlmostEqual(med_midi, 69.0, delta=0.25)
        med_hz = float(np.median(hz[lo:hi][mid_voiced]))
        self.assertAlmostEqual(med_hz, 440.0, delta=440.0 * 2 ** (0.25 / 12) - 440.0)
        self.assertGreater(float(np.median(conf[lo:hi][mid_voiced])), 0.5)

    def test_multiple_pitches(self):
        for midi in (48, 60, 72):  # C3 / C4 / C5，跨三个八度
            times, hz, out_midi, voiced, _ = self.backend.track(sine(midi, 0.8))
            lo, hi = int(times.size * 0.25), int(times.size * 0.75)
            sel = voiced[lo:hi]
            self.assertGreater(sel.mean(), 0.7, f"midi={midi} voiced 比例过低")
            med = float(np.median(out_midi[lo:hi][sel]))
            self.assertAlmostEqual(med, float(midi), delta=0.35, msg=f"midi={midi}")

    def test_glide_frame_time_alignment(self):
        """快速滑音验证帧内容与时间戳对齐：C4→C5 / 1s 线性滑音。

        历史 bug：strided 取帧从 padded[0] 开始而时间戳从 win/2 起标注，
        帧内容比时间戳早 20ms，在 12 半音/秒的滑音上产生 ~24c 的虚假误差。
        """
        dur = 1.0
        n = int(dur * SR)
        t = np.arange(n) / SR
        inst_f = np.vectorize(lambda x: midi_freq(60 + 12.0 * min(x / dur, 1.0)))
        phase = 2 * np.pi * np.cumsum(inst_f(t)) / SR
        x = (0.3 * np.sin(phase)).astype(np.float32)

        times, _hz, midi_out, voiced, _conf = self.backend.track(x)
        lo, hi = int(times.size * 0.25), int(times.size * 0.75)
        sel = voiced[lo:hi]
        self.assertGreater(sel.mean(), 0.8)
        target = 60.0 + 12.0 * times[lo:hi] / dur
        err_cents = 100.0 * (midi_out[lo:hi][sel] - target[sel])
        self.assertLess(
            float(np.median(np.abs(err_cents))), 15.0,
            "滑音中段音分误差过大，疑似帧时间戳错位",
        )

    def test_silence_is_unvoiced(self):
        silence = (np.random.default_rng(0).normal(0, 1e-5, SR // 2)).astype(np.float32)
        times, hz, midi, voiced, conf = self.backend.track(silence)
        self.assertGreater(times.size, 0)
        self.assertFalse(bool(voiced.any()), "极低能量信号不应有 voiced 帧")
        np.testing.assert_array_equal(hz[voiced], np.empty(0))

    def test_resample_48k(self):
        """非 16k 输入走线性重采样，音高仍应准确。"""
        x = sine(69, 0.8, sr=48_000)
        backend = type(self.backend)(sample_rate=48_000, model_size="tiny")
        times, _hz, midi, voiced, _conf = backend.track(x)
        lo, hi = int(times.size * 0.25), int(times.size * 0.75)
        sel = voiced[lo:hi]
        self.assertGreater(sel.mean(), 0.7)
        self.assertAlmostEqual(
            float(np.median(midi[lo:hi][sel])), 69.0, delta=0.35
        )


@unittest.skipUnless(HAS_ORT and MODEL_PATH.exists(), SKIP_REASON)
class CrepeNoteTrackerIntegrationTest(unittest.TestCase):
    def _spaced(self, midis, note_sec=0.6, gap_sec=0.15, amp=0.3):
        step = note_sec + gap_sec
        total = int((len(midis) * step + gap_sec) * SR)
        pcm = np.zeros(total, dtype=np.float64)
        for i, m in enumerate(midis):
            start = int(i * step * SR)
            n = int(note_sec * SR)
            tt = np.arange(n) / SR
            pcm[start:start + n] = amp * np.sin(2 * np.pi * midi_freq(m) * tt)
        return pcm.astype(np.float32)

    def test_segmentation_contract_unchanged(self):
        """经 CREPE 后端分割出的音符字段与 YIN 路径同契约、音高正确。"""
        from app.model_pitch import CrepeBackend
        from app.notes import NoteTracker

        backend = CrepeBackend(sample_rate=SR, model_size="tiny")
        tracker = NoteTracker(sample_rate=SR, backend=backend)
        notes, track = tracker.run(self._spaced([69, 76]))

        self.assertTrue(track.times.size > 0)
        stable = [n for n in notes if n.duration >= 0.2]
        detected = {n.midi for n in stable}
        self.assertTrue(
            {69, 76}.issubset(detected),
            f"应识别出 A4/E5 两个长音，实际：{sorted((n.midi, n.duration) for n in notes)}",
        )
        for n in stable:
            self.assertGreaterEqual(n.onset, 0.0)
            self.assertGreater(n.duration, 0.0)
            self.assertGreater(n.confidence, 0.0)


if __name__ == "__main__":
    unittest.main()
