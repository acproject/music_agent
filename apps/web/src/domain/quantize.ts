// 秒级 NoteSequence → 小节/拍网格量化（16 分音符分辨率）。
//
// 关键约束（VexFlow 排版踩坑总结）：
//  - 每个音符必须有显式的网格起点与标准时值，绝不允许用 index*duration 反推拍点；
//  - 所有空隙补休止符，每个小节时值必须填满（Voice 总和 = 整小节 tick）；
//  - 跨小节音符在小节线处拆成两个独立音（M3 不做延音线）；
//  - 五线谱与简谱共用本模块的唯一输出，两种渲染不得各自再量化。
//
// M4 起拍号由 NoteSequence 提供；多段变速时秒→网格通过 tempoMap 分段映射。

import type { NoteDto } from '../api/analyze';
import { normalizeTempoMap, secToUnits, type TempoAnchor } from './tempoMap';

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
  /** 首段速度（展示/兼容用；多段变速以 tempoMap 为准） */
  bpm: number;
  timeSignature: string;
  /** 每小节拍数（M4 起由后端检测拍号决定，默认 4） */
  beatsPerBar: number;
  /** 多段速度锚点（首锚点 timeSec=0） */
  tempoMap: TempoAnchor[];
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
 * @param opts.tempoMap 多段速度锚点（秒→16 分网格分段映射）
 * @param opts.beatsPerBar 每小节拍数（检测拍号，默认 4）
 */
export function quantize(
  notes: NoteDto[],
  opts: { tempoMap: TempoAnchor[]; beatsPerBar?: number },
): QuantizedScore {
  const tempoMap = normalizeTempoMap(opts.tempoMap);
  const firstBpm = tempoMap[0].bpm;
  const beatsPerBar = opts.beatsPerBar && opts.beatsPerBar >= 2 ? opts.beatsPerBar : 4;
  const unitsPerBar = UNITS_PER_BEAT * beatsPerBar;

  // 1) 秒 → 网格（变速下时长按音乐时间=两端网格差计算），并解决重叠
  const placed: PlacedNote[] = [];
  const sorted = [...notes].sort((a, b) => a.onset - b.onset);
  for (const note of sorted) {
    const startUnit = Math.max(0, Math.round(secToUnits(note.onset, tempoMap)));
    const lengthUnits = Math.max(
      1,
      Math.round(secToUnits(note.onset + note.duration, tempoMap)
        - secToUnits(note.onset, tempoMap)),
    );
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
    // 跨小节线切开（同一段连续属性，按小节边界分块）
    let p = from;
    while (p < to) {
      const barEnd = (Math.floor(p / unitsPerBar) + 1) * unitsPerBar;
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
  const endBarEnd = (Math.floor((cursor - 1) / unitsPerBar) + 1) * unitsPerBar;
  if (endBarEnd > cursor) {
    pushRun(cursor, endBarEnd, null);
  }

  // 3) 按小节分组，单元长度 → 标准时值分解
  const measures: ScoreMeasure[] = [];
  for (const cell of cells) {
    const barIndex = Math.floor(cell.startUnit / unitsPerBar);
    if (measures[barIndex] === undefined) {
      measures[barIndex] = { startUnit: barIndex * unitsPerBar, items: [] };
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
    bpm: firstBpm,
    timeSignature: `${beatsPerBar}/4`,
    beatsPerBar,
    tempoMap,
    measures: measures.filter((m): m is ScoreMeasure => m !== undefined),
    totalUnits: endBarEnd,
  };
}

/** 解析后端拍号字符串（如 "3/4" → 3）；非法 / 缺失时回退 4。 */
export function parseBeatsPerBar(timeSignature: string | undefined | null): number {
  const num = Number(timeSignature?.split('/')[0]);
  return Number.isFinite(num) && num >= 2 && num <= 7 ? num : 4;
}

const VEX_PITCH_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** MIDI 音号 → VexFlow key（如 60 → "c/4"，61 → "c#/4"）。 */
export function vexKey(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${VEX_PITCH_NAMES[pc]}/${octave}`;
}
