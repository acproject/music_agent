"""最小 Standard MIDI File（SMF）写入器（M3，纯标准库）。

M3 只需要把 NoteSequence 导出为可下载的 .mid：单轨（format 0）、
一个速度元事件 + note on/off，零第三方依赖。
后续若需要多轨/弯音/拍号，可替换为 pretty-midi / miditype，文件级契约不变。
"""

from __future__ import annotations

from .notes import DetectedNote

_TPQ = 480  # 每四分音符 tick 数（pulses per quarter）


def _u32(value: int) -> bytes:
    return value.to_bytes(4, "big")


def _u16(value: int) -> bytes:
    return value.to_bytes(2, "big")


def _vlq(value: int) -> bytes:
    """MIDI 可变长数量（最大 4 字节，足够单段音频的 tick 跨度）。"""
    value = max(0, int(value))
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    return bytes(reversed(out))


def _chunk(kind: bytes, body: bytes) -> bytes:
    return kind + _u32(len(body)) + body


def _tempo_meta(bpm: int) -> bytes:
    micros_per_quarter = int(round(60_000_000 / max(1, bpm)))
    return b"\x00" + bytes([0xFF, 0x51, 0x03]) + micros_per_quarter.to_bytes(3, "big")


def write_smf(notes: list[DetectedNote], bpm: int = 100) -> bytes:
    """音符序列 → format-0 .mid 二进制。"""
    sec_per_tick = 60.0 / (max(1, bpm) * _TPQ)

    # (绝对 tick, 排序键, 原始字节)；同一 tick 先收后发，避免音符首尾粘连
    events: list[tuple[int, int, bytes]] = []
    for n in notes:
        start = int(round(n.onset / sec_per_tick))
        end = max(start + 1, int(round((n.onset + n.duration) / sec_per_tick)))
        velocity = max(1, min(127, round(n.velocity * 127)))
        pitch = max(0, min(127, n.midi))
        events.append((end, 0, bytes([0x80, pitch, 0])))                      # note off
        events.append((start, 1, bytes([0x90, pitch, velocity])))              # note on

    events.sort(key=lambda x: (x[0], x[1]))

    body = bytearray(_tempo_meta(bpm))
    prev_tick = 0
    for tick, _key, raw in events:
        body += _vlq(tick - prev_tick) + raw
        prev_tick = tick
    body += _vlq(0) + bytes([0xFF, 0x2F, 0x00])  # end of track

    header = _chunk(b"MThd", _u16(0) + _u16(1) + _u16(_TPQ))
    return header + _chunk(b"MTrk", bytes(body))
