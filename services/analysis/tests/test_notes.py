"""NoteTracker 离线分割单元测试：合成已知音符的单音信号验证（无外部音频依赖）。"""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.notes import NoteTracker  # noqa: E402

SR = 16_000


def midi_freq(midi: int) -> float:
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def synth_legato(midis, note_sec=0.5, amp=0.3, fade_sec=0.01):
    """连续不同音高、全局相位连续（模拟连音/连唱），内部无静音。"""
    total = int(len(midis) * note_sec * SR)
    t = np.arange(total) / SR
    pcm = np.zeros(total, dtype=np.float64)
    for i, m in enumerate(midis):
        lo = int(i * note_sec * SR)
        hi = int((i + 1) * note_sec * SR)
        pcm[lo:hi] = amp * np.sin(2 * np.pi * midi_freq(m) * t[lo:hi])
    fade = int(fade_sec * SR)
    pcm[:fade] *= np.linspace(0, 1, fade)
    pcm[-fade:] *= np.linspace(1, 0, fade)
    return pcm.astype(np.float32)


def synth_spaced(midis, note_sec=0.4, gap_sec=0.15, amp=0.3):
    """同音高/不同音高音符之间带明确静音间隔，每段独立相位。"""
    step = note_sec + gap_sec
    total = int((len(midis) * step + gap_sec) * SR)
    pcm = np.zeros(total, dtype=np.float64)
    for i, m in enumerate(midis):
        start = int(i * step * SR)
        n = int(note_sec * SR)
        tt = np.arange(n) / SR
        seg = amp * np.sin(2 * np.pi * midi_freq(m) * tt)
        pcm[start:start + n] = seg
    return pcm.astype(np.float32)


def synth_reattack(freq=440.0, total_sec=0.8, split=0.37, amp=0.3):
    """同音高、无静音，但后半段相位重新开始（模拟同音反复咬字的能量突变）。

    split 刻意不取整周期数（440×0.37=162.8 周期），拼接处存在真实波形跳变；
    若取 0.5s 这类整周期边界，波形本身连续，物理上就不存在可检测的起音点。
    """
    n = int(total_sec * SR)
    t = np.arange(n) / SR
    pcm = np.where(
        t < split,
        amp * np.sin(2 * np.pi * freq * t),
        amp * np.sin(2 * np.pi * freq * (t - split)),
    )
    return pcm.astype(np.float32)


class NoteTrackerTest(unittest.TestCase):
    def setUp(self):
        self.tracker = NoteTracker(sample_rate=SR)

    def test_legato_three_pitches_split(self):
        pcm = synth_legato([60, 64, 67], note_sec=0.5)
        notes, _ = self.tracker.run(pcm)
        self.assertEqual(len(notes), 3, f"应切出 3 个音，实际 {len(notes)}: {notes}")
        self.assertEqual([n.midi for n in notes], [60, 64, 67])
        for n, expected_onset in zip(notes, [0.0, 0.5, 1.0], strict=True):
            self.assertLess(abs(n.onset - expected_onset), 0.08)
            self.assertAlmostEqual(n.duration, 0.5, delta=0.12)
            self.assertGreater(n.confidence, 0.5)
            self.assertGreater(n.velocity, 0.1)

    def test_repeated_note_with_silence(self):
        # 同音高 + 150ms 静音间隙（大于 70ms 桥接门限）→ 必须切成两个音
        pcm = synth_spaced([69, 69], note_sec=0.4, gap_sec=0.15)
        notes, _ = self.tracker.run(pcm)
        self.assertEqual(len(notes), 2, f"同音反复应切成 2 个音，实际 {notes}")
        self.assertTrue(all(n.midi == 69 for n in notes))
        self.assertLess(abs(notes[1].onset - 0.55), 0.08)

    def test_repeated_note_reattack_no_silence(self):
        # 同音高、无间隙但能量/相位突变 → 频谱通量补强项应切开
        pcm = synth_reattack()
        notes, _ = self.tracker.run(pcm)
        self.assertEqual(len(notes), 2, f"同音再触发应切成 2 个音，实际 {notes}")
        self.assertLess(abs(notes[1].onset - 0.37), 0.1)

    def test_silence_yields_no_notes(self):
        notes, track = self.tracker.run(np.zeros(SR, dtype=np.float32))
        self.assertEqual(notes, [])
        self.assertFalse(np.any(track.voiced))

    def test_short_blips_pruned(self):
        # 两个 30ms 短脉冲低于最小音长，不应产出音符
        pcm = np.zeros(SR // 2, dtype=np.float32)
        for at in (0.1, 0.3):
            s = int(at * SR)
            pcm[s:s + int(0.03 * SR)] = 0.3
        notes, _ = self.tracker.run(pcm)
        self.assertEqual(notes, [])

    def test_cents_offset_and_monotonic_time(self):
        pcm = synth_legato([62, 65], note_sec=0.6)
        notes, _ = self.tracker.run(pcm)
        self.assertEqual(len(notes), 2)
        for n in notes:
            self.assertTrue(-99.0 <= n.cents_offset <= 99.0)
        self.assertLess(notes[0].onset, notes[1].onset)

    def test_pitch_track_frame_grid(self):
        pcm = synth_legato([69], note_sec=0.8)
        notes, track = self.tracker.run(pcm)
        self.assertEqual(len(notes), 1)
        # hop=10ms：0.8s 音频约 80 帧（允许窗长造成的边界偏差）
        self.assertGreater(track.times.size, 70)
        self.assertLess(track.times[1] - track.times[0], 0.015)
        voiced_ratio = float(np.mean(track.voiced))
        self.assertGreater(voiced_ratio, 0.8)


if __name__ == "__main__":
    unittest.main()
