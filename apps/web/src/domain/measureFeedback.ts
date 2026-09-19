// 小节级反馈：把 PerformanceReport 按小节聚合，独立重算每小节得分，
// 并生成规则化的中文逐音评语（不依赖 LLM）。
//
// 评分口径与 comparePerformance 的模式默认一致：
//  - sight_singing：音准 0.45 / 节奏 0.25 / 完整度 0.3，节奏阈值 120ms，音准 50¢；
//  - rhythm：节奏 0.65 / 完整度 0.35，节奏阈值 100ms，不评音高。

import { noteName } from '../audio/pitchTrace';
import type {
  PerformanceEventVm,
  PerformanceReport,
  TargetNote,
} from './comparePerformance';
import type { TempoAnchor } from './tempoMap';
import { secToUnits } from './tempoMap';

const UNITS_PER_BAR = 16;

const TIMING_TOL_MS: Record<PerformanceReport['mode'], number> = {
  sight_singing: 120,
  rhythm: 100,
  instrument: 100,
};

const WEIGHTS: Record<PerformanceReport['mode'], { pitch: number; timing: number; completeness: number }> = {
  sight_singing: { pitch: 0.45, timing: 0.25, completeness: 0.3 },
  rhythm: { pitch: 0, timing: 0.65, completeness: 0.35 },
  instrument: { pitch: 0.5, timing: 0.2, completeness: 0.3 },
};

export interface MeasureFeedback {
  measure: number;
  /** 本小节综合分 0..1 */
  score: number;
  matchedCount: number;
  missingCount: number;
  extraCount: number;
  pitchAccuracy: number | null;
  timingAccuracy: number | null;
  meanAbsTimingMs: number | null;
  comments: string[];
}

export interface MeasureFeedbackOptions {
  /** 预备拍偏移（秒），用于把多音折算到小节 */
  offsetSec: number;
  tempoMap: TempoAnchor[];
  measuresCount: number;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** 把多音 onset 折算到最近小节（越界夹到首/末小节）。 */
function measureOfExtra(
  onsetSec: number,
  opts: MeasureFeedbackOptions,
): number {
  const units = secToUnits(onsetSec - opts.offsetSec, opts.tempoMap);
  const measure = Math.floor(units / UNITS_PER_BAR) + 1;
  return Math.min(opts.measuresCount, Math.max(1, measure));
}

/**
 * 逐音规则评语（每个音最多两条：音准类 + 节奏类），按小节内音号排序。
 */
function eventComments(event: PerformanceEventVm, mode: PerformanceReport['mode']): string[] {
  const out: string[] = [];
  const timingTol = TIMING_TOL_MS[mode];

  if (event.pitchEvaluated) {
    if (event.wrongNote) {
      out.push(
        `第 ${event.noteIndex} 音唱成 ${noteName(event.actualMidi)}，应为 ${noteName(event.targetPitch)}`,
      );
    } else if (Math.abs(event.pitchErrorCents) > 50) {
      const dir = event.pitchErrorCents > 0 ? '偏高' : '偏低';
      out.push(`第 ${event.noteIndex} 音${dir} ${Math.abs(event.pitchErrorCents)} 音分`);
    }
  }

  if (Math.abs(event.timingErrorMs) > timingTol) {
    const dir = event.timingErrorMs > 0 ? '拖后' : '抢拍';
    out.push(`第 ${event.noteIndex} 音${dir} ${Math.abs(event.timingErrorMs)}ms`);
  }

  return out;
}

function missingComment(target: TargetNote, mode: PerformanceReport['mode']): string {
  return mode === 'rhythm'
    ? `第 ${target.noteIndex} 拍漏拍`
    : `第 ${target.noteIndex} 音漏唱`;
}

/**
 * 由 PerformanceReport 构建逐小节反馈。
 */
export function buildMeasureFeedback(
  report: PerformanceReport,
  opts: MeasureFeedbackOptions,
): MeasureFeedback[] {
  const mode = report.mode;
  const timingTol = TIMING_TOL_MS[mode];
  const weights = WEIGHTS[mode];

  const eventsByMeasure = new Map<number, PerformanceEventVm[]>();
  for (const event of report.events) {
    const list = eventsByMeasure.get(event.measure) ?? [];
    list.push(event);
    eventsByMeasure.set(event.measure, list);
  }

  const missingByMeasure = new Map<number, TargetNote[]>();
  for (const target of report.missing) {
    const list = missingByMeasure.get(target.measure) ?? [];
    list.push(target);
    missingByMeasure.set(target.measure, list);
  }

  const extrasByMeasure = new Map<number, number>();
  for (const extra of report.extra) {
    const m = measureOfExtra(extra.onset, opts);
    extrasByMeasure.set(m, (extrasByMeasure.get(m) ?? 0) + 1);
  }

  const result: MeasureFeedback[] = [];
  for (let measure = 1; measure <= opts.measuresCount; measure += 1) {
    const events = (eventsByMeasure.get(measure) ?? [])
      .slice()
      .sort((a, b) => a.noteIndex - b.noteIndex);
    const missing = missingByMeasure.get(measure) ?? [];
    const extraCount = extrasByMeasure.get(measure) ?? 0;

    const pitchEvents = events.filter((e) => e.pitchEvaluated);
    const pitchAccuracy = pitchEvents.length === 0
      ? null
      : round3(pitchEvents.filter((e) => Math.abs(e.pitchErrorCents) <= 50).length / pitchEvents.length);
    const timingAccuracy = events.length === 0
      ? null
      : round3(events.filter((e) => Math.abs(e.timingErrorMs) <= timingTol).length / events.length);

    const targetCount = events.length + missing.length;
    const completeness = targetCount === 0 ? null : round3(events.length / targetCount);

    const weighted: Array<[number | null, number]> = [
      [pitchAccuracy, weights.pitch],
      [timingAccuracy, weights.timing],
      [completeness, weights.completeness],
    ];
    let acc = 0;
    let weightSum = 0;
    for (const [value, w] of weighted) {
      if (value !== null && w > 0) {
        acc += value * w;
        weightSum += w;
      }
    }
    const score = weightSum > 0 ? round3(acc / weightSum) : 0;

    const comments: string[] = [];
    for (const m of missing.sort((a, b) => a.noteIndex - b.noteIndex)) {
      comments.push(missingComment(m, mode));
    }
    for (const event of events) {
      comments.push(...eventComments(event, mode));
    }
    if (extraCount > 0) {
      comments.push(`多出 ${extraCount} 个${mode === 'rhythm' ? '杂声/抢拍音' : '杂声/多唱音'}`);
    }
    // 小节总评
    if (comments.length === 0) {
      comments.push('本小节完成得很好，继续保持');
    } else if (score < 0.7) {
      comments.push('建议放慢速度，单独重练本小节');
    }

    const meanAbsTimingMs = events.length === 0
      ? null
      : Math.round(events.reduce((a, e) => a + Math.abs(e.timingErrorMs), 0) / events.length);

    result.push({
      measure,
      score,
      matchedCount: events.length,
      missingCount: missing.length,
      extraCount,
      pitchAccuracy,
      timingAccuracy,
      meanAbsTimingMs,
      comments,
    });
  }

  return result;
}
