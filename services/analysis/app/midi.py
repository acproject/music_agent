"""Standard MIDI File（SMF）写入器（M3+，纯标准库）。

支持：
  - format 1 多轨：轨道 0 为指挥轨（速度 + 拍号元事件），其后每条 MidiTrack
    独立一轨，带轨道名、GM 乐器（program change）、独立通道；
  - 480 TPQ、秒→tick 量化、note on/off、力度保留；
  - 同一 tick 先收后发，避免音符首尾粘连。

M3 主链路仍调用 ``write_smf(notes, bpm)``（单旋律轨，向后兼容）；
多轨场景（如前端导出旋律+伴奏）调用 ``write_smf_multitrack``。
零第三方依赖；若后续需要弯音/控制器/系统专有事件，可替换为 pretty-midi。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .notes import DetectedNote

_TPQ = 480  # 每四分音符 tick 数（pulses per quarter）
_DRUMS_CHANNEL = 9  # GM 打击乐通道，旋律/伴奏不使用


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


def _meta(meta_type: int, data: bytes) -> bytes:
    return bytes([0xFF, meta_type, len(data)]) + data


def _tempo_meta(bpm: int) -> bytes:
    micros_per_quarter = int(round(60_000_000 / max(1, bpm)))
    return _meta(0x51, micros_per_quarter.to_bytes(3, "big"))


def _time_signature_meta(numerator: int = 4, denominator: int = 4) -> bytes:
    # FF 58 04 nn dd cc bb：dd 为分母以 2 为底的指数；cc=24 每四分音符 24 个 MIDI 时钟
    denom_exp = {1: 0, 2: 1, 4: 2, 8: 3, 16: 4, 32: 5}.get(denominator, 2)
    return _meta(0x58, bytes([numerator, denom_exp, 24, 8]))


@dataclass
class MidiTrack:
    """一条命名乐器轨。"""

    name: str
    notes: list[DetectedNote] = field(default_factory=list)
    program: int = 0  # GM 音色号 0-127（0 = 原声大钢琴）
    channel: int = 0  # MIDI 通道 0-15（自动避开 9 号鼓通道）

    def __post_init__(self) -> None:
        self.program = max(0, min(127, int(self.program)))
        self.channel = max(0, min(15, int(self.channel)))
        if self.channel == _DRUMS_CHANNEL:
            self.channel = 10


def _conductor_track(bpm: int, numerator: int, denominator: int) -> bytes:
    """轨道 0：只放全局元事件（速度/拍号），不放音符。"""
    body = bytearray()
    body += _vlq(0) + _tempo_meta(bpm)
    body += _vlq(0) + _time_signature_meta(numerator, denominator)
    body += _vlq(0) + bytes([0xFF, 0x2F, 0x00])
    return _chunk(b"MTrk", bytes(body))


def _instrument_track(spec: MidiTrack, sec_per_tick: float) -> bytes:
    ch = spec.channel
    status_on = 0x90 | ch
    status_off = 0x80 | ch
    status_pc = 0xC0 | ch

    # (绝对 tick, 排序键, 原始字节)；同一 tick 先收后发
    events: list[tuple[int, int, bytes]] = [
        # delta=0：轨道名 → program change，保证 DAW 一打开就显示乐器
        (0, -2, _meta(0x03, spec.name.encode("utf-8"))),
        (0, -1, bytes([status_pc, spec.program])),
    ]
    for n in spec.notes:
        start = int(round(n.onset / sec_per_tick))
        end = max(start + 1, int(round((n.onset + n.duration) / sec_per_tick)))
        velocity = max(1, min(127, round(n.velocity * 127)))
        pitch = max(0, min(127, n.midi))
        events.append((end, 0, bytes([status_off, pitch, 0])))
        events.append((start, 1, bytes([status_on, pitch, velocity])))

    events.sort(key=lambda x: (x[0], x[1]))

    body = bytearray()
    prev_tick = 0
    for tick, _key, raw in events:
        body += _vlq(tick - prev_tick) + raw
        prev_tick = tick
    body += _vlq(0) + bytes([0xFF, 0x2F, 0x00])
    return _chunk(b"MTrk", bytes(body))


def write_smf_multitrack(
    tracks: list[MidiTrack],
    bpm: int = 100,
    numerator: int = 4,
    denominator: int = 4,
) -> bytes:
    """多轨音符 → format-1 .mid 二进制（指挥轨 + 每条乐器轨）。"""
    sec_per_tick = 60.0 / (max(1, bpm) * _TPQ)

    # 通道去重：同一通道的后一轨顺延到空闲通道（避开鼓通道）
    used: set[int] = set()
    for spec in tracks:
        while spec.channel in used or spec.channel == _DRUMS_CHANNEL:
            spec.channel = (spec.channel + 1) % 16
        used.add(spec.channel)

    chunks = _conductor_track(bpm, numerator, denominator)
    for spec in tracks:
        chunks += _instrument_track(spec, sec_per_tick)

    header = _chunk(b"MThd", _u16(1) + _u16(1 + len(tracks)) + _u16(_TPQ))
    return header + chunks


def write_smf(
    notes: list[DetectedNote],
    bpm: int = 100,
    name: str = "人声主旋律",
    program: int = 0,
) -> bytes:
    """单旋律轨便捷入口（M3 主链路使用，行为兼容旧调用）。"""
    return write_smf_multitrack(
        [MidiTrack(name=name, notes=notes, program=program, channel=0)],
        bpm=bpm,
    )
