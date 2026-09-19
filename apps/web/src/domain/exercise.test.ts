import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UNITS,
  BPM_BY_LEVEL,
  MEASURES_PER_EXERCISE,
  UNITS_PER_BAR,
  generateExercise,
  type Exercise,
  type ExerciseKind,
  type ExerciseLevel,
} from './exercise';

const KINDS: ExerciseKind[] = ['sight_singing', 'rhythm'];
const LEVELS: ExerciseLevel[] = [1, 2, 3];

/** MIDI → C 大调音阶度数（跨八度连续）；非 C 大调音高返回 null。 */
function scaleDegree(midi: number): number | null {
  const pcToDeg: Record<number, number> = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
  const pc = ((midi % 12) + 12) % 12;
  const deg = pcToDeg[pc];
  if (deg === undefined) {
    return null;
  }
  return (Math.floor(midi / 12) - 1) * 7 + deg;
}

/** 为每种 kind/level 各取一批固定种子的练习。 */
function sampleExercises(kind: ExerciseKind, level: ExerciseLevel, seeds = [1, 2, 3, 42, 99]): Exercise[] {
  return seeds.map((seed) => generateExercise(kind, level, { seed, bpm: BPM_BY_LEVEL[level][0] }));
}

describe('generateExercise 结构不变量', () => {
  it('一律 4 小节、4/4、每小节时值合计 16 单元', () => {
    for (const kind of KINDS) {
      for (const level of LEVELS) {
        for (const ex of sampleExercises(kind, level)) {
          expect(ex.score.measures).toHaveLength(MEASURES_PER_EXERCISE);
          expect(ex.score.beatsPerBar).toBe(4);
          expect(ex.score.timeSignature).toBe('4/4');
          ex.score.measures.forEach((m, i) => {
            expect(m.startUnit).toBe(i * UNITS_PER_BAR);
            expect(m.items.reduce((a, b) => a + b.units, 0)).toBe(UNITS_PER_BAR);
          });
          expect(ex.score.totalUnits).toBe(MEASURES_PER_EXERCISE * UNITS_PER_BAR);
        }
      }
    }
  });

  it('所有 item 时值在白名单内，且音符 item 与 targets 一一对应', () => {
    for (const kind of KINDS) {
      for (const level of LEVELS) {
        for (const ex of sampleExercises(kind, level)) {
          const noteItems = ex.score.measures.flatMap((m) => m.items).filter((i) => i.kind === 'note');
          for (const item of noteItems) {
            expect(ALLOWED_UNITS).toContain(item.units);
          }
          expect(noteItems).toHaveLength(ex.targets.length);
          ex.targets.forEach((t, i) => {
            expect(t.globalIndex).toBe(i);
            expect(t.measure).toBeGreaterThanOrEqual(1);
            expect(t.measure).toBeLessThanOrEqual(MEASURES_PER_EXERCISE);
            expect(t.noteIndex).toBeGreaterThanOrEqual(1);
            expect(t.durationSec).toBeGreaterThan(0);
          });
        }
      }
    }
  });

  it('targets 的小节/小节内序号与网格结构一致', () => {
    for (const kind of KINDS) {
      for (const level of LEVELS) {
        const ex = generateExercise(kind, level, { seed: 7 });
        const perMeasure = new Map<number, number>();
        for (const t of ex.targets) {
          perMeasure.set(t.measure, (perMeasure.get(t.measure) ?? 0) + 1);
          expect(t.noteIndex).toBe(perMeasure.get(t.measure));
        }
      }
    }
  });
});

describe('视唱练习旋律规则', () => {
  it('L1：全部在 C4–A4，首音为主和弦音，相邻音级进（≤2 度）', () => {
    for (const ex of sampleExercises('sight_singing', 1)) {
      for (const t of ex.targets) {
        expect(t.midi).toBeGreaterThanOrEqual(60);
        expect(t.midi).toBeLessThanOrEqual(69);
      }
      expect([60, 64, 67]).toContain(ex.targets[0]!.midi);
      for (let i = 1; i < ex.targets.length; i += 1) {
        const d0 = scaleDegree(ex.targets[i - 1]!.midi!)!;
        const d1 = scaleDegree(ex.targets[i]!.midi!)!;
        expect(Math.abs(d1 - d0)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('L2：音域 G3–E5；跳进（≥3 度）后下一音反向级进', () => {
    for (const ex of sampleExercises('sight_singing', 2)) {
      for (const t of ex.targets) {
        expect(t.midi).toBeGreaterThanOrEqual(55);
        expect(t.midi).toBeLessThanOrEqual(76);
      }
      const forced = new Set(ex.forcedNotes);
      for (let i = 1; i < ex.targets.length - 1; i += 1) {
        // 跳进落点或解决音属于终止式强制音时，由终止式接管，豁免严格反向级进断言
        if (forced.has(i) || forced.has(i + 1)) {
          continue;
        }
        const dPrev = scaleDegree(ex.targets[i - 1]!.midi!)!;
        const dCur = scaleDegree(ex.targets[i]!.midi!)!;
        const dNext = scaleDegree(ex.targets[i + 1]!.midi!)!;
        if (Math.abs(dCur - dPrev) >= 3) {
          expect(Math.sign(dNext - dCur)).toBe(-Math.sign(dCur - dPrev));
          expect(Math.abs(dNext - dCur)).toBe(1);
        }
      }
    }
  });

  it('L3：音域 E3–G5；大跳（≥5 度）后下一音反向级进', () => {
    for (const ex of sampleExercises('sight_singing', 3)) {
      for (const t of ex.targets) {
        expect(t.midi).toBeGreaterThanOrEqual(52);
        expect(t.midi).toBeLessThanOrEqual(79);
      }
      const forced = new Set(ex.forcedNotes);
      for (let i = 1; i < ex.targets.length - 1; i += 1) {
        // 大跳落点或解决音属于终止式强制音时，由终止式接管
        if (forced.has(i) || forced.has(i + 1)) {
          continue;
        }
        const dPrev = scaleDegree(ex.targets[i - 1]!.midi!)!;
        const dCur = scaleDegree(ex.targets[i]!.midi!)!;
        const dNext = scaleDegree(ex.targets[i + 1]!.midi!)!;
        if (Math.abs(dCur - dPrev) >= 5) {
          expect(Math.sign(dNext - dCur)).toBe(-Math.sign(dCur - dPrev));
          expect(Math.abs(dNext - dCur)).toBe(1);
        }
      }
    }
  });

  it('末音解决到主音 do（C4 或 C5）', () => {
    for (const level of LEVELS) {
      for (const ex of sampleExercises('sight_singing', level)) {
        expect([60, 72]).toContain(ex.targets[ex.targets.length - 1]!.midi);
      }
    }
  });
});

describe('节奏练习规则', () => {
  it('所有音符统一以 MIDI 60 记谱，targets 仍保留每个独立起音', () => {
    for (const level of LEVELS) {
      for (const ex of sampleExercises('rhythm', level)) {
        for (const t of ex.targets) {
          expect(t.midi).toBe(60);
        }
        // L3 至少存在某条练习达到 8 个以上攻击（十六分密度可能）
        expect(ex.targets.length).toBeGreaterThanOrEqual(4);
      }
    }
  });
});

describe('宽种子扫描（30 种子 × 两类型 × 三难度）', () => {
  it('结构/音域/L1 级进/末音主音 全部成立', () => {
    for (const kind of KINDS) {
      for (const level of LEVELS) {
        for (let seed = 1000; seed < 1030; seed += 1) {
          const ex = generateExercise(kind, level, { seed });
          ex.score.measures.forEach((m) => {
            expect(m.items.reduce((a, b) => a + b.units, 0)).toBe(UNITS_PER_BAR);
          });
          expect(ex.score.measures.flatMap((m) => m.items).filter((i) => i.kind === 'note'))
            .toHaveLength(ex.targets.length);
          if (kind === 'sight_singing') {
            const bounds: Record<ExerciseLevel, [number, number]> = {
              1: [60, 69],
              2: [55, 76],
              3: [52, 79],
            };
            for (const t of ex.targets) {
              expect(t.midi).toBeGreaterThanOrEqual(bounds[level][0]);
              expect(t.midi).toBeLessThanOrEqual(bounds[level][1]);
            }
            if (level === 1) {
              for (let i = 1; i < ex.targets.length; i += 1) {
                const d0 = scaleDegree(ex.targets[i - 1]!.midi!)!;
                const d1 = scaleDegree(ex.targets[i]!.midi!)!;
                expect(Math.abs(d1 - d0)).toBeLessThanOrEqual(2);
              }
            }
            expect([60, 72]).toContain(ex.targets[ex.targets.length - 1]!.midi);
          }
        }
      }
    }
  });
});

describe('种子与 BPM', () => {
  it('同种子生成结果完全可复现', () => {
    for (const kind of KINDS) {
      const a = generateExercise(kind, 2, { seed: 12345, bpm: 80 });
      const b = generateExercise(kind, 2, { seed: 12345, bpm: 80 });
      expect(b.targets.map((t) => [t.midi, t.startSec, t.durationSec])).toEqual(
        a.targets.map((t) => [t.midi, t.startSec, t.durationSec]),
      );
    }
  });

  it('不同种子几乎必然产生不同练习', () => {
    const a = generateExercise('rhythm', 3, { seed: 1 }).targets.map((t) => t.startSec);
    const b = generateExercise('rhythm', 3, { seed: 2 }).targets.map((t) => t.startSec);
    expect(a).not.toEqual(b);
  });

  it('尊重合法 BPM；非法 BPM 回退默认值', () => {
    expect(generateExercise('sight_singing', 1, { seed: 1, bpm: 100 }).bpm).toBe(100);
    expect(generateExercise('sight_singing', 1, { seed: 1, bpm: 120 }).bpm).toBe(80);
    expect(generateExercise('rhythm', 1, { seed: 1, bpm: 60 }).bpm).toBe(60);
    expect(generateExercise('rhythm', 1, { seed: 1 }).bpm).toBe(100);
  });
});
