// 秒级 NoteSequence → 小节/拍网格量化（M3：固定 BPM + 4/4 拍号 + 16 分音符分辨率）。
//
// 关键约束（VexFlow 排版踩坑总结）：
//  - 每个音符必须有显式的网格起点与标准时值，绝不允许用 index*duration 反推拍点；
//  - 所有空隙补休止符，每个小节时值必须填满（Voice 总和 = 整小节 tick）；
//  - 跨小节音符在小节线处拆成两个独立音（M3 不做延音线）；
//  - 五线谱与简谱共用本模块的唯一输出，两种渲染不得各自再量化。
//
// M4 节拍/速度自动检测落地后，bpm/timeSignature 改由 NoteSequence 提供，本模块签名不变。

import type { NoteDto } from '../api/analyze';

export const UNITS_PER_BEAT = 4; // 16 分音符为最小网格
export const BEATS_PER_BAR = 4; // 4/4
export const UNITS_PER_BAR = UNITS_PER_BEAT * BEATS_PER_BAR;

export type VexBaseDuration = 'w' | 'h' | 'q' | '8' | '16';

export interface ScoreItem {
  kind: 'note' | 'rest';
  /** VexFlow 基础时值码（不含附点） */
  base: VexBaseDuration;
  dotted: boolean;
  /** 占 16 分音符网格数 */
  units: number;
  /** kind=note 时存在 */
  midi?: number;
  centsOffset?: number;
  confidence?: number;
}

export interface ScoreMeasure {
  /** 该小节从 0 开始的 16 分网格偏移 */
  startUnit: number;
  items: ScoreItem[];
}

export interface QuantizedScore {
  bpm: number;
  timeSignature: string;
  measures: ScoreMeasure[];
  totalUnits: number;
}

// 贪心分解表：网格长度 → (基础时值, 附点)。可覆盖 1..16 的任意整数分解。
const DURATION_TABLE: ReadonlyArray<[number, VexBaseDuration, boolean]> = [
  [16, 'w', false],
  [12, 'h', true],
  [8, 'h', false],
  [6, 'q', true],
  [4, 'q', false],
  [3, '8', true],
  [2, '8', false],
  [1, '16', false],
];

/** 把一段连续网格长度（≤16）分解为标准时值 + 附点组合。 */
export function decomposeUnits(units: number): Array<{ base: VexBaseDuration; dotted: boolean; units: number }> {
  const out: Array<{ base: VexBaseDuration; dotted: boolean; units: number }> = [];
  let remaining = units;
  while (remaining > 0) {
    const hit = DURATION_TABLE.find(([u]) => u <= remaining);
    if (!hit) {
      break;
    }
    const [u, base, dotted] = hit;
    out.push({ base, dotted, units: u });
    remaining -= u;
  }
  return out;
}

interface PlacedNote {
  startUnit: number;
  lengthUnits: number;
  note: NoteDto;
}

/**
 * 量化入口。
 * @param notes 后端 NoteSequence.notes（秒）
 * @param bpm 目标速度（M3 由前端选择；M4 起取自动检测值）
 */
export function quantize(notes: NoteDto[], bpm: number): QuantizedScore {
  const secPerUnit = 60 / bpm / UNITS_PER_BEAT;

  // 1) 秒 → 网格，并解决重叠（后音不得侵入前音；零长碎片丢弃）
  const placed: PlacedNote[] = [];
  const sorted = [...notes].sort((a, b) => a.onset - b.onset);
  for (const note of sorted) {
    const startUnit = Math.max(0, Math.round(note.onset / secPerUnit));
    const lengthUnits = Math.max(1, Math.round(note.duration / secPerUnit));
    const cursor = placed.length > 0
      ? placed[placed.length - 1].startUnit + placed[placed.length - 1].lengthUnits
      : 0;
    const clampedStart = Math.max(startUnit, cursor);
    if (lengthUnits <= 0 || clampedStart >= startUnit + lengthUnits) {
      continue;
    }
    placed.push({
      startUnit: clampedStart,
      lengthUnits: startUnit + lengthUnits - clampedStart,
      note,
    });
  }

  // 2) 在网格上铺设音符与休止（单位单元 → 再聚合成标准时值）
  interface Cell {
    startUnit: number;
    units: number;
    note: NoteDto | null;
  }
  const cells: Cell[] = [];
  let cursor = 0;
  const pushRun = (from: number, to: number, note: NoteDto | null) => {
    if (to - from <= 0) {
      return;
    }
    // 跨小节线切开（同一段连续属性，按 16 网格小节边界分块）
    let p = from;
    while (p < to) {
      const barEnd = (Math.floor(p / UNITS_PER_BAR) + 1) * UNITS_PER_BAR;
      cells.push({ startUnit: p, units: Math.min(to, barEnd) - p, note });
      p = Math.min(to, barEnd);
    }
  };

  for (const p of placed) {
    if (p.startUnit > cursor) {
      pushRun(cursor, p.startUnit, null);
    }
    pushRun(p.startUnit, p.startUnit + p.lengthUnits, p.note);
    cursor = p.startUnit + p.lengthUnits;
  }
  // 末尾补休止到完整小节（VexFlow voice 必须填满整小节）
  const endBarEnd = (Math.floor((cursor - 1) / UNITS_PER_BAR) + 1) * UNITS_PER_BAR;
  if (endBarEnd > cursor) {
    pushRun(cursor, endBarEnd, null);
  }

  // 3) 按小节分组，单元长度 → 标准时值分解
  const measures: ScoreMeasure[] = [];
  for (const cell of cells) {
    const barIndex = Math.floor(cell.startUnit / UNITS_PER_BAR);
    if (measures[barIndex] === undefined) {
      measures[barIndex] = { startUnit: barIndex * UNITS_PER_BAR, items: [] };
    }
    for (const d of decomposeUnits(cell.units)) {
      if (cell.note) {
        measures[barIndex].items.push({
          kind: 'note',
          base: d.base,
          dotted: d.dotted,
          units: d.units,
          midi: cell.note.midi,
          centsOffset: cell.note.cents_offset,
          confidence: cell.note.confidence,
        });
      } else {
        measures[barIndex].items.push({
          kind: 'rest',
          base: d.base,
          dotted: d.dotted,
          units: d.units,
        });
      }
    }
  }

  return {
    bpm,
    timeSignature: '4/4',
    measures: measures.filter((m): m is ScoreMeasure => m !== undefined),
    totalUnits: endBarEnd,
  };
}

const VEX_PITCH_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** MIDI 音号 → VexFlow key（如 60 → "c/4"，61 → "c#/4"）。 */
export function vexKey(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${VEX_PITCH_NAMES[pc]}/${octave}`;
}
