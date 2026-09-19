// Performance 比较层（compare_performance）：目标音符序列 vs 实际录音音符的对齐与评分。
//
// 这是 Phase 2 复用度最高的模块，三个训练场景共用同一套对齐核心，仅评分阈值/权重不同：
//  - sight_singing 视唱训练：音准 + 节奏 + 完整度；
//  - rhythm       节奏训练（拍手 / 敲击）：只评时间，音高不可靠一律忽略；
//  - instrument   乐器错音检测：更严的音准阈值，显式统计错音 / 漏音 / 多音。
//
// 对齐原则（关键）：按"起音时间"做全局单调对齐（Needleman–Wunsch），而不是按音高。
// 唱错 / 弹错的音仍必须对齐到对应目标位，pitch_error_cents 才有教学意义；
// 若按音高配对，错音只会被误报成"多一个音"。
//
// 输出事件字段与 proto `music.v1.PerformanceEvent` 同构（camelCase），
// 可直接经 MusicEvent.performance 跨端传输；扩展字段放同结构的 VM 类型上。
// 时间约定与 events.proto 一致：timing_error_ms / pitch_error_cents 负值=提前 / 偏低。

import type { NoteDto } from '../api/analyze';
import type { PerformanceEvent } from '../proto/music/v1/events.gen';
import { UNITS_PER_BEAT, type QuantizedScore } from './quantize';
import { unitsToSec } from './tempoMap';

/** 比较场景；只改变评分阈值与权重，不改变对齐算法。 */
export type ComparisonMode = 'sight_singing' | 'rhythm' | 'instrument';

/** 目标音符（来自量化谱 / 练习 / 参考 MIDI），时间轴与实际录音一致。 */
export interface TargetNote {
  /** 目标音高 MIDI；节奏模式（拍手等无音高目标）可为 null */
  midi: number | null;
  /** 目标起始时间（秒） */
  startSec: number;
  /** 目标时长（秒） */
  durationSec: number;
  /** 定位：第几小节（1 基） */
  measure: number;
  /** 定位：小节内第几个音（1 基，只数音符不数休止） */
  noteIndex: number;
  /** 全局旋律音序号（0 基） */
  globalIndex: number;
}

export interface CompareOptions {
  /** 训练场景，默认 sight_singing */
  mode?: ComparisonMode;
  /**
   * 对齐时间窗（毫秒）：实际起音落在目标 ±窗口内才倾向配对。
   * 缺省时按目标相邻起音间隔（IOI）中位数自适应：clamp(0.45·IOI, 120ms, 400ms)。
   */
  onsetToleranceMs?: number;
  /** 音准合格阈值（音分），|误差| ≤ 阈值计入 pitchAccuracy；缺省随模式 50 / 忽略 / 35 */
  pitchToleranceCents?: number;
  /** 节奏合格阈值（毫秒），|误差| ≤ 阈值计入 timingAccuracy；缺省随模式 120 / 100 / 100 */
  timingToleranceMs?: number;
  /** 错音阈值（音分）：|音高误差| ≥ 该值判为错音，默认 70（约 2/3 半音） */
  wrongNoteCents?: number;
  /**
   * 实际录音相对目标时间轴的固定偏移（秒）。
   * 伴奏有预备拍 / 采集延迟时，用它把实际 onset 平移回目标轴，默认 0。
   */
  actualOffsetSec?: number;
  /** 丢弃低置信度实际音的阈值，默认 0（检测端已过滤，比较层不默认丢证据） */
  minConfidence?: number;
}

/** 单个已配对音的评价：proto PerformanceEvent 字段 + 教学扩展字段。 */
export interface PerformanceEventVm extends PerformanceEvent {
  /** 对应 TargetNote.globalIndex */
  targetGlobalIndex: number;
  /** 实际音的 MIDI 音级（检测器整数音号） */
  actualMidi: number;
  /** 实际音检测置信度 0..1 */
  confidence: number;
  /** 本音是否参评音高（节奏模式 / 无音高目标为 false，音分字段置 0） */
  pitchEvaluated: boolean;
  /** 是否错音（仅 pitchEvaluated 时可能为 true） */
  wrongNote: boolean;
}

export interface PerformanceSummary {
  targetCount: number;
  actualCount: number;
  matchedCount: number;
  /** 漏音 / 漏拍：目标存在但无对应实际音 */
  missingCount: number;
  /** 多音 / 抢拍杂声：实际音未匹配到任何目标 */
  extraCount: number;
  /** 错音个数；节奏模式为 null（不评音高） */
  wrongNoteCount: number | null;
  /** 平均音高偏差（音分，带符号，负=偏低）；无参评音时 null */
  meanPitchErrorCents: number | null;
  /** 平均绝对音高偏差；无参评音时 null */
  meanAbsPitchErrorCents: number | null;
  /** 平均节奏偏差（毫秒，带符号，负=提前）；无配对时 null */
  meanTimingErrorMs: number | null;
  /** 平均绝对节奏偏差；无配对时 null */
  meanAbsTimingErrorMs: number | null;
  /** 音准合格率 0..1（|误差| ≤ pitchToleranceCents）；不评音高 / 无参评音时 null */
  pitchAccuracy: number | null;
  /** 节奏合格率 0..1（|误差| ≤ timingToleranceMs）；无配对时 null */
  timingAccuracy: number | null;
  /** 完整度 0..1 = 配对数 / 目标数；无目标时 null */
  completeness: number | null;
  /** 模式加权综合分 0..1；空目标序列为 null */
  overallScore: number | null;
}

export interface PerformanceReport {
  mode: ComparisonMode;
  /** 已配对的逐音评价，按目标顺序排列 */
  events: PerformanceEventVm[];
  /** 漏音 / 漏拍的目标音 */
  missing: TargetNote[];
  /** 多出来的实际音 */
  extra: NoteDto[];
  summary: PerformanceSummary;
}

interface ModeDefaults {
  pitchToleranceCents: number | null;
  timingToleranceMs: number;
  pitchWeight: number;
  timingWeight: number;
  completenessWeight: number;
}

const MODE_DEFAULTS: Record<ComparisonMode, ModeDefaults> = {
  sight_singing: { pitchToleranceCents: 50, timingToleranceMs: 120, pitchWeight: 0.45, timingWeight: 0.25, completenessWeight: 0.3 },
  rhythm: { pitchToleranceCents: null, timingToleranceMs: 100, pitchWeight: 0, timingWeight: 0.65, completenessWeight: 0.35 },
  instrument: { pitchToleranceCents: 35, timingToleranceMs: 100, pitchWeight: 0.5, timingWeight: 0.2, completenessWeight: 0.3 },
};

const DEFAULT_WRONG_NOTE_CENTS = 70;
const GAP_COST = 1;
const EPS = 1e-9;

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * 全局单调序列对齐（Needleman–Wunsch，按起音时间）。
 *
 * 代价：配对 = |Δt| / windowSec（不加封顶），漏目标 / 多实际各为 gap=1。
 * 窗口内配对代价 < 1，比走 gap 便宜；窗口外配对代价 > 1，不如"漏一个 +
 * 多一个"共 2 的 gap 路由，从而自然识别漏音与多音，且不会把整段错位的音
 * 硬配在一起。回溯时平局优先配对，保证错音（时间准、音高错）不会被拆成漏 + 多。
 */
function alignIndices(
  targetStarts: readonly number[],
  actualOnsets: readonly number[],
  windowSec: number,
): { pairs: Array<[number, number]>; missing: number[]; extra: number[] } {
  const n = targetStarts.length;
  const m = actualOnsets.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    dp[i][0] = i * GAP_COST;
  }
  for (let j = 1; j <= m; j += 1) {
    dp[0][j] = j * GAP_COST;
  }

  const matchCost = (i: number, j: number): number =>
    Math.abs(targetStarts[i] - actualOnsets[j]) / windowSec;

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const diagonal = dp[i - 1][j - 1] + matchCost(i - 1, j - 1);
      const targetGap = dp[i - 1][j] + GAP_COST; // 漏目标音
      const actualGap = dp[i][j - 1] + GAP_COST; // 多实际音
      dp[i][j] = Math.min(diagonal, targetGap, actualGap);
    }
  }

  const pairs: Array<[number, number]> = [];
  const missing: number[] = [];
  const extra: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const diagonal = dp[i - 1][j - 1] + matchCost(i - 1, j - 1);
      if (Math.abs(dp[i][j] - diagonal) < EPS) {
        pairs.push([i - 1, j - 1]);
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && (j === 0 || dp[i][j] === dp[i - 1][j] + GAP_COST)) {
      missing.push(i - 1);
      i -= 1;
    } else {
      extra.push(j - 1);
      j -= 1;
    }
  }

  pairs.sort((a, b) => a[0] - b[0]);
  missing.sort((a, b) => a - b);
  extra.sort((a, b) => a - b);
  return { pairs, missing, extra };
}

/** 自适应对齐窗：取目标相邻起音间隔中位数的 45%，夹在 120–400ms。离线对齐与实时跟谱共用。 */
export function adaptiveOnsetWindowSec(targetStarts: readonly number[]): number {
  if (targetStarts.length < 2) {
    return 0.3;
  }
  const iois = targetStarts
    .slice(1)
    .map((s, idx) => s - targetStarts[idx])
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  if (iois.length === 0) {
    return 0.3;
  }
  const median = iois[Math.floor(iois.length / 2)];
  return Math.min(0.4, Math.max(0.12, median * 0.45));
}

/** assemblePerformanceReport 输入：已完成对齐的逐音事件 + 漏 / 多音列表。 */
export interface AssembleReportInput {
  mode: ComparisonMode;
  events: PerformanceEventVm[];
  missing: TargetNote[];
  extra: NoteDto[];
  targetCount: number;
  actualCount: number;
  /** 显式覆盖音准 / 节奏合格阈值；缺省取模式默认 */
  pitchToleranceCents?: number | null;
  timingToleranceMs?: number;
}

/**
 * 由逐音事件汇总 PerformanceReport。离线 comparePerformance 与实时
 * ScoreFollower 共用同一份评分口径，保证练后总结与离线复评一致。
 */
export function assemblePerformanceReport(input: AssembleReportInput): PerformanceReport {
  const { mode, events, missing, extra, targetCount, actualCount } = input;
  const defaults = MODE_DEFAULTS[mode];
  const pitchTol = input.pitchToleranceCents ?? defaults.pitchToleranceCents;
  const timingTolMs = input.timingToleranceMs ?? defaults.timingToleranceMs;
  const evaluatePitch = mode !== 'rhythm';

  const pitchEvents = events.filter((e) => e.pitchEvaluated);
  const pitchErrors = pitchEvents.map((e) => e.pitchErrorCents);
  const timingErrors = events.map((e) => e.timingErrorMs);

  const mean = (xs: readonly number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanAbs = (xs: readonly number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;

  const meanPitch = mean(pitchErrors);
  const meanAbsPitch = meanAbs(pitchErrors);
  const meanTiming = mean(timingErrors);
  const meanAbsTiming = meanAbs(timingErrors);

  const pitchAccuracy =
    pitchTol === null || pitchEvents.length === 0
      ? null
      : round3(pitchEvents.filter((e) => Math.abs(e.pitchErrorCents) <= pitchTol).length / pitchEvents.length);
  const timingAccuracy =
    events.length === 0
      ? null
      : round3(events.filter((e) => Math.abs(e.timingErrorMs) <= timingTolMs).length / events.length);
  const completeness = targetCount === 0 ? null : round3(events.length / targetCount);

  let overallScore: number | null = null;
  if (completeness !== null) {
    const weighted: Array<[number | null, number]> = [
      [pitchAccuracy, defaults.pitchWeight],
      [timingAccuracy, defaults.timingWeight],
      [completeness, defaults.completenessWeight],
    ];
    let acc = 0;
    let weightSum = 0;
    for (const [value, w] of weighted) {
      if (value !== null && w > 0) {
        acc += value * w;
        weightSum += w;
      }
    }
    overallScore = weightSum > 0 ? round3(acc / weightSum) : null;
  }

  return {
    mode,
    events,
    missing,
    extra,
    summary: {
      targetCount,
      actualCount,
      matchedCount: events.length,
      missingCount: missing.length,
      extraCount: extra.length,
      wrongNoteCount: evaluatePitch ? events.filter((e) => e.wrongNote).length : null,
      meanPitchErrorCents: meanPitch === null ? null : round1(meanPitch),
      meanAbsPitchErrorCents: meanAbsPitch === null ? null : round1(meanAbsPitch),
      meanTimingErrorMs: meanTiming === null ? null : round1(meanTiming),
      meanAbsTimingErrorMs: meanAbsTiming === null ? null : round1(meanAbsTiming),
      pitchAccuracy,
      timingAccuracy,
      completeness,
      overallScore,
    },
  };
}

/**
 * compare_performance：把实际录音音符对齐到目标音符序列并逐音评分。
 *
 * @param targets 目标音符（可用 targetNotesFromScore 从量化谱展开）
 * @param actual  实际录音检出的 NoteEvent（秒级时间轴）
 */
export function comparePerformance(
  targets: readonly TargetNote[],
  actual: readonly NoteDto[],
  options: CompareOptions = {},
): PerformanceReport {
  const mode = options.mode ?? 'sight_singing';
  const defaults = MODE_DEFAULTS[mode];
  const pitchTol = options.pitchToleranceCents ?? defaults.pitchToleranceCents;
  const timingTolMs = options.timingToleranceMs ?? defaults.timingToleranceMs;
  const wrongNoteCents = options.wrongNoteCents ?? DEFAULT_WRONG_NOTE_CENTS;
  const offsetSec = options.actualOffsetSec ?? 0;
  const minConfidence = options.minConfidence ?? 0;

  const sortedTargets = [...targets].sort((a, b) => a.startSec - b.startSec);
  const consideredActual = actual
    .filter((n) => n.confidence >= minConfidence)
    .map((n) => ({ n, shifted: n.onset - offsetSec }))
    .sort((a, b) => a.shifted - b.shifted);

  const targetStarts = sortedTargets.map((t) => t.startSec);
  const actualOnsets = consideredActual.map((a) => a.shifted);
  const windowMs = options.onsetToleranceMs
    ? Math.max(1, options.onsetToleranceMs)
    : adaptiveOnsetWindowSec(targetStarts) * 1000;

  const { pairs, missing, extra } = alignIndices(targetStarts, actualOnsets, windowMs / 1000);

  const evaluatePitch = mode !== 'rhythm';
  const events: PerformanceEventVm[] = pairs.map(([ti, aj]) => {
    const t = sortedTargets[ti];
    const a = consideredActual[aj].n;
    const actualPitch = a.midi + a.cents_offset / 100;
    const pitchEvaluated = evaluatePitch && t.midi !== null;
    const pitchErrorCents = pitchEvaluated ? (actualPitch - (t.midi as number)) * 100 : 0;
    const timingErrorMs = (consideredActual[aj].shifted - t.startSec) * 1000;
    return {
      targetPitch: t.midi ?? 0,
      actualPitch: pitchEvaluated ? actualPitch : 0,
      targetStart: t.startSec,
      actualStart: a.onset,
      pitchErrorCents: pitchEvaluated ? round1(pitchErrorCents) : 0,
      timingErrorMs: round1(timingErrorMs),
      measure: t.measure,
      noteIndex: t.noteIndex,
      targetGlobalIndex: t.globalIndex,
      actualMidi: a.midi,
      confidence: a.confidence,
      pitchEvaluated,
      wrongNote: pitchEvaluated && Math.abs(pitchErrorCents) >= wrongNoteCents,
    };
  });

  return assemblePerformanceReport({
    mode,
    events,
    missing: missing.map((ti) => sortedTargets[ti]),
    extra: extra.map((aj) => consideredActual[aj].n),
    targetCount: sortedTargets.length,
    actualCount: consideredActual.length,
    pitchToleranceCents: pitchTol,
    timingToleranceMs: timingTolMs,
  });
}

interface FlatScoreItem {
  startUnit: number;
  units: number;
  midi: number | null;
}

/**
 * 量化谱 → 目标音符序列：把各小节的音符条目铺到秒轴，并附带小节 / 小节内音号定位。
 *
 * 合并规则：相邻且音高相同、中间无休止的条目合并为一次"起音"。quantize 会把
 * 非标准网格时长分解成多个标准时值条目（如 7 格 = 附点四分 + 16 分），跨小节长音
 * 也会在小节线处切开；它们在听觉上只是一次起音。同音高连奏若毫无间隙，起音检测
 * 同样无法切分，合并策略与检测能力保持一致。秒 ↔ 网格走谱面 tempoMap（支持变速）。
 */
export function targetNotesFromScore(score: QuantizedScore): TargetNote[] {
  const unitsPerBar = UNITS_PER_BEAT * score.beatsPerBar;

  const flat: FlatScoreItem[] = [];
  score.measures.forEach((measure) => {
    let offsetUnits = 0;
    for (const item of measure.items) {
      flat.push({
        startUnit: measure.startUnit + offsetUnits,
        units: item.units,
        midi: item.kind === 'note' && item.midi !== undefined ? item.midi : null,
      });
      offsetUnits += item.units;
    }
  });

  // 合并相邻同音高条目（休止 midi=null 打断合并）
  const runs: FlatScoreItem[] = [];
  for (const item of flat) {
    const last = runs[runs.length - 1];
    if (last && item.midi !== null && last.midi === item.midi) {
      last.units += item.units;
    } else {
      runs.push({ ...item });
    }
  }

  const perMeasureCount = new Map<number, number>();
  const targets: TargetNote[] = [];
  for (const run of runs) {
    if (run.midi === null) {
      continue;
    }
    const measure = Math.floor(run.startUnit / unitsPerBar) + 1;
    const noteIndex = (perMeasureCount.get(measure) ?? 0) + 1;
    perMeasureCount.set(measure, noteIndex);
    const startSec = unitsToSec(run.startUnit, score.tempoMap);
    const endSec = unitsToSec(run.startUnit + run.units, score.tempoMap);
    targets.push({
      midi: run.midi,
      startSec,
      durationSec: endSec - startSec,
      measure,
      noteIndex,
      globalIndex: targets.length,
    });
  }
  return targets;
}
