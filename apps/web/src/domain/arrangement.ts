// 多轨编排：从量化谱面生成"旋律轨 + 自动伴奏轨（低音 / 和弦垫）"。
//
// 自动伴奏策略（M3 规则法 → M4 接入检测结果）：
//  1. 调性：优先采用后端 KeyEvent（置信度 ≥0.5，含大/小调）；
//     证据不足时回退本地按时长加权的大调推断；
//  2. 每小节选顺阶三和弦：候选 I~vii 与该小节旋律音级重合度最高者，
//     优先正三和弦，末小节回 I 做终止；
//  3. 低音轨：和弦根音（大字组 C2 区），整小节一个音；
//  4. 和弦垫轨：根/三/五三和弦（小字组 C3 区），整小节持续，力度较弱。
// 无旋律的空小节不生成和弦。后续 ChordEvent 接入后可直接替换第 2 步。

import type { QuantizedScore } from './quantize';
import { UNITS_PER_BEAT } from './quantize';

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
  /** 调性中文显示名，如 "C 大调" / "a 小调" */
  keyName: string;
}

export interface ArrangementOptions {
  accompaniment: boolean;
  melodyProgram: number;
  bassProgram: number;
  padProgram: number;
  /** M4：后端 KeyEvent 检测调性（tonality 形如 "C major" / "A minor"） */
  detectedKey?: { tonality: string; confidence: number } | null;
}

type Quality = 'M' | 'm' | 'd';

interface ScaleSpec {
  /** 顺阶根音相对主音的半音偏移 */
  offsets: number[];
  /** 各级三和弦性质：大/小/减 */
  qualities: Quality[];
  /** 正三和弦级（偏好加权） */
  strong: Set<number>;
}

const MAJOR_SCALE: ScaleSpec = {
  offsets: [0, 2, 4, 5, 7, 9, 11],
  qualities: ['M', 'm', 'm', 'M', 'M', 'm', 'd'],
  strong: new Set([0, 3, 4, 5]), // I / IV / V / vi
};

// 自然小调：i ii° III iv v VI VII
const MINOR_SCALE: ScaleSpec = {
  offsets: [0, 2, 3, 5, 7, 8, 10],
  qualities: ['m', 'd', 'M', 'm', 'm', 'M', 'M'],
  strong: new Set([0, 2, 3, 4, 5]), // i / III / iv / v / VI
};

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const mod12 = (n: number) => ((n % 12) + 12) % 12;

function chordPcs(tonic: number, degree: number, scale: ScaleSpec): number[] {
  const root = mod12(tonic + scale.offsets[degree]);
  const quality = scale.qualities[degree];
  const third = quality === 'm' || quality === 'd' ? 3 : 4;
  const fifth = quality === 'd' ? 6 : 7;
  return [root, mod12(root + third), mod12(root + fifth)];
}

/** 解析后端 tonality 字符串："C major" / "C# minor" → {主音音级, 是否小调}。 */
function parseDetectedKey(tonality: string | undefined): { tonic: number; minor: boolean } | null {
  if (!tonality) {
    return null;
  }
  const m = /^([A-G](?:#|b)?)\s+(major|minor)$/i.exec(tonality.trim());
  if (!m) {
    return null;
  }
  const idx = PC_NAMES.indexOf(m[1].toUpperCase());
  if (idx < 0) {
    return null;
  }
  return { tonic: idx, minor: m[2].toLowerCase() === 'minor' };
}

/** 加权音级向量 → 覆盖度最高的大调主音（后端调性不可用时的兜底）。 */
function inferMajorTonic(weightByPc: number[]): number {
  let bestTonic = 0;
  let bestScore = -1;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const scale = new Set(MAJOR_SCALE.offsets.map((s) => mod12(tonic + s)));
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
  scale: ScaleSpec,
  barWeightByPc: number[],
  isLastBar: boolean,
): number {
  if (isLastBar) {
    return 0; // 终止回 I
  }
  let bestDegree = 0;
  let bestScore = -1;
  for (let degree = 0; degree < 7; degree += 1) {
    const pcs = chordPcs(tonic, degree, scale);
    const overlap = pcs.reduce((acc, pc) => acc + barWeightByPc[pc], 0);
    if (overlap <= 0) {
      continue;
    }
    const tieBreak = scale.strong.has(degree) ? 0.25 : 0;
    const score = overlap + tieBreak;
    if (score > bestScore) {
      bestScore = score;
      bestDegree = degree;
    }
  }
  return bestDegree;
}

/** 调性中文显示：检测 → "C 大调"/"a 小调"；本地推断 → "C 大调（推断）"。 */
function formatKeyName(tonic: number, minor: boolean, detected: boolean): string {
  const letter = minor ? PC_NAMES[tonic].toLowerCase() : PC_NAMES[tonic];
  return `${letter} ${minor ? '小调' : '大调'}${detected ? '' : '（推断）'}`;
}

export function buildArrangement(score: QuantizedScore, opts: ArrangementOptions): Arrangement {
  const unitsPerBar = UNITS_PER_BEAT * (score.beatsPerBar ?? 4);

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

  // 调性来源：后端检测（置信度足够）→ 本地大调推断兜底
  const parsed = parseDetectedKey(opts.detectedKey?.tonality);
  const useDetected = parsed !== null && (opts.detectedKey?.confidence ?? 0) >= 0.5;
  const tonic = useDetected && parsed ? parsed.tonic : inferMajorTonic(globalWeightByPc);
  const minor = useDetected && parsed ? parsed.minor : false;
  const scale = minor ? MINOR_SCALE : MAJOR_SCALE;

  if (opts.accompaniment && melodyNotes.length > 0) {
    const bassNotes: ArrangementNote[] = [];
    const padNotes: ArrangementNote[] = [];

    score.measures.forEach((measure, mi) => {
      const weight = barWeights[mi];
      if (weight.reduce((a, b) => a + b, 0) <= 0) {
        return; // 空小节不伴奏
      }
      const degree = pickDegree(tonic, scale, weight, mi === score.measures.length - 1);
      const rootPc = mod12(tonic + scale.offsets[degree]);
      const quality = scale.qualities[degree];
      const thirdInterval = quality === 'm' || quality === 'd' ? 3 : 4;
      const fifthInterval = quality === 'd' ? 6 : 7;
      const start = measure.startUnit;

      // 低音：大字组 C2=36 起，整小节
      bassNotes.push({
        midi: 36 + rootPc,
        startUnit: start,
        durationUnits: unitsPerBar,
        velocity: 0.72,
      });
      // 和弦垫：小字组 C3=48 起，根/三/五整小节持续
      const padRoot = 48 + rootPc;
      padNotes.push(
        { midi: padRoot, startUnit: start, durationUnits: unitsPerBar, velocity: 0.42 },
        { midi: padRoot + thirdInterval, startUnit: start, durationUnits: unitsPerBar, velocity: 0.36 },
        { midi: padRoot + fifthInterval, startUnit: start, durationUnits: unitsPerBar, velocity: 0.36 },
      );
    });

    tracks.push({ id: 'bass', name: '低音', program: opts.bassProgram, notes: bassNotes });
    tracks.push({ id: 'pad', name: '和弦垫', program: opts.padProgram, notes: padNotes });
  }

  const hasTonality = globalWeightByPc.some((w) => w > 0);
  const keyName = hasTonality ? formatKeyName(tonic, minor, useDetected) : '—';

  return { tracks, keyName };
}
