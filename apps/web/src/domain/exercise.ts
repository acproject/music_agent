// 结构化练习生成（纯规则，不依赖 LLM）：视唱练习 / 节奏节奏练习，各 3 个难度。
//
// 设计要点：
//  - 练习直接在 16 分网格上生成 QuantizedScore，并同步直接构建 TargetNote[]；
//    不走 comparePerformance.targetNotesFromScore——它会合并相邻同音高条目，
//    节奏练习（统一音高记谱）的连续拍手点会被错误合并成一次起音。
//  - 时值白名单 units ∈ {1,2,3,4,6,8,12,16}：每个攻击恰好对应一个 ScoreItem
//    （DURATION_TABLE 单行可表达），保证渲染端"小节内第 n 个音符"= target.noteIndex。
//  - RNG 可由种子构造（mulberry32）：测试确定性复现，UI「换一条」随机刷新。
//
// 本期边界：4/4 拍、4 小节、C 大调；拍号 / 多调式 / LLM 生成均为后续工作。

import type { TargetNote } from './comparePerformance';
import type {
  QuantizedScore,
  ScoreItem,
  ScoreMeasure,
  VexBaseDuration,
} from './quantize';
import { constantTempoMap, unitsToSec } from './tempoMap';

export type ExerciseKind = 'sight_singing' | 'rhythm';
export type ExerciseLevel = 1 | 2 | 3;

export interface Exercise {
  kind: ExerciseKind;
  level: ExerciseLevel;
  bpm: number;
  seed: number;
  title: string;
  score: QuantizedScore;
  targets: TargetNote[];
  /** 由终止式规则强制放置的目标音 globalIndex（正常跳进解决规则在此让位于终止式）。 */
  forcedNotes: number[];
}

export const MEASURES_PER_EXERCISE = 4;
export const UNITS_PER_BAR = 16; // 4/4 × 16 分网格

export const LEVEL_LABELS: Record<ExerciseLevel, string> = {
  1: '初级',
  2: '中级',
  3: '高级',
};

/** 各难度可选 BPM。 */
export const BPM_BY_LEVEL: Record<ExerciseLevel, readonly number[]> = {
  1: [60, 80, 100],
  2: [60, 80, 100, 120],
  3: [60, 80, 100, 120],
};

// ---------------------------------------------------------------------------
// 种子随机数
// ---------------------------------------------------------------------------

export interface Rng {
  next(): number;
}

/** mulberry32：无依赖的小型种子 PRNG，同种子同序列。 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rng.next() * xs.length)] as T;
}

// ---------------------------------------------------------------------------
// 时值
// ---------------------------------------------------------------------------

const DURATION_BY_UNITS: Readonly<Record<number, { base: VexBaseDuration; dotted: boolean }>> = {
  16: { base: 'w', dotted: false },
  12: { base: 'h', dotted: true },
  8: { base: 'h', dotted: false },
  6: { base: 'q', dotted: true },
  4: { base: 'q', dotted: false },
  3: { base: '8', dotted: true },
  2: { base: '8', dotted: false },
  1: { base: '16', dotted: false },
};

/** 合法生成时值（单条目可表达）。 */
export const ALLOWED_UNITS = [16, 12, 8, 6, 4, 3, 2, 1] as const;

function makeItem(units: number, rest: boolean, midi: number | null): ScoreItem {
  const d = DURATION_BY_UNITS[units];
  if (rest || midi === null) {
    return { kind: 'rest', base: d.base, dotted: d.dotted, units };
  }
  return { kind: 'note', base: d.base, dotted: d.dotted, units, midi };
}

// ---------------------------------------------------------------------------
// 节奏细胞
// ---------------------------------------------------------------------------

interface Cell {
  units: number;
  rest: boolean;
}

/** 每难度可选音符细胞长度。 */
const CELL_CHOICES: Record<ExerciseLevel, readonly number[]> = {
  1: [16, 8, 4, 2], // 全/二/四/八分
  2: [12, 8, 6, 4, 3, 2], // 加入附点
  3: [12, 8, 6, 4, 3, 2, 1], // 再加入十六分
};

/**
 * 用细胞长度填满一小节（合计 16 单元）。
 * 过滤掉会留下不可填尾巴的选择，避免生成器走到死路。
 */
function fillCellLengths(level: ExerciseLevel, rng: Rng): number[] {
  const choices = CELL_CHOICES[level];
  const out: number[] = [];
  let remaining = UNITS_PER_BAR;
  while (remaining > 0) {
    const feasible = choices.filter((u) => u <= remaining);
    const completable = feasible.filter(
      (u) => remaining - u === 0 || choices.some((c) => c <= remaining - u),
    );
    const u = pick(rng, completable.length > 0 ? completable : feasible);
    out.push(u);
    remaining -= u;
  }
  return out;
}

/**
 * 按难度规则把部分细胞标为休止：
 *  - L1 节奏型：只在强拍（网格 %4=0）、长度 ≥4；视唱 L1 不用休止；
 *  - L2：半拍位起（%2=0）、长度 ≥2；
 *  - L3：短休止（≤4）可在任意位置，制造切分；
 *  - 全曲第一个细胞不做休止；不允许连续两个休止细胞。
 */
function markRests(
  lengths: readonly number[],
  level: ExerciseLevel,
  kind: ExerciseKind,
  firstBar: boolean,
  rng: Rng,
): boolean[] {
  const flags = new Array<boolean>(lengths.length).fill(false);
  let cursor = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const units = lengths[i] as number;
    const eligible = (() => {
      if (firstBar && i === 0) {
        return false;
      }
      if (level === 1) {
        return kind === 'rhythm' && cursor % 4 === 0 && units >= 4 && rng.next() < 0.12;
      }
      if (level === 2) {
        return cursor % 2 === 0 && units >= 2 && rng.next() < (kind === 'rhythm' ? 0.18 : 0.12);
      }
      return units <= 4 && rng.next() < (kind === 'rhythm' ? 0.22 : 0.15);
    })();
    if (eligible && (i === 0 || !flags[i - 1])) {
      flags[i] = true;
    }
    cursor += units;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// 视唱旋律（C 大调）
// ---------------------------------------------------------------------------

/** C 大调音阶 MIDI（跨八度展开）。 */
const C_MAJOR: number[] = [];
for (let octave = 0; octave < 8; octave += 1) {
  for (const pc of [0, 2, 4, 5, 7, 9, 11]) {
    C_MAJOR.push(12 * (octave + 1) + pc);
  }
}

interface MelodyRule {
  /** 音域 MIDI 下界/上界 */
  range: [number, number];
  /** 最大级进跨度（音阶度数） */
  maxStep: number;
  /** 超过该度数算"跳进"，下一音必须反向级进解决；null=不检查 */
  leapResolve: number | null;
}

const MELODY_RULES: Record<ExerciseLevel, MelodyRule> = {
  1: { range: [60, 69], maxStep: 2, leapResolve: null }, // C4–A4，只做级进
  2: { range: [55, 76], maxStep: 5, leapResolve: 3 }, // G3–E5，跳进后反向级进
  3: { range: [52, 79], maxStep: 7, leapResolve: 5 }, // E3–G5，大跳后回落
};

/** 跨小节延续的旋律状态：上一音度数 + 是否有待解决的跳进。 */
interface MelodyState {
  prevDeg: number | null;
  pendingResolve: number;
}

/**
 * 为一小节的非休止细胞配唱名。firstBar 时首音取主和弦音；跳进解决状态跨小节延续；
 * forceTonic（最后小节）把最后一个发声音约束到主音 do，全部在难度约束内完成。
 * 返回与 cells 对齐的 MIDI 数组（休止位为 null）、更新后的旋律状态、强制细胞下标。
 */
function assignMelody(
  cells: readonly Cell[],
  level: ExerciseLevel,
  firstBar: boolean,
  rng: Rng,
  state: MelodyState,
  forceTonic: boolean,
  beforeFinal: boolean,
): { out: Array<number | null>; state: MelodyState; forcedCells: number[] } {
  const rule = MELODY_RULES[level];
  const degrees = C_MAJOR.map((midi, idx) => ({ midi, idx })).filter(
    (d) => d.midi >= rule.range[0] && d.midi <= rule.range[1],
  );

  /** 最后/倒数第二个发声音的细胞下标。 */
  const soundingCells: number[] = [];
  cells.forEach((c, i) => {
    if (!c.rest) {
      soundingCells.push(i);
    }
  });
  const lastSounding = soundingCells[soundingCells.length - 1] ?? -1;
  const penultSounding = soundingCells[soundingCells.length - 2] ?? -1;

  const out: Array<number | null> = cells.map(() => null);
  /** 被终止式规则强制的细胞下标。 */
  const forcedCells: number[] = [];
  /** 终止主音（在 penult 选定后确定）。 */
  let finalTonic: number | null = null;
  let prevDeg = state.prevDeg;
  let pendingResolve = state.pendingResolve;

  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i]?.rest) {
      continue;
    }

    let chosenIdx: number | undefined;
    if (forceTonic && i === penultSounding) {
      // 动态构造终止链"前置音 a → 主音 t"：a 从当前音级进可达，且与 t 级进相邻。
      const tonics = degrees.filter((d) => d.idx % 7 === 0);
      const chains: Array<{ approach: number; tonic: number }> = [];
      for (const t of tonics) {
        for (const a of [t.idx + 1, t.idx - 1]) {
          if (degrees.some((d) => d.idx === a) && prevDeg !== null
            && Math.abs(a - prevDeg) <= rule.maxStep) {
            chains.push({ approach: a, tonic: t.idx });
          }
        }
      }
      let feasibleChains = chains;
      if (pendingResolve !== 0 && prevDeg !== null) {
        // 与跳进解决兼容时优先满足解决
        const forcedApproach = prevDeg - pendingResolve;
        const hit = chains.filter((c) => c.approach === forcedApproach);
        if (hit.length > 0) {
          feasibleChains = hit;
        }
      }
      const chain = feasibleChains.length > 0 ? pick(rng, feasibleChains) : null;
      if (chain) {
        chosenIdx = chain.approach;
        finalTonic = chain.tonic;
        pendingResolve = 0; // 终止式优先
        forcedCells.push(i);
      } else {
        chosenIdx = prevDeg ?? degrees[0]!.idx; // 兜底，不应发生
      }
    } else if (forceTonic && i === lastSounding) {
      if (finalTonic !== null) {
        chosenIdx = finalTonic;
        forcedCells.push(i);
      } else {
        // 兜底：取最近主音
        const tonics = degrees.filter((d) => d.idx % 7 === 0);
        tonics.sort((a, b) => Math.abs(a.idx - (prevDeg ?? a.idx)) - Math.abs(b.idx - (prevDeg ?? b.idx)));
        chosenIdx = tonics[0]?.idx ?? (prevDeg ?? 0);
      }
      pendingResolve = 0;
    } else if (beforeFinal && i === lastSounding) {
      // 倒数第二小节末音提前向终止式靠拢：取"与某主音级进相邻"且从前音可达的音。
      const tonics = degrees.filter((d) => d.idx % 7 === 0);
      const approachTones = new Set<number>();
      for (const t of tonics) {
        for (const a of [t.idx + 1, t.idx - 1]) {
          if (degrees.some((d) => d.idx === a)) {
            approachTones.add(a);
          }
        }
      }
      let feasibleP = [...approachTones].filter(
        (a) => prevDeg === null || Math.abs(a - prevDeg) <= rule.maxStep,
      );
      // 有待解决跳进时，优先让本音同时完成跳进解决
      if (pendingResolve !== 0 && prevDeg !== null) {
        const resolved = prevDeg - pendingResolve;
        if (feasibleP.includes(resolved)) {
          feasibleP = [resolved];
        } else if (degrees.some((d) => d.idx === resolved)) {
          // 冲突无法两全：跳进解决优先，放弃终止式靠拢
          feasibleP = [];
          chosenIdx = resolved;
          pendingResolve = 0;
        }
      }
      if (feasibleP.length > 0) {
        chosenIdx = pick(rng, feasibleP);
        pendingResolve = 0;
        forcedCells.push(i);
      } else if (chosenIdx === undefined) {
        chosenIdx = prevDeg ?? degrees[0]!.idx;
      }
    } else if (prevDeg === null) {
      // 首音（首小节）取主和弦音；其余小节自由起
      const starters = firstBar
        ? degrees.filter((d) => [0, 2, 4, 7].some((pc) => d.idx % 7 === pc))
        : degrees;
      chosenIdx = pick(rng, starters.length > 0 ? starters : degrees).idx;
      pendingResolve = 0;
    } else if (pendingResolve !== 0) {
      // 跳进后反向级进
      const target = degrees.find((d) => d.idx === prevDeg! - pendingResolve);
      chosenIdx = target ? target.idx : prevDeg;
      pendingResolve = 0;
    } else {
      const deltas: number[] = [];
      for (let d = -rule.maxStep; d <= rule.maxStep; d += 1) {
        if (d !== 0) {
          deltas.push(d);
        }
      }
      let feasible = deltas.filter((d) =>
        degrees.some((deg) => deg.idx === prevDeg! + d),
      );
      // 所有自由选择的音符都保持在终止链可达区域（距某主音的级进前置音 ≤maxStep）：
      // L2/L3 该区域几乎覆盖全音域；L1 收窄到 C4–F4，保证终止链永不落空。
      {
        const tonics = degrees.filter((d) => d.idx % 7 === 0);
        const reachable = new Set<number>();
        for (const t of tonics) {
          for (const a of [t.idx + 1, t.idx - 1]) {
            if (!degrees.some((d) => d.idx === a)) {
              continue;
            }
            degrees.forEach((d) => {
              if (Math.abs(d.idx - a) <= rule.maxStep) {
                reachable.add(d.idx);
              }
            });
          }
        }
        const bounded = feasible.filter((d) => reachable.has(prevDeg! + d));
        if (bounded.length > 0) {
          feasible = bounded;
        }
      }
      const delta = feasible.length > 0 ? pick(rng, feasible) : 0;
      chosenIdx = prevDeg + delta;
    }

    const chosen = degrees.find((d) => d.idx === chosenIdx) ?? degrees[0]!;
    out[i] = chosen.midi;
    if (prevDeg !== null && rule.leapResolve !== null) {
      const interval = Math.abs(chosen.idx - prevDeg);
      if (interval >= rule.leapResolve) {
        pendingResolve = chosen.idx > prevDeg ? 1 : -1;
      }
    }
    prevDeg = chosen.idx;
  }

  return { out, state: { prevDeg, pendingResolve }, forcedCells };
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function buildBar(
  level: ExerciseLevel,
  kind: ExerciseKind,
  firstBar: boolean,
  rng: Rng,
  melodyState: MelodyState,
  forceTonic: boolean,
  beforeFinal: boolean,
): { measure: ScoreMeasure; melodyState: MelodyState; forcedCells: number[] } {
  const lengths = fillCellLengths(level, rng);
  const rests = markRests(lengths, level, kind, firstBar, rng);
  // 保证至少两个发声音：末小节终止式需要前置音 + 主音；同时避免整小节全休止
  let sounding = rests.filter((r) => !r).length;
  for (let k = rests.length - 1; k >= 0 && sounding < 2; k -= 1) {
    if (rests[k]) {
      rests[k] = false;
      sounding += 1;
    }
  }
  let cells: Cell[] = lengths.map((units, i) => ({ units, rest: rests[i] ?? false }));
  // 保证每小节 ≥2 个攻击：单音符小节（如一个全音符）拆成两个等长攻击
  while (cells.length < 2) {
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      const u = cells[i]!.units;
      const half = Math.floor(u / 2);
      const parts: number[] = u >= 2 ? [half, u - half] : [];
      if (parts.length === 2 && parts.every((p) => (ALLOWED_UNITS as readonly number[]).includes(p))) {
        const wasRest = cells[i]!.rest;
        cells.splice(i, 1, { units: parts[0], rest: wasRest }, { units: parts[1], rest: wasRest });
        break;
      }
    }
    break; // 防御性：理论上单 cell 必为 ≥3 单元（bar=16），拆分一定成功
  }
  const melody = kind === 'sight_singing'
    ? assignMelody(cells, level, firstBar, rng, melodyState, forceTonic, beforeFinal)
    : { out: [] as Array<number | null>, state: melodyState, forcedCells: [] as number[] };

  const items: ScoreItem[] = cells.map((cell, i) =>
    makeItem(
      cell.units,
      cell.rest,
      kind === 'rhythm' ? 60 : (melody.out[i] ?? null),
    ),
  );

  return { measure: { startUnit: 0, items }, melodyState: melody.state, forcedCells: melody.forcedCells };
}

/** 由网格谱直接展开 TargetNote[]（休止不占 noteIndex）。 */
function buildTargets(score: QuantizedScore): TargetNote[] {
  const targets: TargetNote[] = [];
  score.measures.forEach((measure, barIdx) => {
    let noteIndex = 0;
    let offsetUnits = 0;
    for (const item of measure.items) {
      if (item.kind === 'note') {
        noteIndex += 1;
        const startUnit = measure.startUnit + offsetUnits;
        const startSec = unitsToSec(startUnit, score.tempoMap);
        const endSec = unitsToSec(startUnit + item.units, score.tempoMap);
        targets.push({
          midi: item.midi ?? null,
          startSec,
          durationSec: endSec - startSec,
          measure: barIdx + 1,
          noteIndex,
          globalIndex: targets.length,
        });
      }
      offsetUnits += item.units;
    }
  });
  return targets;
}

export interface GenerateOptions {
  bpm?: number;
  seed?: number;
}

/**
 * 生成一条结构化练习。
 * @param kind sight_singing=视唱（旋律，评音准+节奏）；rhythm=节奏（拍手/敲击，只评时间）
 * @param level 1/2/3 难度
 */
export function generateExercise(
  kind: ExerciseKind,
  level: ExerciseLevel,
  opts: GenerateOptions = {},
): Exercise {
  const bpmChoices = BPM_BY_LEVEL[level];
  const bpm = opts.bpm && bpmChoices.includes(opts.bpm)
    ? opts.bpm
    : (kind === 'rhythm' ? 100 : 80);
  const seed = opts.seed ?? randInt(createRng((Date.now() >>> 0) + kind.length), 1, 0x7fffffff);
  const rng = createRng(seed);

  const measures: ScoreMeasure[] = [];
  const forcedPerBar: number[][] = [];
  let melodyState: MelodyState = { prevDeg: null, pendingResolve: 0 };
  for (let bar = 0; bar < MEASURES_PER_EXERCISE; bar += 1) {
    const result = buildBar(
      level,
      kind,
      bar === 0,
      rng,
      melodyState,
      bar === MEASURES_PER_EXERCISE - 1,
      bar === MEASURES_PER_EXERCISE - 2,
    );
    melodyState = result.melodyState;
    result.measure.startUnit = bar * UNITS_PER_BAR;
    measures.push(result.measure);
    forcedPerBar.push(result.forcedCells);
  }

  const score: QuantizedScore = {
    bpm,
    timeSignature: '4/4',
    beatsPerBar: 4,
    tempoMap: constantTempoMap(bpm),
    measures,
    totalUnits: MEASURES_PER_EXERCISE * UNITS_PER_BAR,
  };

  // 强制细胞（小节内 item 下标）→ 强制目标音 globalIndex
  const forcedNotes: number[] = [];
  let notesBeforeBar = 0;
  measures.forEach((measure, barIdx) => {
    for (const cellIdx of forcedPerBar[barIdx] ?? []) {
      let ordinal = 0;
      for (let i = 0; i <= cellIdx; i += 1) {
        if (measure.items[i]?.kind === 'note') {
          ordinal += 1;
        }
      }
      forcedNotes.push(notesBeforeBar + ordinal - 1);
    }
    notesBeforeBar += measure.items.filter((it) => it.kind === 'note').length;
  });

  const title = kind === 'sight_singing'
    ? `C 大调视唱练习 · ${LEVEL_LABELS[level]}`
    : `节奏拍手练习 · ${LEVEL_LABELS[level]}`;

  return {
    kind,
    level,
    bpm,
    seed,
    title,
    score,
    targets: buildTargets(score),
    forcedNotes,
  };
}
