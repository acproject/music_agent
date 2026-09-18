"""write_smf 最小 SMF 写入器单元测试：手工解析字节校验结构与事件时序。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.midi import write_smf  # noqa: E402
from app.notes import DetectedNote  # noqa: E402


def read_u16(buf, off):
    return int.from_bytes(buf[off:off + 2], "big"), off + 2


def read_u32(buf, off):
    return int.from_bytes(buf[off:off + 4], "big"), off + 4


def read_vlq(buf, off):
    value = 0
    while True:
        b = buf[off]
        off += 1
        value = (value << 7) | (b & 0x7F)
        if not b & 0x80:
            return value, off


def parse_track(buf, body_off, body_end):
    """返回 (note_on[(tick,pitch,vel)], note_off[(tick,pitch)], tempo_micros)。"""
    off = body_off
    tick = 0
    ons, offs, tempo = [], [], None
    while off < body_end:
        delta, off = read_vlq(buf, off)
        tick += delta
        status = buf[off]
        off += 1
        if status == 0xFF:
            meta_type = buf[off]
            off += 1
            length, off = read_vlq(buf, off)
            if meta_type == 0x51 and length == 3:
                tempo = int.from_bytes(buf[off:off + 3], "big")
            off += length
        elif status == 0x90:
            pitch, vel = buf[off], buf[off + 1]
            off += 2
            ons.append((tick, pitch, vel))
        elif status == 0x80:
            pitch = buf[off]
            off += 2
            offs.append((tick, pitch))
        else:
            self_fail = f"unexpected status 0x{status:02X}"
            raise AssertionError(self_fail)
    return ons, offs, tempo


class SmfWriterTest(unittest.TestCase):
    def setUp(self):
        self.notes = [
            DetectedNote(60, 0.0, 0.0, 0.6, 0.5, 0.9),
            DetectedNote(64, 0.0, 0.6, 0.6, 0.7, 0.9),
            DetectedNote(67, 0.0, 1.2, 0.6, 0.9, 0.9),
        ]

    def test_header_and_track_structure(self):
        data = write_smf(self.notes, bpm=100)
        self.assertEqual(data[:4], b"MThd")
        length, off = read_u32(data, 4)
        self.assertEqual(length, 6)
        fmt, off = read_u16(data, off)
        ntrk, off = read_u16(data, off)
        tpq, off = read_u16(data, off)
        self.assertEqual((fmt, ntrk, tpq), (0, 1, 480))

        self.assertEqual(data[14:18], b"MTrk")
        track_len, body_off = read_u32(data, 18)
        ons, offs, tempo = parse_track(data, body_off, body_off + track_len)

        # 100 BPM → 600000 μs/四分音符
        self.assertEqual(tempo, 600_000)
        self.assertEqual([p for _, p, _ in ons], [60, 64, 67])
        self.assertEqual([p for _, p in offs], [60, 64, 67])

    def test_event_ticks_and_velocity(self):
        data = write_smf(self.notes, bpm=100)
        _, body_off = read_u32(data, 18)
        track_len = int.from_bytes(data[18:22], "big")
        ons, offs, _ = parse_track(data, body_off, body_off + track_len)

        # 100 BPM、TPQ=480 → 0.6s = 480 ticks
        self.assertEqual([t for t, _, _ in ons], [0, 480, 960])
        self.assertEqual(ons[0][2], round(0.5 * 127))
        # note off 在各自 onset + 0.6s
        self.assertEqual([t for t, _ in offs], [480, 960, 1440])

    def test_empty_notes_still_valid(self):
        data = write_smf([], bpm=120)
        self.assertIn(b"MThd", data)
        self.assertIn(bytes([0xFF, 0x2F, 0x00]), data)


if __name__ == "__main__":
    unittest.main()
