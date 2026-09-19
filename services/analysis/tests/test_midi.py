"""SMF 写入器单元测试：手工解析字节校验 format-1 多轨结构与事件时序。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.midi import MidiTrack, write_smf, write_smf_multitrack  # noqa: E402
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
    """返回 {'ons':[(tick,pitch,vel,ch)], 'offs':..., 'tempo', 'timesig', 'name', 'programs':{ch:prog}}。"""
    off = body_off
    tick = 0
    out = {"ons": [], "offs": [], "tempo": None, "timesig": None, "name": None, "programs": {}}
    while off < body_end:
        delta, off = read_vlq(buf, off)
        tick += delta
        status = buf[off]
        off += 1
        high = status & 0xF0
        ch = status & 0x0F
        if status == 0xFF:
            meta_type = buf[off]
            off += 1
            length, off = read_vlq(buf, off)
            data = buf[off:off + length]
            off += length
            if meta_type == 0x51 and length == 3:
                out["tempo"] = int.from_bytes(data, "big")
            elif meta_type == 0x58 and length == 4:
                out["timesig"] = (data[0], 2 ** data[1])
            elif meta_type == 0x03:
                out["name"] = data.decode("utf-8")
        elif high == 0x90:
            pitch, vel = buf[off], buf[off + 1]
            off += 2
            out["ons"].append((tick, pitch, vel, ch))
        elif high == 0x80:
            pitch = buf[off]
            off += 2
            out["offs"].append((tick, pitch, ch))
        elif high == 0xC0:
            out["programs"][ch] = buf[off]
            off += 1
        else:
            raise AssertionError(f"unexpected status 0x{status:02X}")
    return out


def iter_tracks(data):
    length, off = read_u32(data, 4)
    fmt, off = read_u16(data, off)
    ntrk, off = read_u16(data, off)
    tpq, off = read_u16(data, off)
    assert data[off:off + 4] == b"MTrk"
    tracks = []
    for _ in range(ntrk):
        tlen, body = read_u32(data, off + 4)
        tracks.append(parse_track(data, body, body + tlen))
        off = body + tlen
    return fmt, ntrk, tpq, tracks


class SmfWriterTest(unittest.TestCase):
    def setUp(self):
        self.notes = [
            DetectedNote(60, 0.0, 0.0, 0.6, 0.5, 0.9),
            DetectedNote(64, 0.0, 0.6, 0.6, 0.7, 0.9),
            DetectedNote(67, 0.0, 1.2, 0.6, 0.9, 0.9),
        ]

    def test_format1_conductor_plus_melody(self):
        data = write_smf(self.notes, bpm=100)
        fmt, ntrk, tpq, tracks = iter_tracks(data)
        self.assertEqual((fmt, ntrk, tpq), (1, 2, 480))

        conductor, melody = tracks
        # 指挥轨：速度 + 4/4 拍号，无音符
        self.assertEqual(conductor["tempo"], 600_000)
        self.assertEqual(conductor["timesig"], (4, 4))
        self.assertEqual(conductor["ons"], [])

        # 旋律轨：轨道名 + 钢琴 program + 三个音在通道 0
        self.assertEqual(melody["name"], "人声主旋律")
        self.assertEqual(melody["programs"], {0: 0})
        self.assertEqual([p for _, p, _, _ in melody["ons"]], [60, 64, 67])
        self.assertTrue(all(ch == 0 for _, _, _, ch in melody["ons"]))

    def test_event_ticks_and_velocity(self):
        data = write_smf(self.notes, bpm=100)
        _, _, _, tracks = iter_tracks(data)
        ons = tracks[1]["ons"]
        offs = tracks[1]["offs"]
        # 100 BPM、TPQ=480 → 0.6s = 480 ticks
        self.assertEqual([t for t, _, _, _ in ons], [0, 480, 960])
        self.assertEqual(ons[0][2], round(0.5 * 127))
        self.assertEqual([t for t, _, _ in offs], [480, 960, 1440])

    def test_multitrack_separate_channels_and_programs(self):
        bass = [DetectedNote(36, 0.0, 0.0, 1.8, 0.8, 1.0)]
        pad = [
            DetectedNote(60, 0.0, 0.0, 1.8, 0.5, 1.0),
            DetectedNote(64, 0.0, 0.0, 1.8, 0.5, 1.0),
            DetectedNote(67, 0.0, 0.0, 1.8, 0.5, 1.0),
        ]
        data = write_smf_multitrack(
            [
                MidiTrack("主旋律", self.notes, program=0, channel=0),
                MidiTrack("低音", bass, program=32, channel=1),
                MidiTrack("和弦垫", pad, program=48, channel=2),
            ],
            bpm=120,
        )
        fmt, ntrk, _, tracks = iter_tracks(data)
        self.assertEqual((fmt, ntrk), (1, 4))
        names = [t["name"] for t in tracks[1:]]
        self.assertEqual(names, ["主旋律", "低音", "和弦垫"])
        self.assertEqual(tracks[2]["programs"], {1: 32})
        self.assertEqual(tracks[3]["programs"], {2: 48})
        # 同一拍点上的和弦三个音互不丢音
        self.assertEqual(len(tracks[3]["ons"]), 3)
        self.assertTrue(all(ch == 2 for _, _, _, ch in tracks[3]["ons"]))
        # 指挥轨速度跟随 120 BPM
        self.assertEqual(tracks[0]["tempo"], 500_000)

    def test_drum_channel_remapped_and_dedup(self):
        # 两条都请求通道 9（鼓）→ 重映射后仍需互不相同且不等于 9
        data = write_smf_multitrack(
            [
                MidiTrack("A", self.notes[:1], program=0, channel=9),
                MidiTrack("B", self.notes[1:], program=0, channel=9),
            ],
            bpm=100,
        )
        _, ntrk, _, tracks = iter_tracks(data)
        self.assertEqual(ntrk, 3)
        chans = [list(t["programs"].keys()) for t in tracks[1:]]
        flat = [c for cs in chans for c in cs]
        self.assertNotIn(9, flat)
        self.assertEqual(len(flat), len(set(flat)))

    def test_empty_notes_still_valid(self):
        data = write_smf([], bpm=120)
        self.assertIn(b"MThd", data)
        self.assertIn(bytes([0xFF, 0x2F, 0x00]), data)
        fmt, ntrk, _, tracks = iter_tracks(data)
        self.assertEqual((fmt, ntrk), (1, 2))
        self.assertEqual(tracks[0]["tempo"], 500_000)


if __name__ == "__main__":
    unittest.main()
