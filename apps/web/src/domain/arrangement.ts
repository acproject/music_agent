// 多轨编排：从量化谱面生成"旋律轨 + 自动伴奏轨（低音 / 和弦垫）"。
//
// 自动伴奏策略（M3 试做，全部基于量化网格，确定性、零延迟）：
//  1. 调性推断：按旋律各音级（pitch class）的网格时长加权，选出覆盖度最高的大调；
//  2. 每小节选顺阶三和弦：候选 I~vii 与该小节旋律音级重合度最高者，
//     优先 I/IV/V/vi 正三和弦，末小节回 I 做终止；
//  3. 低音轨：和弦根音（大字组 C2 区），整小节一个音；
//  4. 和弦垫轨：根/三/五三和弦（小字组 C3 区），整小节持续，力度较弱。
// 无旋律的空小节不生成和弦。M4 接入自动节拍/调性检测后直接替换推断输入即可。

import type { QuantizedScore } from './quantize';
import { UNITS_PER_BAR } from './quantize';

export interface ArrangementNote {
  midi: number;
  startUnit: number;
  durationUnits: number;
  velocity: number;
  /** 旋律音在谱面中的全局条目序号（播放高亮用；伴奏音无） */
  globalIndex?: number;
}

export type TrackId = 'melody' | 'bass' | 'pad';

export interface ArrangementTrack {
  id: TrackId;
  name: string;
  program: number;
  notes: ArrangementNote[];
}

export interface Arrangement {
  tracks: ArrangementTrack[];
  /** 推断调性的中文显示名，如 "C 大调" */
  keyName: string;
}

export interface ArrangementOptions {
  accompaniment: boolean;
  melodyProgram: number;
  bassProgram: number;
  padProgram: number;
}

// 顺阶三和弦性质：大/小/小/大/大/小/减
const DEGREE_QUALITY = ['M', 'm', 'm', 'M', 'M', 'm', 'd'] as const;
const DEGREE_OFFSET = [0, 2, 4, 5, 7, 9, 11];
// 正三和弦（I/IV/V/vi）的偏好加权
const STRONG_DEGREE = new Set([0, 3, 4, 5]);
const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const mod12 = (n: number) => ((n % 12) + 12) % 12;

function chordPcs(tonic: number, degree: number): number[] {
  const root = mod12(tonic + DEGREE_OFFSET[degree]);
  const quality = DEGREE_QUALITY[degree];
  const third = quality === 'm' || quality === 'd' ? 3 : 4;
  const fifth = quality === 'd' ? 6 : 7;
  return [root, mod12(root + third), mod12(root + fifth)];
}

/** 加权音级向量 → 大调主音。 */
function inferTonic(weightByPc: number[]): number {
  let bestTonic = 0;
  let bestScore = -1;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const scale = new Set([0, 2, 4, 5, 7, 9, 11].map((s) => mod12(tonic + s)));
    let score = 0;
    weightByPc.forEach((w, pc) => {
      if (scale.has(pc)) {
        score += w;
      }
    });
    if (score > bestScore) {
      bestScore = score;
      bestTonic = tonic;
    }
  }
  return bestTonic;
}

function pickDegree(
  tonic: number,
  barWeightByPc: number[],
  isLastBar: boolean,
): number {
  if (isLastBar) {
    return 0; // 终止回 I
  }
  let bestDegree = 0;
  let bestScore = -1;
  for (let degree = 0; degree < 7; degree += 1) {
    const pcs = chordPcs(tonic, degree);
    const overlap = pcs.reduce((acc, pc) => acc + barWeightByPc[pc], 0);
    if (overlap <= 0) {
      continue;
    }
    const tieBreak = STRONG_DEGREE.has(degree) ? 0.25 : 0;
    const score = overlap + tieBreak;
    if (score > bestScore) {
      bestScore = score;
      bestDegree = degree;
    }
  }
  return bestDegree;
}

export function buildArrangement(score: QuantizedScore, opts: ArrangementOptions): Arrangement {
  // 1) 展开旋律
  const melodyNotes: ArrangementNote[] = [];
  const globalWeightByPc = new Array<number>(12).fill(0);
  const barWeights: number[][] = score.measures.map(() => new Array<number>(12).fill(0));

  let globalIndex = 0;
  score.measures.forEach((measure, mi) => {
    let localUnits = 0;
    for (const item of measure.items) {
      if (item.kind === 'note' && item.midi !== undefined) {
        const note: ArrangementNote = {
          midi: item.midi,
          startUnit: measure.startUnit + localUnits,
          durationUnits: item.units,
          velocity: 0.78,
          globalIndex,
        };
        melodyNotes.push(note);
        const w = item.units;
        globalWeightByPc[mod12(item.midi)] += w;
        barWeights[mi][mod12(item.midi)] += w;
      }
      localUnits += item.units;
      globalIndex += 1;
    }
  });

  const tracks: ArrangementTrack[] = [
    { id: 'melody', name: '主旋律', program: opts.melodyProgram, notes: melodyNotes },
  ];

  if (opts.accompaniment && melodyNotes.length > 0) {
    const tonic = inferTonic(globalWeightByPc);
    const bassNotes: ArrangementNote[] = [];
    const padNotes: ArrangementNote[] = [];

    score.measures.forEach((measure, mi) => {
      const weight = barWeights[mi];
      if (weight.reduce((a, b) => a + b, 0) <= 0) {
        return; // 空小节不伴奏
      }
      const degree = pickDegree(tonic, weight, mi === score.measures.length - 1);
      const rootPc = mod12(tonic + DEGREE_OFFSET[degree]);
      const quality = DEGREE_QUALITY[degree];
      const thirdInterval = quality === 'm' || quality === 'd' ? 3 : 4;
      const fifthInterval = quality === 'd' ? 6 : 7;
      const start = measure.startUnit;

      // 低音：大字组 C2=36 起，整小节
      bassNotes.push({
        midi: 36 + rootPc,
        startUnit: start,
        durationUnits: UNITS_PER_BAR,
        velocity: 0.72,
      });
      // 和弦垫：小字组 C3=48 起，根/三/五整小节持续
      const padRoot = 48 + rootPc;
      padNotes.push(
        { midi: padRoot, startUnit: start, durationUnits: UNITS_PER_BAR, velocity: 0.42 },
        { midi: padRoot + thirdInterval, startUnit: start, durationUnits: UNITS_PER_BAR, velocity: 0.36 },
        { midi: padRoot + fifthInterval, startUnit: start, durationUnits: UNITS_PER_BAR, velocity: 0.36 },
      );
    });

    tracks.push({ id: 'bass', name: '低音', program: opts.bassProgram, notes: bassNotes });
    tracks.push({ id: 'pad', name: '和弦垫', program: opts.padProgram, notes: padNotes });
  }

  const hasTonality = globalWeightByPc.some((w) => w > 0);
  const keyName = hasTonality ? `${PC_NAMES[inferTonic(globalWeightByPc)]} 大调` : '—';

  return { tracks, keyName };
}
