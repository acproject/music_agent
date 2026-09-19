// 浏览器端 Standard MIDI File 写入器（format 1 多轨，与 Python app/midi.py 对齐）。
//
// 用途：把当前编排（旋律 + 可选伴奏、各轨 GM 乐器/力度）导出为 .mid，
// 不依赖后端返回；480 TPQ，指挥轨放速度/拍号，乐器轨带轨道名 + program change。

export const TPQ = 480;
/** 16 分音符网格 → tick：480/4 = 120 */
export const TICKS_PER_UNIT = TPQ / 4;

export interface MidiNoteSpec {
  midi: number;
  startTick: number;
  durationTick: number;
  /** 0-1，内部转 1-127 */
  velocity: number;
}

export interface MidiTrackSpec {
  name: string;
  /** GM 音色号 0-127 */
  program: number;
  /** 期望通道 0-15；9（鼓）自动顺延，重复通道自动去重 */
  channel: number;
  notes: MidiNoteSpec[];
}

const DRUMS_CHANNEL = 9;

function u16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function vlq(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    out.push(0x80 | (v & 0x7f));
    v >>= 7;
  }
  return out.reverse();
}

function chunk(kind: string, body: number[]): number[] {
  return [
    ...Array.from(kind).map((c) => c.charCodeAt(0)),
    ...Array.from(u32(body.length)),
    ...body,
  ];
}

function meta(metaType: number, data: number[]): number[] {
  return [0xff, metaType, data.length, ...data];
}

function tempoMeta(bpm: number): number[] {
  const micros = Math.round(60_000_000 / Math.max(1, bpm));
  return meta(0x51, [
    (micros >> 16) & 0xff,
    (micros >> 8) & 0xff,
    micros & 0xff,
  ]);
}

function timeSignatureMeta(numerator = 4, denominator = 4): number[] {
  const denomExp: Record<number, number> = { 1: 0, 2: 1, 4: 2, 8: 3, 16: 4, 32: 5 };
  return meta(0x58, [numerator, denomExp[denominator] ?? 2, 24, 8]);
}

function conductorTrack(bpm: number, numerator: number, denominator: number): number[] {
  const body = [
    ...vlq(0), ...tempoMeta(bpm),
    ...vlq(0), ...timeSignatureMeta(numerator, denominator),
    ...vlq(0), 0xff, 0x2f, 0x00,
  ];
  return chunk('MTrk', body);
}

function instrumentTrack(spec: MidiTrackSpec): number[] {
  const ch = spec.channel;
  const program = Math.max(0, Math.min(127, spec.program));
  // [绝对 tick, 排序键（越小越先）, 字节]；同 tick 先收后发
  type Ev = [number, number, number[]];
  const events: Ev[] = [
    [0, -2, meta(0x03, Array.from(new TextEncoder().encode(spec.name)))],
    [0, -1, [0xc0 | ch, program]],
  ];

  for (const n of spec.notes) {
    const start = Math.max(0, Math.round(n.startTick));
    const end = Math.max(start + 1, Math.round(n.startTick + n.durationTick));
    const pitch = Math.max(0, Math.min(127, n.midi));
    const velocity = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
    events.push([end, 0, [0x80 | ch, pitch, 0]]);
    events.push([start, 1, [0x90 | ch, pitch, velocity]]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const body: number[] = [];
  let prev = 0;
  for (const [tick, , raw] of events) {
    body.push(...vlq(tick - prev), ...raw);
    prev = tick;
  }
  body.push(...vlq(0), 0xff, 0x2f, 0x00);
  return chunk('MTrk', body);
}

/** 多轨 → format-1 SMF 字节。 */
export function writeSmf(
  tracks: MidiTrackSpec[],
  bpm: number,
  numerator = 4,
  denominator = 4,
): Uint8Array {
  // 通道去重（避开鼓通道）
  const used = new Set<number>();
  for (const t of tracks) {
    let ch = t.channel === DRUMS_CHANNEL ? 10 : Math.max(0, Math.min(15, t.channel));
    while (used.has(ch) || ch === DRUMS_CHANNEL) {
      ch = (ch + 1) % 16;
    }
    t.channel = ch;
    used.add(ch);
  }

  const body: number[] = [
    ...chunk('MThd', [
      ...u16(1),                 // format 1
      ...u16(1 + tracks.length), // 指挥轨 + 乐器轨
      ...u16(TPQ),
    ]),
    ...conductorTrack(bpm, numerator, denominator),
    ...tracks.flatMap(instrumentTrack),
  ];
  return Uint8Array.from(body);
}
