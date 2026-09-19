import { describe, expect, it } from 'vitest';
import type { NoteDto } from '../api/analyze';
import { constantTempoMap } from './tempoMap';
import { quantize } from './quantize';
import {
  comparePerformance,
  targetNotesFromScore,
  type TargetNote,
} from './comparePerformance';

/** 构造实际录音音符（NoteEvent DTO），默认 120BPM 四分音符网格上的标准音。 */
function note(midi: number, onset: number, opts: Partial<NoteDto> = {}): NoteDto {
  return {
    midi,
    cents_offset: 0,
    onset,
    duration: 0.4,
    velocity: 0.8,
    confidence: 0.9,
    ...opts,
  };
}

/** 以 [MIDI, 起音秒] 列表构造目标音，每行 4 个四分音符（4/4，120BPM）。 */
function makeTargets(spec: Array<[number | null, number]>): TargetNote[] {
  return spec.map(([midi, startSec], idx) => ({
    midi,
    startSec,
    durationSec: 0.5,
    measure: Math.floor(idx / 4) + 1,
    noteIndex: (idx % 4) + 1,
    globalIndex: idx,
  }));
}

const ARPEGGIO: Array<[number, number]> = [
  [60, 0],
  [64, 0.5],
  [67, 1.0],
  [72, 1.5],
];

describe('comparePerformance - 完美演奏', () => {
  it('零偏差时全部指标满分且保留小节定位', () => {
    const targets = makeTargets(ARPEGGIO);
    const actual = ARPEGGIO.map(([midi, onset]) => note(midi, onset));
    const report = comparePerformance(targets, actual);

    expect(report.mode).toBe('sight_singing');
    expect(report.events).toHaveLength(4);
    expect(report.missing).toHaveLength(0);
    expect(report.extra).toHaveLength(0);
    for (const e of report.events) {
      expect(e.pitchErrorCents).toBe(0);
      expect(e.timingErrorMs).toBe(0);
      expect(e.wrongNote).toBe(false);
      expect(e.pitchEvaluated).toBe(true);
    }
    expect(report.events.map((e) => e.measure)).toEqual([1, 1, 1, 1]);
    expect(report.events.map((e) => e.noteIndex)).toEqual([1, 2, 3, 4]);
    expect(report.summary).toMatchObject({
      targetCount: 4,
      matchedCount: 4,
      missingCount: 0,
      extraCount: 0,
      wrongNoteCount: 0,
      pitchAccuracy: 1,
      timingAccuracy: 1,
      completeness: 1,
      overallScore: 1,
    });
  });
});

describe('comparePerformance - 音高评价（视唱 / 乐器）', () => {
  it('cents_offset 原样进入 pitch_error_cents，负=偏低，actualPitch 为连续 MIDI', () => {
    const targets = makeTargets([[60, 0]]);
    const actual = [note(60, 0, { cents_offset: -30 })];
    const [e] = comparePerformance(targets, actual).events;
    expect(e.pitchErrorCents).toBe(-30);
    expect(e.actualPitch).toBeCloseTo(59.7, 6);
    expect(e.targetPitch).toBe(60);
    expect(e.wrongNote).toBe(false);
  });

  it('唱高 120 音分判为错音，且汇总平均保留符号', () => {
    const targets = makeTargets([
      [60, 0],
      [64, 0.5],
    ]);
    const actual = [
      note(60, 0, { cents_offset: 120 }),
      note(64, 0.5, { cents_offset: 10 }),
    ];
    const report = comparePerformance(targets, actual);
    expect(report.events[0].wrongNote).toBe(true);
    expect(report.events[1].wrongNote).toBe(false);
    expect(report.summary.wrongNoteCount).toBe(1);
    expect(report.summary.meanPitchErrorCents).toBe(65); // (120+10)/2
    expect(report.summary.meanAbsPitchErrorCents).toBe(65);
    expect(report.summary.pitchAccuracy).toBe(0.5);
  });

  it('乐器错音场景：目标 G4 实际 F4，时间准确仍按位置对齐而不是报多音', () => {
    const targets = makeTargets([
      [60, 0],
      [64, 0.5],
      [67, 1.0],
      [72, 1.5],
    ]);
    const actual = [note(60, 0), note(64, 0.5), note(65, 1.0), note(72, 1.5)];
    const report = comparePerformance(targets, actual, { mode: 'instrument' });

    expect(report.events).toHaveLength(4);
    expect(report.missing).toHaveLength(0);
    expect(report.extra).toHaveLength(0);
    const wrong = report.events[2];
    expect(wrong.targetPitch).toBe(67);
    expect(wrong.actualMidi).toBe(65);
    expect(wrong.pitchErrorCents).toBe(-200);
    expect(wrong.wrongNote).toBe(true);
    expect(wrong.measure).toBe(1);
    expect(wrong.noteIndex).toBe(3);
    expect(report.summary.wrongNoteCount).toBe(1);
    // 乐器模式音准阈值 35 音分：只有第一、二、四个音合格
    expect(report.summary.pitchAccuracy).toBeCloseTo(0.75, 5);
  });

  it('音准阈值可按场景覆盖', () => {
    const targets = makeTargets([[60, 0]]);
    const actual = [note(60, 0, { cents_offset: 40 })];
    expect(comparePerformance(targets, actual).summary.pitchAccuracy).toBe(1); // 视唱阈值 50
    expect(
      comparePerformance(targets, actual, { mode: 'instrument' }).summary.pitchAccuracy,
    ).toBe(0); // 乐器阈值 35
  });
});

describe('comparePerformance - 节奏评价', () => {
  it('timing_error_ms 正=滞后负=提前', () => {
    const targets = makeTargets([
      [60, 0],
      [64, 0.5],
    ]);
    const actual = [
      note(60, 0, { cents_offset: 200 }), // 音高离谱但时间准
      note(64, 0.44), // 提前 60ms
    ];
    const report = comparePerformance(targets, actual);
    expect(report.events[0].timingErrorMs).toBe(0);
    expect(report.events[1].timingErrorMs).toBe(-60);
  });

  it('rhythm 模式忽略全部音高证据，只按时间评分', () => {
    const targets = makeTargets([
      [null, 0],
      [null, 0.5],
      [null, 1.0],
    ]);
    // 拍手声被检测器标成任意 MIDI / cents，均不应影响结果
    const actual = [
      note(49, 0, { cents_offset: -300 }),
      note(72, 0.56, { cents_offset: 250 }),
      note(60, 1.02),
    ];
    const report = comparePerformance(targets, actual, { mode: 'rhythm' });
    expect(report.events).toHaveLength(3);
    for (const e of report.events) {
      expect(e.pitchEvaluated).toBe(false);
      expect(e.pitchErrorCents).toBe(0);
      expect(e.wrongNote).toBe(false);
    }
    expect(report.summary.wrongNoteCount).toBeNull();
    expect(report.summary.meanPitchErrorCents).toBeNull();
    expect(report.summary.pitchAccuracy).toBeNull();
    expect(report.summary.meanTimingErrorMs).toBeCloseTo(26.7, 1); // (0+60+20)/3
    expect(report.summary.timingAccuracy).toBe(1); // ±100ms 内
    expect(report.summary.completeness).toBe(1);
    expect(report.summary.overallScore).toBe(1);
  });

  it('actualOffsetSec 补偿预备拍 / 采集延迟后的统一晚启', () => {
    const targets = makeTargets([
      [60, 0],
      [64, 0.5],
    ]);
    const actual = [note(60, 1.0), note(64, 1.5)];
    const raw = comparePerformance(targets, actual);
    // 默认窗口 225ms：1s 偏差下两个目标全部判漏
    expect(raw.summary.matchedCount).toBe(0);
    const shifted = comparePerformance(targets, actual, { actualOffsetSec: 1.0 });
    expect(shifted.events).toHaveLength(2);
    expect(shifted.events.every((e) => e.timingErrorMs === 0)).toBe(true);
    // actualStart 保留原始证据时间，不做平移
    expect(shifted.events[0].actualStart).toBe(1.0);
  });
});

describe('comparePerformance - 漏音 / 多音级联对齐', () => {
  it('漏掉第二个音不影响后续音配对', () => {
    const targets = makeTargets([
      [60, 0],
      [64, 0.5],
      [67, 1.0],
      [72, 1.5],
    ]);
    const actual = [note(60, 0), note(67, 1.0), note(72, 1.5)];
    const report = comparePerformance(targets, actual);

    expect(report.missing).toHaveLength(1);
    expect(report.missing[0].midi).toBe(64);
    expect(report.extra).toHaveLength(0);
    expect(report.events.map((e) => e.targetPitch)).toEqual([60, 67, 72]);
    expect(report.events.every((e) => e.timingErrorMs === 0)).toBe(true);
    expect(report.summary.completeness).toBeCloseTo(0.75, 5);
  });

  it('中间插入的多余实际音判为 extra，不挤掉后续配对', () => {
    const targets = makeTargets([
      [60, 0],
      [67, 0.5],
    ]);
    const actual = [note(60, 0), note(62, 0.25), note(67, 0.5)];
    const report = comparePerformance(targets, actual);

    expect(report.events.map((e) => e.targetPitch)).toEqual([60, 67]);
    expect(report.extra).toHaveLength(1);
    expect(report.extra[0].midi).toBe(62);
    expect(report.events[1].timingErrorMs).toBe(0);
  });

  it('低置信度音符按 minConfidence 丢弃，不计入多音', () => {
    const targets = makeTargets([[60, 0]]);
    const actual = [note(60, 0), note(62, 0.25, { confidence: 0.2 })];
    const report = comparePerformance(targets, actual, { minConfidence: 0.5 });
    expect(report.summary.actualCount).toBe(1);
    expect(report.extra).toHaveLength(0);
  });

  it('慢速度下自适应窗口仍能正确配对', () => {
    // 两秒一个音（约 30BPM 四分音符）：自适应窗 0.45*2=0.9 被截到 400ms
    const targets = makeTargets([
      [60, 0],
      [64, 2.0],
    ]);
    const actual = [note(60, 0), note(64, 2.1)];
    const report = comparePerformance(targets, actual);
    expect(report.events).toHaveLength(2);
    expect(report.events[1].timingErrorMs).toBe(100);
  });
});

describe('comparePerformance - 边界', () => {
  it('空序列不产出 NaN，评分维度为 null', () => {
    const report = comparePerformance([], []);
    expect(report.events).toEqual([]);
    expect(report.summary).toMatchObject({
      targetCount: 0,
      actualCount: 0,
      matchedCount: 0,
      pitchAccuracy: null,
      timingAccuracy: null,
      completeness: null,
      overallScore: null,
    });
  });

  it('实际输入乱序时按 onset 排序后对齐', () => {
    const targets = makeTargets([
      [60, 0],
      [64, 0.5],
    ]);
    const actual = [note(64, 0.5), note(60, 0)];
    const report = comparePerformance(targets, actual);
    expect(report.events.map((e) => e.targetPitch)).toEqual([60, 64]);
  });
});

describe('targetNotesFromScore - 量化谱适配器', () => {
  it('120BPM 四分音符：网格 → 秒与小节/小节内音号', () => {
    const notes = [
      note(60, 0, { duration: 0.5 }),
      note(64, 0.5, { duration: 0.5 }),
      note(67, 1.0, { duration: 0.5 }),
      note(72, 1.5, { duration: 0.5 }),
    ];
    const score = quantize(notes, { tempoMap: constantTempoMap(120) });
    const targets = targetNotesFromScore(score);

    expect(targets).toHaveLength(4);
    expect(targets.map((t) => t.startSec)).toEqual([0, 0.5, 1, 1.5]);
    expect(targets.map((t) => t.measure)).toEqual([1, 1, 1, 1]);
    expect(targets.map((t) => t.noteIndex)).toEqual([1, 2, 3, 4]);
    expect(targets.map((t) => t.globalIndex)).toEqual([0, 1, 2, 3]);
    expect(targets.every((t) => Math.abs(t.durationSec - 0.5) < 1e-9)).toBe(true);
  });

  it('跨小节长音被 quantize 切开后，适配器合并回一次起音', () => {
    // 1.5s 起、持续 1.5s：120BPM 下占第 12~24 格，跨越第 16 格小节线
    const score = quantize([note(60, 1.5, { duration: 1.5 })], {
      tempoMap: constantTempoMap(120),
    });
    const targets = targetNotesFromScore(score);

    expect(targets).toHaveLength(1);
    expect(targets[0].startSec).toBe(1.5);
    expect(targets[0].durationSec).toBeCloseTo(1.5, 9);
    expect(targets[0].measure).toBe(1);
    expect(targets[0].noteIndex).toBe(1);
  });

  it('8 个四分音符定位到两个小节，休止符不占音号', () => {
    const notes = Array.from({ length: 8 }, (_, i) => note(60 + i, i * 0.5, { duration: 0.5 }));
    const score = quantize(notes, { tempoMap: constantTempoMap(120) });
    const targets = targetNotesFromScore(score);
    expect(targets.map((t) => t.measure)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(targets.map((t) => t.noteIndex)).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it('多段变速 tempo map：第二段 90BPM 的拍点按分段积分换算', () => {
    // 第一段 120BPM 8 拍（0~4s），第二段 90BPM，拍长 2/3s
    const firstSeg = Array.from({ length: 8 }, (_, i) => note(60 + i, i * 0.5, { duration: 0.44 }));
    const secondSeg = Array.from({ length: 4 }, (_, i) =>
      note(72 + i, 4 + (i * 2) / 3, { duration: 0.6 }),
    );
    const score = quantize([...firstSeg, ...secondSeg], {
      tempoMap: [
        { timeSec: 0, bpm: 120 },
        { timeSec: 4, bpm: 90 },
      ],
    });
    const targets = targetNotesFromScore(score);

    expect(targets).toHaveLength(12);
    expect(targets[8].startSec).toBeCloseTo(4, 9);
    expect(targets[9].startSec).toBeCloseTo(4 + 2 / 3, 9);
    expect(targets[10].startSec).toBeCloseTo(4 + 4 / 3, 9);
  });

  it('适配器产出的目标可直接与"偏慢偏音"的实际录音比较', () => {
    const notes = [note(60, 0), note(64, 0.5), note(67, 1.0)];
    const score = quantize(notes, { tempoMap: constantTempoMap(120) });
    const targets = targetNotesFromScore(score);
    const actual = [
      note(60, 0.02, { cents_offset: -20 }),
      note(64, 0.55, { cents_offset: 10 }),
      note(67, 1.08),
    ];
    const report = comparePerformance(targets, actual);
    expect(report.summary.matchedCount).toBe(3);
    expect(report.events.map((e) => e.timingErrorMs)).toEqual([20, 50, 80]);
    expect(report.summary.meanAbsTimingErrorMs).toBe(50);
  });
});
