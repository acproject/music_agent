import { describe, expect, it } from 'vitest';
import type { TargetNote } from './comparePerformance';
import { ScoreFollower } from './scoreFollower';

// 实时帧契约（与 AudioCapture / Python StreamAudio 一致）：
// 16kHz 单声道，40ms 一帧，每帧一个 PitchFrame（voiced + 连续 MIDI + confidence）。
const HOP = 0.04;

interface SchedNote {
  start: number;
  dur: number;
  midi: number;
  conf?: number;
}

/** 以 40ms 网格把一整段时间线喂给 follower：音符区间发 voiced 帧，其余发无声帧。 */
function runTimeline(follower: ScoreFollower, notes: SchedNote[], end: number): void {
  const frames = Math.round(end / HOP);
  for (let k = 0; k < frames; k += 1) {
    const t = Math.round(k * HOP * 1000) / 1000;
    const hit = notes.find((n) => t + 1e-9 >= n.start && t < n.start + n.dur);
    if (hit) {
      follower.feed(t, hit.midi, true, hit.conf ?? 0.9);
    } else {
      follower.feed(t, 0, false, 0.1);
    }
  }
}

/** 每行 4 个四分音符定位（4/4，IOI 0.5s）。 */
function makeTargets(starts: number[], midis: Array<number | null>): TargetNote[] {
  return starts.map((startSec, idx) => {
    const mid = midis[idx] ?? null;
    return {
      midi: mid,
      startSec,
      durationSec: 0.5,
      measure: Math.floor(idx / 4) + 1,
      noteIndex: (idx % 4) + 1,
      globalIndex: idx,
    };
  });
}

// 四分音符取 0.6s（=15 个 40ms 帧，100BPM），保证起音都落在真实帧网格上，
// 避免把 ±20ms 的分块量化误差混进断言（真实系统同样有这一粒度）。
const BEATS = [0, 0.6, 1.2, 1.8];
const ARP = [60, 64, 67, 72];

/** 标准四分音符演唱：音长 0.4s，音符间 3 个无声帧（120ms ≥ 默认 restGap 90ms）。 */
function sungArpeggio(midis = ARP, offsets = [0, 0, 0, 0], durs = [0.4, 0.4, 0.4, 0.4]): SchedNote[] {
  return BEATS.map((b, i) => ({ start: Math.round((b + offsets[i]) * 1000) / 1000, dur: durs[i], midi: midis[i] }));
}

describe('ScoreFollower - 准点完美演唱', () => {
  it('四个目标音全部配对，零误差满分，小节定位保留', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets);
    runTimeline(f, sungArpeggio(), 2.6);
    const report = f.finish(2.6);

    expect(report.summary).toMatchObject({
      matchedCount: 4,
      missingCount: 0,
      extraCount: 0,
      wrongNoteCount: 0,
      pitchAccuracy: 1,
      timingAccuracy: 1,
      completeness: 1,
      overallScore: 1,
    });
    expect(report.events.map((e) => e.pitchErrorCents)).toEqual([0, 0, 0, 0]);
    expect(report.events.map((e) => e.timingErrorMs)).toEqual([0, 0, 0, 0]);
    expect(report.events.map((e) => e.measure)).toEqual([1, 1, 1, 1]);
    expect(report.events.map((e) => e.noteIndex)).toEqual([1, 2, 3, 4]);
  });

  it('开始前 status=waiting，唱到第一音后进入 following', () => {
    const targets = makeTargets([2.4, 3.0, 3.6, 4.2], ARP);
    const f = new ScoreFollower(targets);
    f.feed(0, 0, false, 0.1);
    expect(f.snapshot().status).toBe('waiting');
    expect(f.snapshot().progress).toBe(0);
    f.feed(2.2, 0, false, 0.1); // 距第一音 200ms，进入跟谱窗
    expect(f.snapshot().status).toBe('following');
  });
});

describe('ScoreFollower - 音准实时反馈', () => {
  it('发声中快照持续给出 live pitch 偏差，落定后与报告一致', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets);
    // 前 3 帧：起音确认（约 120ms）
    f.feed(0, 60.3, true, 0.9);
    f.feed(0.04, 60.3, true, 0.9);
    expect(f.snapshot().active).toBeNull(); // 还没确认
    f.feed(0.08, 60.3, true, 0.9);
    const snap = f.snapshot();
    expect(snap.active).not.toBeNull();
    expect(snap.active?.targetIndex).toBe(0);
    expect(snap.active?.pitchErrorCents).toBe(30);
    expect(snap.liveCentsError).toBe(30);
    f.feed(0.12, 60.3, true, 0.9);
    f.feed(0.16, 0, false, 0.1);
    f.feed(0.2, 0, false, 0.1);
    f.feed(0.24, 0, false, 0.1); // 120ms 无声 → 切音落定
    const report = f.finish(0.24);
    expect(report.events[0].pitchErrorCents).toBe(30);
  });

  it('目标 G4 唱成 F4：按位置锁定不错位，判错音', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets, { mode: 'instrument' });
    runTimeline(f, sungArpeggio([60, 64, 65, 72]), 2.6);
    const report = f.finish(2.6);
    expect(report.summary.matchedCount).toBe(4);
    expect(report.summary.wrongNoteCount).toBe(1);
    expect(report.events[2]).toMatchObject({
      targetPitch: 67,
      actualMidi: 65,
      pitchErrorCents: -200,
      wrongNote: true,
    });
  });
});

describe('ScoreFollower - 节奏偏差与漂移适应', () => {
  it('整体晚 160ms 仍逐音配对，原始节奏误差如实上报', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets);
    runTimeline(f, sungArpeggio(ARP, [0.16, 0.16, 0.16, 0.16]), 2.6);
    const report = f.finish(2.6);
    expect(report.summary.matchedCount).toBe(4);
    expect(report.events.map((e) => e.timingErrorMs)).toEqual([160, 160, 160, 160]);
    // 视唱节奏阈值 120ms：晚 160ms 不合格
    expect(report.summary.timingAccuracy).toBe(0);
  });

  it('渐慢（+40/+120/+240ms）时漂移窗口跟随，四音全中且误差不被抹掉', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets);
    runTimeline(f, sungArpeggio(ARP, [0, 0.04, 0.12, 0.24]), 2.6);
    const report = f.finish(2.6);
    expect(report.summary.matchedCount).toBe(4);
    expect(report.events.map((e) => e.timingErrorMs)).toEqual([0, 40, 120, 240]);
    // 漂移补偿被限幅：前三个音在 120ms 阈值内
    expect(report.summary.timingAccuracy).toBeCloseTo(0.75, 5);
  });

  it('整体提前 160ms 属于抢拍，仍逐音配对', () => {
    const targets = makeTargets([1.2, 1.8, 2.4, 3.0], ARP);
    const f = new ScoreFollower(targets);
    runTimeline(
      f,
      sungArpeggio(ARP, [-0.16, -0.16, -0.16, -0.16]).map((n) => ({ ...n, start: n.start + 1.2 })),
      3.6,
    );
    const report = f.finish(3.6);
    expect(report.summary.matchedCount).toBe(4);
    expect(report.events.every((e) => e.timingErrorMs === -160)).toBe(true);
  });

  it('预备拍偏移：目标轴整体后移 1s', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets, { targetOffsetSec: 1.0 });
    runTimeline(f, sungArpeggio(ARP, [1, 1, 1, 1]), 3.6);
    const report = f.finish(3.6);
    expect(report.summary.matchedCount).toBe(4);
    expect(report.events.every((e) => e.timingErrorMs === 0)).toBe(true);
  });
});

describe('ScoreFollower - 漏唱 / 多音 / 噪声', () => {
  it('漏唱第三个音：后续音照常对齐，漏唱进入 missing', () => {
    const targets = makeTargets(BEATS, ARP);
    const notes = [
      { start: 0, dur: 0.4, midi: 60 },
      { start: 0.6, dur: 0.4, midi: 64 },
      { start: 1.8, dur: 0.4, midi: 72 },
    ];
    const f = new ScoreFollower(targets);
    runTimeline(f, notes, 2.6);
    const report = f.finish(2.6);
    expect(report.summary.matchedCount).toBe(3);
    expect(report.summary.missingCount).toBe(1);
    expect(report.missing[0].midi).toBe(67);
    expect(report.events.map((e) => e.targetPitch)).toEqual([60, 64, 72]);
    expect(report.events.every((e) => e.timingErrorMs === 0)).toBe(true);
  });

  it('两音之间插入的短音配不上目标 → extra，不挤掉后续配对', () => {
    const targets = makeTargets(BEATS, ARP);
    const notes = [
      { start: 0, dur: 0.12, midi: 60 },
      { start: 0.24, dur: 0.12, midi: 62 }, // 距前后目标都超出对齐窗
      { start: 0.6, dur: 0.4, midi: 64 },
      { start: 1.2, dur: 0.4, midi: 67 },
      { start: 1.8, dur: 0.4, midi: 72 },
    ];
    const f = new ScoreFollower(targets);
    runTimeline(f, notes, 2.6);
    const report = f.finish(2.6);
    expect(report.summary.matchedCount).toBe(4);
    expect(report.summary.extraCount).toBe(1);
    expect(report.extra[0].midi).toBe(62);
    expect(report.events.every((e) => e.timingErrorMs === 0)).toBe(true);
  });

  it('不足 3 帧的短噪声在起音确认前丢弃，不算多唱', () => {
    const targets = makeTargets([2.4, 3.0, 3.6, 4.2], ARP);
    const notes = [
      { start: 0.32, dur: 0.06, midi: 70 }, // 只有 2 帧
      ...sungArpeggio(ARP, [2.4, 2.4, 2.4, 2.4]),
    ];
    const f = new ScoreFollower(targets);
    runTimeline(f, notes, 4.8);
    const report = f.finish(4.8);
    expect(report.summary.extraCount).toBe(0);
    expect(report.summary.matchedCount).toBe(4);
  });

  it('低置信度 voiced 帧按门限忽略', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets, { minConfidence: 0.7 });
    const quiet = BEATS.map((b) => ({ start: b, dur: 0.4, midi: 60, conf: 0.4 }));
    runTimeline(f, quiet, 2.6);
    const report = f.finish(2.6);
    expect(report.summary.matchedCount).toBe(0);
    expect(report.summary.missingCount).toBe(4);
  });
});

describe('ScoreFollower - 连奏与切分', () => {
  // dur 0.6：相邻音首尾相接、中间无无声帧，只能靠音高跳变识别新音
  it('无换气连唱四个不同音：音高跳变稳定 3 帧后切开，四音全中', () => {
    const targets = makeTargets(BEATS, ARP);
    const notes = BEATS.map((b, i) => ({ start: b, dur: 0.6, midi: ARP[i] }));
    const f = new ScoreFollower(targets);
    runTimeline(f, notes, 2.5);
    const report = f.finish(2.5);
    expect(report.summary.matchedCount).toBe(4);
    expect(report.events.map((e) => e.targetPitch)).toEqual(ARP);
  });
});

describe('ScoreFollower - 节奏训练模式', () => {
  it('拍手音高被检测器标成任意值也不参评，只按时间给分', () => {
    const targets = makeTargets(BEATS, [null, null, null, null]);
    const notes = [
      { start: 0, dur: 0.12, midi: 49 },
      { start: 0.6, dur: 0.12, midi: 72 },
      { start: 1.2, dur: 0.12, midi: 60 },
      { start: 1.8, dur: 0.12, midi: 55 },
    ];
    const f = new ScoreFollower(targets, { mode: 'rhythm' });
    runTimeline(f, notes, 2.2);
    const report = f.finish(2.2);
    expect(report.summary.matchedCount).toBe(4);
    expect(report.events.every((e) => e.pitchEvaluated === false)).toBe(true);
    expect(report.summary.wrongNoteCount).toBeNull();
    expect(report.summary.pitchAccuracy).toBeNull();
    expect(report.summary.timingAccuracy).toBe(1);
    expect(report.summary.overallScore).toBe(1);
  });
});

describe('ScoreFollower - 边界与总结', () => {
  it('全程静音结束：全部漏唱，综合分 0，无 NaN', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets);
    runTimeline(f, [], 2.4);
    const report = f.finish(2.4);
    expect(report.summary.matchedCount).toBe(0);
    expect(report.summary.missingCount).toBe(4);
    expect(report.summary.completeness).toBe(0);
    expect(report.summary.overallScore).toBe(0);
    expect(f.snapshot().status).toBe('finished');
  });

  it('finish 幂等，重复调用返回同一份报告', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets);
    runTimeline(f, sungArpeggio(), 2.2);
    expect(f.finish(2.2)).toBe(f.finish(9.9));
  });

  it('tick 在无音频帧时也能推进漏唱判定', () => {
    const targets = makeTargets(BEATS, ARP);
    const f = new ScoreFollower(targets);
    f.tick(3.0);
    const snap = f.snapshot();
    expect(snap.missing).toHaveLength(4);
    expect(snap.progress).toBe(1);
    expect(snap.status).toBe('following');
  });
});
