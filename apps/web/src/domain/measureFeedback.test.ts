import { describe, expect, it } from 'vitest';
import type { NoteDto } from '../api/analyze';
import { comparePerformance, type TargetNote } from './comparePerformance';
import { buildMeasureFeedback } from './measureFeedback';
import { constantTempoMap } from './tempoMap';

const tempoMap = constantTempoMap(60); // 单元 = 0.25s

// 4 个目标音：第1小节 t=0、t=2，第2小节 t=4、t=6
function mkTargets(midis: Array<number | null> = [60, 62, 64, 65]): TargetNote[] {
  const starts = [
    { start: 0, measure: 1, idx: 1, midi: midis[0]! },
    { start: 2, measure: 1, idx: 2, midi: midis[1]! },
    { start: 4, measure: 2, idx: 1, midi: midis[2]! },
    { start: 6, measure: 2, idx: 2, midi: midis[3]! },
  ];
  return starts.map((s, i) => ({
    midi: s.midi,
    startSec: s.start,
    durationSec: 1,
    measure: s.measure,
    noteIndex: s.idx,
    globalIndex: i,
  }));
}

function mkNote(midi: number, onset: number, cents = 0): NoteDto {
  return {
    midi,
    cents_offset: cents,
    onset,
    duration: 0.5,
    velocity: 80,
    confidence: 0.9,
  };
}

const opts = { offsetSec: 0, tempoMap, measuresCount: 2 };

describe('buildMeasureFeedback - 视唱模式', () => {
  it('全对：每小节满分且给正向评语', () => {
    const report = comparePerformance(
      mkTargets(),
      [mkNote(60, 0), mkNote(62, 2), mkNote(64, 4), mkNote(65, 6)],
      { mode: 'sight_singing' },
    );
    const measures = buildMeasureFeedback(report, opts);
    expect(measures).toHaveLength(2);
    for (const m of measures) {
      expect(m.score).toBe(1);
      expect(m.matchedCount).toBe(2);
      expect(m.missingCount).toBe(0);
      expect(m.comments).toEqual(['本小节完成得很好，继续保持']);
    }
  });

  it('漏唱：完整度下降，给出漏唱评语', () => {
    const report = comparePerformance(
      mkTargets(),
      [mkNote(60, 0), mkNote(64, 4), mkNote(65, 6)],
      { mode: 'sight_singing' },
    );
    const [m1] = buildMeasureFeedback(report, opts);
    expect(m1!.missingCount).toBe(1);
    expect(m1!.comments).toContain('第 2 音漏唱');
    // pitch=1 timing=1 completeness=.5 → .45+.25+.15
    expect(m1!.score).toBeCloseTo(0.85, 3);
  });

  it('错音：给出唱成X应为Y，且该音仍保留配对', () => {
    const report = comparePerformance(
      mkTargets(),
      [mkNote(60, 0), mkNote(65, 2), mkNote(64, 4), mkNote(65, 6)],
      { mode: 'sight_singing' },
    );
    const [m1] = buildMeasureFeedback(report, opts);
    expect(m1!.matchedCount).toBe(2);
    expect(m1!.comments).toContain('第 2 音唱成 F4，应为 D4');
    expect(m1!.pitchAccuracy).toBe(0.5);
  });

  it('非错音但音分偏差较大：给出偏高/偏低音分', () => {
    const report = comparePerformance(
      mkTargets(),
      [mkNote(60, 0, 60), mkNote(62, 2), mkNote(64, 4), mkNote(65, 6)],
      { mode: 'sight_singing' },
    );
    const [m1] = buildMeasureFeedback(report, opts);
    expect(m1!.comments.some((c) => c.includes('偏高 60 音分'))).toBe(true);
  });

  it('抢拍/拖后超阈值：给出时间评语并计入节奏准确率', () => {
    const report = comparePerformance(
      mkTargets(),
      [mkNote(60, -0.15), mkNote(62, 2.15), mkNote(64, 4), mkNote(65, 6)],
      { mode: 'sight_singing' },
    );
    const [m1] = buildMeasureFeedback(report, opts);
    expect(m1!.comments).toContain('第 1 音抢拍 150ms');
    expect(m1!.comments).toContain('第 2 音拖后 150ms');
    expect(m1!.timingAccuracy).toBe(0);
  });

  it('低分小节追加放慢重练建议', () => {
    // 两音都漏且无多音 → m1 全 0
    const report = comparePerformance(
      mkTargets(),
      [mkNote(64, 4), mkNote(65, 6)],
      { mode: 'sight_singing' },
    );
    const [m1] = buildMeasureFeedback(report, opts);
    expect(m1!.score).toBe(0);
    expect(m1!.comments).toContain('建议放慢速度，单独重练本小节');
  });
});

describe('buildMeasureFeedback - 节奏模式', () => {
  it('只评时间：pitchAccuracy 恒为 null，评语用漏拍/拍号', () => {
    const targets = mkTargets();
    const report = comparePerformance(
      targets,
      [mkNote(60, 0), mkNote(60, 2), mkNote(60, 4)], // 漏第4个攻击
      { mode: 'rhythm' },
    );
    const [m1, m2] = buildMeasureFeedback(report, opts);
    expect(m1!.pitchAccuracy).toBeNull();
    expect(m2!.comments).toContain('第 2 拍漏拍');
    // m1 全对：timing=1 completeness=1 → 1
    expect(m1!.score).toBe(1);
    // m2: timing=1·.65 + completeness=.5·.35
    expect(m2!.score).toBeCloseTo(0.825, 3);
  });
});

describe('buildMeasureFeedback - 多音归属', () => {
  it('多出的音折算到对应小节并计数', () => {
    const report = comparePerformance(
      mkTargets(),
      [
        mkNote(60, 0),
        mkNote(72, 0.5), // m1 杂声
        mkNote(62, 2),
        mkNote(64, 4),
        mkNote(65, 6),
        mkNote(72, 4.6), // m2 杂声
      ],
      { mode: 'sight_singing' },
    );
    const [m1, m2] = buildMeasureFeedback(report, opts);
    expect(m1!.extraCount).toBe(1);
    expect(m2!.extraCount).toBe(1);
    expect(m1!.comments.some((c) => c.startsWith('多出 1'))).toBe(true);
  });

  it('考虑预备拍偏移：extra 时间按 offsetSec 折算小节', () => {
    const report = comparePerformance(
      mkTargets(),
      [
        mkNote(60, 2),
        mkNote(62, 4),
        mkNote(64, 6),
        mkNote(65, 8),
        mkNote(72, 6.5), // 折回 4.5s → 第2小节
      ],
      { mode: 'sight_singing', actualOffsetSec: 2 },
    );
    const shiftedOpts = { ...opts, offsetSec: 2 };
    const [, m2] = buildMeasureFeedback(report, shiftedOpts);
    expect(m2!.extraCount).toBe(1);
  });

  it('越界 onset 夹到首/末小节', () => {
    const report = comparePerformance(
      mkTargets(),
      [mkNote(60, 0), mkNote(62, 2), mkNote(64, 4), mkNote(65, 6), mkNote(72, -1)],
      { mode: 'sight_singing' },
    );
    const [m1] = buildMeasureFeedback(report, opts);
    expect(m1!.extraCount).toBe(1);
  });
});
