// 多段变速 tempo map：秒 ↔ tick / 16 分网格的分段线性映射。
//
// 与后端 services/analysis/app/midi.py 的约定同构：
//  - 锚点升序，首锚点 timeSec=0，锚点 i 的 bpm 从 timeSec(i) 生效至下一锚点；
//  - TPQ=480，一个 16 分音符单元 = 120 tick；
//  - tick 域锚点由秒域锚点按前一段速度积分递推；
//  - 末段之后按末段速度线性外推。
// 量化（quantize）、播放排程（scorePlayer）、MIDI 导出（midiWriter）共用本模块。

import type { FlatEvent } from '../api/analyze';

export const TPQ = 480;
/** 16 分音符网格 → tick：480/4 */
export const TICKS_PER_UNIT = TPQ / 4;

export interface TempoAnchor {
  /** 该速度生效的时间点（秒） */
  timeSec: number;
  bpm: number;
}

interface IntegratedAnchor extends TempoAnchor {
  /** 该锚点对应的绝对 tick（由秒域积分得出） */
  tick: number;
}

/** 单段恒定速度 map（手动覆盖 BPM / 无检测结果时使用）。 */
export function constantTempoMap(bpm: number): TempoAnchor[] {
  return [{ timeSec: 0, bpm: clampBpm(bpm) }];
}

/** 排序 / 去重 / 补齐 timeSec=0 首锚点（镜像后端 _normalize_tempo_map）。 */
export function normalizeTempoMap(anchors: TempoAnchor[]): TempoAnchor[] {
  if (anchors.length === 0) {
    return constantTempoMap(100);
  }
  const sorted = [...anchors].sort((a, b) => a.timeSec - b.timeSec);
  if (sorted[0].timeSec > 0) {
    sorted.unshift({ timeSec: 0, bpm: sorted[0].bpm });
  }
  // 同一时刻只保留最后一个
  const deduped: TempoAnchor[] = [];
  for (const a of sorted) {
    const last = deduped[deduped.length - 1];
    if (last && last.timeSec === a.timeSec) {
      last.bpm = a.bpm;
    } else {
      deduped.push({ ...a });
    }
  }
  return deduped;
}

function integrate(anchors: TempoAnchor[]): IntegratedAnchor[] {
  const normalized = normalizeTempoMap(anchors);
  const out: IntegratedAnchor[] = [];
  let tick = 0;
  let prevSec = 0;
  normalized.forEach((a, i) => {
    if (i > 0) {
      tick += (a.timeSec - prevSec) * TPQ * out[i - 1].bpm / 60;
    }
    out.push({ timeSec: a.timeSec, bpm: a.bpm, tick });
    prevSec = a.timeSec;
  });
  return out;
}

function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return 100;
  }
  return Math.min(200, Math.max(40, Math.round(bpm)));
}

/** 秒 → tick（分段线性，末段外推）。 */
export function secToTick(sec: number, anchors: TempoAnchor[]): number {
  const map = integrate(anchors);
  if (sec <= 0) {
    return 0;
  }
  for (let i = 0; i < map.length; i += 1) {
    const cur = map[i];
    const nextSec = i + 1 < map.length ? map[i + 1].timeSec : Infinity;
    if (sec < nextSec || i === map.length - 1) {
      return cur.tick + (sec - cur.timeSec) * TPQ * cur.bpm / 60;
    }
  }
  return 0;
}

/** tick → 秒（secToTick 的反函数，末段外推）。 */
export function tickToSec(tick: number, anchors: TempoAnchor[]): number {
  const map = integrate(anchors);
  if (tick <= 0) {
    return 0;
  }
  for (let i = 0; i < map.length; i += 1) {
    const cur = map[i];
    const nextTick = i + 1 < map.length ? map[i + 1].tick : Infinity;
    if (tick < nextTick || i === map.length - 1) {
      return cur.timeSec + (tick - cur.tick) * 60 / (TPQ * cur.bpm);
    }
  }
  return 0;
}

/** 秒 → 16 分网格单元（可小数；量化取整由调用方决定）。 */
export function secToUnits(sec: number, anchors: TempoAnchor[]): number {
  return secToTick(sec, anchors) / TICKS_PER_UNIT;
}

/** 16 分网格单元 → 秒。 */
export function unitsToSec(units: number, anchors: TempoAnchor[]): number {
  return tickToSec(units * TICKS_PER_UNIT, anchors);
}

/**
 * 从扁平 events（网关把 TempoEvent 扁平化为 type==='tempo'）构建 tempo map。
 * 没有 tempo 事件时用 fallbackBpm 退化为单段。
 */
export function tempoMapFromEvents(
  events: readonly FlatEvent[] | undefined | null,
  fallbackBpm: number,
): TempoAnchor[] {
  const anchors = (events ?? [])
    .filter((e) => e.type === 'tempo')
    .map((e) => ({
      timeSec: Number(e.time ?? 0),
      bpm: clampBpm(Number(e.bpm ?? fallbackBpm)),
    }))
    .filter((a) => Number.isFinite(a.timeSec) && a.timeSec >= 0);
  if (anchors.length === 0) {
    return constantTempoMap(fallbackBpm);
  }
  return normalizeTempoMap(anchors);
}

/** 速度段摘要文案，如 "♩=120 → 90 @3.0s"；单段只返回 "♩=120"。 */
export function describeTempoMap(anchors: TempoAnchor[]): string {
  const map = normalizeTempoMap(anchors);
  const head = `♩=${map[0].bpm}`;
  if (map.length === 1) {
    return head;
  }
  const rest = map
    .slice(1)
    .map((a) => `${a.bpm} @${a.timeSec.toFixed(1)}s`)
    .join(' → ');
  return `${head} → ${rest}`;
}
