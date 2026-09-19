// 实时 score following（在线增量对齐）。
//
// 输入是实时 WS 推送的 PitchFrame 流（约 25fps，40ms/帧；服务端已保证
// voiced=true 的帧 confidence ≥ 0.5），输出是"人唱到谱面哪儿了"的逐帧快照
// 与练后 PerformanceReport。引擎本身与传输解耦：UI 每收到一帧调用 feed()，
// 时间由调用方显式传入（相对跟练开始的秒数），因此可用合成帧流确定性单测。
//
// 两段状态机：
//  1. 帧 → 音符：起音需连续若干帧音高稳定（约 120ms）才确认，短促噪声直接
//     丢弃；发声中连续无声超过 restGap 切音；音高整体跳到新音级且稳定若干帧
//     判为连奏新音（不需要换气间隙）。节奏模式不看音高，稳定条件放宽。
//  2. 音符 → 谱面：游标式在线单调对齐。每个新起音在当前游标附近（含向前
//     look-ahead）寻找时间最近目标，唱过且超过宽限期仍无起音的目标判漏唱；
//     配不上目标的实际音记为多唱。对错音友好——时间对上即锁定目标，音高误差
//     照报。另有一个严格限幅的 EMA 漂移补偿（rubato/渐慢时接受窗口跟随移动，
//     但报给用户的 timing_error 永远相对写死的谱面时间，不被"自我安慰"掉）。
//
// 评分口径与离线 comparePerformance 完全共用（assemblePerformanceReport）。

import type { NoteDto } from '../api/analyze';
import {
  adaptiveOnsetWindowSec,
  assemblePerformanceReport,
  type ComparisonMode,
  type PerformanceEventVm,
  type PerformanceReport,
  type TargetNote,
} from './comparePerformance';

export interface FollowerOptions {
  /** 训练场景，默认 sight_singing */
  mode?: ComparisonMode;
  /** 目标时间轴整体偏移（预备拍秒数）：目标在 startSec + offset 才应响起，默认 0 */
  targetOffsetSec?: number;
  /** 起音对齐窗（毫秒）；缺省按目标 IOI 自适应（120–400ms） */
  onsetToleranceMs?: number;
  /** 容差窗之外额外宽限多久才判漏唱，默认 450ms */
  lateGraceMs?: number;
  /** 音准合格阈值（音分）；缺省随模式 */
  pitchToleranceCents?: number;
  /** 节奏合格阈值（毫秒）；缺省随模式 */
  timingToleranceMs?: number;
  /** 错音阈值（音分），默认 70 */
  wrongNoteCents?: number;
  /** voiced 帧置信度门限，默认 0.5（与实时 YIN 服务端门限一致） */
  minConfidence?: number;
  /** 是否启用漂移 EMA 补偿，默认 true */
  driftAdapt?: boolean;
  /** 漂移补偿最大幅度（毫秒），默认 250 */
  maxDriftMs?: number;
  /** 帧间隔（秒），默认 0.04 */
  frameHopSec?: number;
  /** 连续多少稳定帧确认起音 / 连奏新音，默认 3（≈120ms） */
  attackFrames?: number;
  /** 连续无声多久切掉当前音，默认 90ms */
  restGapMs?: number;
  /** 连奏判定：音高整体偏离当前音多少音分算新音，默认 70 */
  stepCents?: number;
  /** 起音时向前搜索的目标个数，默认 3 */
  lookAhead?: number;
}

export type FollowerStatus = 'waiting' | 'following' | 'finished';

/** 当前正在唱的音的实时信息（音未结束，数值随帧更新）。 */
export interface ActiveNoteView {
  /** 命中的目标 globalIndex；多唱的音为 null */
  targetIndex: number | null;
  onsetSec: number;
  /** 起音节奏误差（毫秒，确认瞬间即确定，负=提前） */
  timingErrorMs: number;
  /** 实时音高误差（音分，相对命中目标；多唱或节奏模式为 null） */
  pitchErrorCents: number | null;
  /** 当前平滑音高（连续 MIDI） */
  midi: number;
  confidence: number;
}

export interface FollowerSnapshot {
  status: FollowerStatus;
  /** 喂入的最新帧时间（秒） */
  nowSec: number;
  /** 当前应唱目标（游标）；全曲结束后停在最后一个 */
  currentTarget: TargetNote | null;
  /** 当前目标 globalIndex，无目标时 -1 */
  currentIndex: number;
  /** 进度 0..1 = 已处理目标数（含漏唱）/ 总目标数 */
  progress: number;
  /** 当前正在唱的音（未结束） */
  active: ActiveNoteView | null;
  /** 最近一帧是否 voiced */
  voiced: boolean;
  /** 最近一帧平滑音高 */
  liveMidi: number | null;
  /** 相对当前应唱目标的实时音分偏差（起音未确认也给，用于即时校音） */
  liveCentsError: number | null;
  /** 已落定的逐音评价（按目标顺序） */
  events: PerformanceEventVm[];
  /** 已判定的漏唱目标 */
  missing: TargetNote[];
  /** 已判定的多唱音 */
  extra: NoteDto[];
}

interface LiveFrame {
  t: number;
  midi: number;
  conf: number;
}

interface ActiveNote {
  targetIndex: number | null;
  onset: number;
  frames: LiveFrame[];
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

function median(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export class ScoreFollower {
  private readonly targets: TargetNote[];
  private readonly mode: ComparisonMode;
  private readonly offsetSec: number;
  private readonly tolSec: number;
  private readonly lateWindowSec: number;
  private readonly pitchTol: number | null;
  private readonly timingTolMs: number;
  private readonly wrongNoteCents: number;
  private readonly minConfidence: number;
  private readonly driftAdapt: boolean;
  private readonly maxDriftSec: number;
  private readonly hopSec: number;
  private readonly attackFrames: number;
  private readonly restGapSec: number;
  private readonly stepCents: number;
  private readonly lookAhead: number;
  private readonly evaluatePitch: boolean;

  private cursor = 0;
  private driftSec = 0;
  private status: FollowerStatus = 'waiting';

  private phase: 'silence' | 'attack' | 'sounding' = 'silence';
  private attackBuf: LiveFrame[] = [];
  private active: ActiveNote | null = null;
  private gapSec = 0;
  private lastFrameT: number | null = null;

  private events: PerformanceEventVm[] = [];
  private missingList: TargetNote[] = [];
  private extraList: NoteDto[] = [];
  private report: PerformanceReport | null = null;

  constructor(targets: readonly TargetNote[], options: FollowerOptions = {}) {
    this.targets = [...targets].sort((a, b) => a.startSec - b.startSec);
    this.mode = options.mode ?? 'sight_singing';
    this.evaluatePitch = this.mode !== 'rhythm';
    this.offsetSec = options.targetOffsetSec ?? 0;
    this.tolSec = options.onsetToleranceMs
      ? Math.max(1, options.onsetToleranceMs) / 1000
      : adaptiveOnsetWindowSec(this.targets.map((t) => t.startSec));
    this.lateWindowSec = this.tolSec + (options.lateGraceMs ?? 450) / 1000;
    this.pitchTol = options.pitchToleranceCents ?? null;
    this.timingTolMs = options.timingToleranceMs ?? Number.NaN;
    this.wrongNoteCents = options.wrongNoteCents ?? 70;
    this.minConfidence = options.minConfidence ?? 0.5;
    this.driftAdapt = options.driftAdapt ?? true;
    this.maxDriftSec = (options.maxDriftMs ?? 250) / 1000;
    this.hopSec = options.frameHopSec ?? 0.04;
    this.attackFrames = Math.max(1, options.attackFrames ?? 3);
    this.restGapSec = (options.restGapMs ?? 90) / 1000;
    this.stepCents = options.stepCents ?? 70;
    this.lookAhead = Math.max(0, options.lookAhead ?? 3);
  }

  /** 喂入一帧实时音高（t 为相对跟练开始的秒数）。 */
  feed(t: number, midiCents: number, voiced: boolean, confidence: number): void {
    if (this.status === 'finished') {
      return;
    }
    const dt = this.lastFrameT === null ? 0 : Math.min(Math.max(0, t - this.lastFrameT), this.hopSec * 3);
    this.lastFrameT = t;

    this.sweepMissing(t);
    this.updateStatus(t);

    const valid = voiced && confidence >= this.minConfidence;

    if (this.phase === 'silence') {
      if (valid) {
        this.phase = 'attack';
        this.attackBuf = [{ t, midi: midiCents, conf: confidence }];
      }
      return;
    }

    if (this.phase === 'attack') {
      if (!valid) {
        // 起音未确认就断了（辅音 / 噪声），直接丢弃
        this.phase = 'silence';
        this.attackBuf = [];
        return;
      }
      this.attackBuf.push({ t, midi: midiCents, conf: confidence });
      if (this.attackBuf.length >= this.attackFrames && this.attackStable()) {
        const seed = this.attackBuf.slice(-this.attackFrames);
        this.beginNote(seed[0].t, seed);
      }
      return;
    }

    // sounding
    if (valid) {
      const frames = this.active?.frames;
      this.gapSec = 0;
      if (frames && this.active) {
        frames.push({ t, midi: midiCents, conf: confidence });
        const step = this.detectStep(frames);
        if (step !== null) {
          // 连奏：在跳变起点切开，旧音落定、新音立刻对齐下一个目标
          const seed = frames.slice(step);
          this.endNote(seed[0].t);
          this.beginNote(seed[0].t, seed);
        }
      }
    } else {
      this.gapSec += dt;
      if (this.gapSec >= this.restGapSec) {
        this.endNote(this.lastFrameT !== null ? t - this.gapSec : t);
        this.phase = 'silence';
      }
    }
  }

  /** 只推进时间（无新帧时由 UI rAF 调用），用于漏唱判定与状态流转。 */
  tick(t: number): void {
    if (this.status === 'finished') {
      return;
    }
    this.lastFrameT = t;
    this.sweepMissing(t);
    this.updateStatus(t);
  }

  /** 结束跟练：落定当前音、剩余目标判漏唱、产出总结。幂等。 */
  finish(t: number): PerformanceReport {
    if (this.status === 'finished' && this.report) {
      return this.report;
    }
    if (this.phase === 'sounding' || this.phase === 'attack') {
      this.endNote(t);
      this.phase = 'silence';
    }
    while (this.cursor < this.targets.length) {
      this.missingList.push(this.targets[this.cursor]);
      this.cursor += 1;
    }
    this.status = 'finished';
    this.report = assemblePerformanceReport({
      mode: this.mode,
      events: this.events,
      missing: this.missingList,
      extra: this.extraList,
      targetCount: this.targets.length,
      actualCount: this.events.length + this.extraList.length,
      ...(this.pitchTol === null ? {} : { pitchToleranceCents: this.pitchTol }),
      ...(Number.isNaN(this.timingTolMs) ? {} : { timingToleranceMs: this.timingTolMs }),
    });
    return this.report;
  }

  snapshot(): FollowerSnapshot {
    const nowSec = this.lastFrameT ?? 0;
    const n = this.targets.length;
    const currentIndex = n === 0 ? -1 : Math.min(this.cursor, n - 1);
    const currentTarget = n === 0 ? null : this.targets[currentIndex];

    let activeView: ActiveNoteView | null = null;
    if (this.active) {
      const midi = median(this.active.frames.map((f) => f.midi));
      const conf = this.active.frames.reduce((a, f) => a + f.conf, 0) / this.active.frames.length;
      let pitchErrorCents: number | null = null;
      if (this.active.targetIndex !== null) {
        const target = this.targets[this.active.targetIndex];
        if (this.evaluatePitch && target.midi !== null) {
          pitchErrorCents = round1((midi - target.midi) * 100);
        }
      }
      const timingErrorMs =
        this.active.targetIndex === null
          ? 0
          : round1(
              (this.active.onset - this.targets[this.active.targetIndex].startSec - this.offsetSec) * 1000,
            );
      activeView = {
        targetIndex: this.active.targetIndex,
        onsetSec: this.active.onset,
        timingErrorMs,
        pitchErrorCents,
        midi,
        confidence: round1(conf),
      };
    }

    // 即时校音：即使起音还没确认，也对当前应唱目标报实时偏差
    let liveCentsError: number | null = null;
    if (this.evaluatePitch && currentTarget && currentTarget.midi !== null && this.phase !== 'silence') {
      const source = this.active
        ? this.active.frames
        : this.attackBuf.length > 0
          ? this.attackBuf.slice(-this.attackFrames)
          : [];
      if (source.length > 0) {
        liveCentsError = round1((median(source.map((f) => f.midi)) - currentTarget.midi) * 100);
      }
    }
    if (activeView && activeView.pitchErrorCents !== null) {
      liveCentsError = activeView.pitchErrorCents;
    }

    const lastVoicedFrame = this.latestFrame();
    return {
      status: this.status,
      nowSec,
      currentTarget,
      currentIndex,
      progress: n === 0 ? 1 : Math.min(1, this.cursor / n),
      active: activeView,
      voiced: this.phase !== 'silence',
      liveMidi: lastVoicedFrame?.midi ?? null,
      liveCentsError,
      events: this.events,
      missing: this.missingList,
      extra: this.extraList,
    };
  }

  // ---- 内部 ----

  private latestFrame(): LiveFrame | null {
    if (this.active && this.active.frames.length > 0) {
      return this.active.frames[this.active.frames.length - 1];
    }
    return this.attackBuf.length > 0 ? this.attackBuf[this.attackBuf.length - 1] : null;
  }

  /** 起音确认：节奏模式不看音高稳定性；视唱 / 乐器模式要求最近若干帧音高收拢。 */
  private attackStable(): boolean {
    if (!this.evaluatePitch) {
      return true;
    }
    const recent = this.attackBuf.slice(-this.attackFrames).map((f) => f.midi);
    return Math.max(...recent) - Math.min(...recent) <= 0.5; // ≤50 音分
  }

  /** 连奏跳变：最近若干帧整体偏离当前音级 ≥ stepCents，且彼此稳定。 */
  private detectStep(frames: LiveFrame[]): number | null {
    if (!this.evaluatePitch || frames.length < this.attackFrames) {
      return null;
    }
    const start = frames.length - this.attackFrames;
    const recent = frames.slice(start);
    const base = median(frames.slice(0, Math.max(1, start)).map((f) => f.midi));
    const recentMidis = recent.map((f) => f.midi);
    const spread = Math.max(...recentMidis) - Math.min(...recentMidis);
    if (spread > 0.5) {
      return null;
    }
    const shifted = recentMidis.every((m) => Math.abs(m - base) * 100 >= this.stepCents);
    return shifted ? start : null;
  }

  private effStart(i: number): number {
    return this.targets[i].startSec + this.offsetSec + this.driftSec;
  }

  /** 超过宽限期仍未唱的目标游标前移，记为漏唱。 */
  private sweepMissing(now: number): void {
    while (this.cursor < this.targets.length && now > this.effStart(this.cursor) + this.lateWindowSec) {
      this.missingList.push(this.targets[this.cursor]);
      this.cursor += 1;
    }
  }

  private updateStatus(t: number): void {
    if (this.status !== 'waiting') {
      return;
    }
    if (this.cursor > 0 || this.events.length > 0 || this.extraList.length > 0) {
      this.status = 'following';
    } else if (this.targets.length === 0 || t >= this.targets[0].startSec + this.offsetSec - this.tolSec) {
      this.status = 'following';
    }
  }

  /** 起音确认 / 连奏切分后：把新音对齐到游标附近目标。 */
  private beginNote(onset: number, seedFrames: LiveFrame[]): void {
    this.sweepMissing(onset);
    let match: number | null = null;
    let bestDist = Infinity;
    const upper = Math.min(this.targets.length - 1, this.cursor + this.lookAhead);
    for (let j = this.cursor; j <= upper; j += 1) {
      const dist = onset - this.effStart(j);
      if (dist >= -this.tolSec && dist <= this.lateWindowSec && Math.abs(dist) < Math.abs(bestDist)) {
        bestDist = dist;
        match = j;
      }
    }

    if (match !== null) {
      // 跳过的中间目标视为漏唱（直接唱到后面的音）
      while (this.cursor < match) {
        this.missingList.push(this.targets[this.cursor]);
        this.cursor += 1;
      }
      this.cursor = match + 1;
      if (this.driftAdapt) {
        // 漂移只移动接受窗口，且严格限幅，避免把跑调式偏移全"跟丢"
        const rawError = onset - this.targets[match].startSec - this.offsetSec;
        const next = this.driftSec + 0.3 * (rawError - this.driftSec);
        this.driftSec = Math.max(-this.maxDriftSec, Math.min(this.maxDriftSec, next));
      }
    }

    this.active = { targetIndex: match, onset, frames: [...seedFrames] };
    this.attackBuf = [];
    this.phase = 'sounding';
    this.gapSec = 0;
    this.status = 'following';
  }

  /** 当前音结束：命中目标则落定 PerformanceEvent，否则记为多唱。 */
  private endNote(lastVoicedT: number): void {
    const note = this.active;
    if (!note) {
      this.phase = 'silence';
      return;
    }
    const frameMidis = note.frames.map((f) => f.midi);
    const actualPitch = median(frameMidis);
    const actualMidi = Math.round(actualPitch);
    const centsOffset = (actualPitch - actualMidi) * 100;
    const confidence = note.frames.reduce((a, f) => a + f.conf, 0) / note.frames.length;

    if (note.targetIndex !== null) {
      const target = this.targets[note.targetIndex];
      const pitchEvaluated = this.evaluatePitch && target.midi !== null;
      const pitchErrorCents = pitchEvaluated ? (actualPitch - (target.midi as number)) * 100 : 0;
      const timingErrorMs = (note.onset - target.startSec - this.offsetSec) * 1000;
      this.events.push({
        targetPitch: target.midi ?? 0,
        actualPitch: pitchEvaluated ? actualPitch : 0,
        targetStart: target.startSec,
        actualStart: note.onset,
        pitchErrorCents: pitchEvaluated ? round1(pitchErrorCents) : 0,
        timingErrorMs: round1(timingErrorMs),
        measure: target.measure,
        noteIndex: target.noteIndex,
        targetGlobalIndex: target.globalIndex,
        actualMidi,
        confidence: round1(confidence),
        pitchEvaluated,
        wrongNote: pitchEvaluated && Math.abs(pitchErrorCents) >= this.wrongNoteCents,
      });
      this.events.sort((a, b) => a.targetGlobalIndex - b.targetGlobalIndex);
    } else {
      this.extraList.push({
        midi: actualMidi,
        cents_offset: round1(centsOffset),
        onset: note.onset,
        duration: Math.max(0, lastVoicedT - note.onset),
        velocity: 0.8,
        confidence: round1(confidence),
      });
    }

    this.active = null;
  }
}
